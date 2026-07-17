# VLP-16 bench bring-up runbook

Fast path to get a Velodyne VLP-16 streaming into a socket on a fresh host. Written after a
multi-hour bring-up on 2026-07-17 that should have taken ten minutes — the failures that ate that
time are captured in `docs/issues/2026_07_17_*` and cross-referenced below.

> **Scope.** The **Windows** path was *executed* on the 2026-07-17 bring-up (unit #1); the **Linux**
> path (§6) was *executed* on the unit #2 bring-up the same day. Both are from observed runs, not
> guesswork. The signature host-side drop differs by OS: Windows firewall Public profile (§1) vs.
> Linux `rp_filter` (§6.1).

**Golden rule:** work the diagnosis in layers from the wire up, and **never trust a zero-packet
capture without first confirming the sensor is live** (`status.json` motor `On` + NIC RX climbing).
Most of the lost time came from reading confounded zero-packet results.

---

## 0. Facts about the sensor

- Factory IP: **`192.168.1.201/24`**, DHCP off. Web UI: `http://192.168.1.201`.
- Data packets: **UDP `2368`**, 1206-byte payload, ~**755 pps** (single return) / ~1508 pps (dual).
- Position/telemetry packets: **UDP `8308`**.
- Default data destination: **`255.255.255.255`** (limited broadcast). Reconfigurable, but the
  setting **does not persist across a power cycle** (see `docs/issues/2026_07_17_vlp16_host_dest_not_persisted.md`).
- Web API (no auth): `GET /cgi/info.json | status.json | settings.json | diag.json`,
  `POST /cgi/setting`, `/cgi/setting/host`, `/cgi/setting/net`.

---

## 1. Host network setup

Give the sensor NIC a static IP on the Puck's subnet:

- **IP:** `192.168.1.10` · **Mask:** `255.255.255.0` · **Gateway:** `192.168.1.1` (nominal)

Set it in Adapter Settings (or `New-NetIPAddress`). Then — **this is the step everyone misses** —
mark the link **Private** and add firewall allow rules. On the default **Public** profile Windows
**silently drops** the inbound UDP even with an allow rule
(`docs/issues/2026_07_17_windows_firewall_public_profile_drops_vlp16_udp.md`):

```powershell
New-NetFirewallRule -DisplayName 'VLP-16 data'     -Direction Inbound -Protocol UDP -LocalPort 2368 -Action Allow -Profile Any
New-NetFirewallRule -DisplayName 'VLP-16 position' -Direction Inbound -Protocol UDP -LocalPort 8308 -Action Allow -Profile Any
Set-NetConnectionProfile -InterfaceAlias 'Ethernet' -NetworkCategory Private
```

> Re-run `Set-NetConnectionProfile -Private` after swapping a different sensor into the same port
> (Windows may re-flag the network Public). To make it permanent: Local Security Policy → Network
> List Manager Policies → Unidentified Networks → Location = Private.

> **WSL2 caveat:** the default NAT mode cannot see the sensor subnet at all
> (`docs/issues/2026_07_17_wsl2_nat_isolates_lidar_subnet.md`). Drive the sensor via `powershell.exe`
> from Windows, or enable `networkingMode=mirrored` in `.wslconfig`.

(Linux host setup → §6, to be written from the unit #2 bring-up.)

---

## 2. Verification ladder (stop at the first failure)

Climb from the wire up. Each rung tells you which layer is broken. (Windows commands; the sensor-side
web API in rungs 2–3 is platform-independent.)

| # | Check | Windows | Pass = |
|---|-------|---------|--------|
| 1 | **Link/L3** | `ping 192.168.1.201` | replies, TTL 64 |
| 2 | **Sensor alive + spinning** | `Invoke-RestMethod http://192.168.1.201/cgi/status.json` | `motor.state=On`, `rpm≈600`, `laser.state=On` |
| 3 | **Health rails** | `.../cgi/diag.json` | rails non-zero, temps sane (all-zero = fault → §4) |
| 4 | **Packets at the NIC** | `Get-NetAdapterStatistics -Name Ethernet` (sample twice) | RX climbing ~750+/s |
| 5 | **Packets in a socket** | socket bind `0.0.0.0:2368` (snippet below) | count > 0, payload 1206 B |

**Rung 4 passes but rung 5 fails → host firewall/profile.** That is the signature failure from this
session — on Windows, the Public profile / missing rule (§1).

Windows one-shot socket sniff:
```powershell
$u = New-Object System.Net.Sockets.UdpClient
$u.Client.SetSocketOption('Socket','ReuseAddress',$true)
$u.Client.Bind((New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any,2368)))
$u.Client.ReceiveTimeout = 3000
$ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any,0)
$n=0;$size=0;$sw=[Diagnostics.Stopwatch]::StartNew()
try { while($sw.ElapsedMilliseconds -lt 1000){ $d=$u.Receive([ref]$ep);$n++;$size=$d.Length } } catch {}
$u.Close(); "packets=$n payload=$size bytes (1206 = VLP-16 data)"
```

---

## 3. Certified-good reference

A healthy unit produces (firewall on, rules + Private profile in place):
```
motor: On @ 600 rpm, laser: On
packets=757  payload=1206 bytes  src=192.168.1.201  ~755 pps
```

---

## 4. Failure-mode index

| Symptom | Cause | Doc |
|---------|-------|-----|
| Rung 4 OK, rung 5 = 0 packets (Windows) | Public profile drops inbound UDP despite allow rule | `issues/2026_07_17_windows_firewall_public_profile_drops_vlp16_udp.md` |
| Rung 4 OK, rung 5 = 0 packets (Linux) | `rp_filter` (even loose mode 2) drops the `255.255.255.255` broadcast before the socket | `issues/2026_07_17_linux_rp_filter_drops_vlp16_broadcast.md` |
| Intermittent 0-packet runs + "activation of network failed" popups (Linux) | NetworkManager DHCP-flushing the manual IP on `eno1` | `vlp16-bench-bringup.md` §6.1 (static NM profile) |
| Sensor unreachable from WSL2, fine from Windows | WSL2 NAT isolates the subnet | `issues/2026_07_17_wsl2_nat_isolates_lidar_subnet.md` |
| `motor: Disabled`, `diag.json` all zeros, RX→0 | Protective shutdown (power sag / thermal) | `issues/2026_07_17_vlp16_protective_shutdown_confounds_capture.md` |
| Configured unicast dest reverts to broadcast after reboot | `host.addr` not persisted | `issues/2026_07_17_vlp16_host_dest_not_persisted.md` |

### Deep drop analysis (last resort)
If a packet reaches the NIC but nothing consumes it and you can't tell why, capture WFP drops on
Windows — it names the exact dropping filter and provider:
```powershell
netsh wfp capture start file=C:\vlp-diag\wfp.cab   # (elevated)
Start-Sleep 5
netsh wfp capture stop
# extract wfp.xml from the cab; grep CLASSIFY_DROP events for remoteAddrV4=192.168.1.201 → <filterId> → look it up
```
This is what finally identified the Windows `Port Scanning Prevention Filter` (`MPSSVC`) as the
dropper and cleared NordVPN of suspicion.

---

## 5. What ate the time on 2026-07-17 (so you don't repeat it)

1. **Chased NordVPN for ~an hour** — a WFP capture proved the dropper was Windows' own firewall, not
   Nord. Don't assume a VPN; capture and read the filter name.
2. **"Ruled out" the firewall with a confounded test** — the firewall-off test returned 0 because the
   sensor had *also* faulted at that moment. Always gate a negative capture on a live-source check.
3. **"Ruled out" unicast on a stream that had reverted to broadcast** — verify the stream (NIC RX
   split) actually reflects a config change before drawing conclusions.

The real fix was two lines (Private profile + allow rule). The verification ladder in §2 reaches it
in minutes.

---

## 6. Linux host path

Written from the **unit #2** bring-up on 2026-07-17 (Ubuntu, kernel 6.17, NIC `eno1`). Everything
here was executed and observed on that host. **The signature failure is different from Windows: on
Linux the host firewall was wide open and irrelevant — the silent drop was the kernel's
`rp_filter`** (`docs/issues/2026_07_17_linux_rp_filter_drops_vlp16_broadcast.md`).

### 6.1 Host network setup

Two things must be true: the NIC has a static IP on the Puck's subnet, **and** it is managed so
nothing flushes that IP mid-session.

- **IP:** `192.168.1.100` · **Mask:** `255.255.255.0` · no gateway needed (point-to-point sensor link).

Quick-and-dirty (does not survive NetworkManager or a replug):
```bash
sudo ip addr add 192.168.1.100/24 dev eno1
sudo ip link set eno1 up
```

**Durable + stops the popups (do this).** Left alone, NetworkManager repeatedly tries to DHCP the
sensor NIC, throws *"activation of network failed"* popups, and **flushes the manual IP mid-capture**
— which shows up as intermittent zero-packet runs. Give it a static profile instead:
```bash
sudo nmcli con add type ethernet ifname eno1 con-name velodyne-vlp16 \
  ipv4.method manual ipv4.addresses 192.168.1.100/24 ipv4.never-default yes ipv6.method disabled
sudo nmcli con up velodyne-vlp16
```
`never-default yes` keeps your Wi-Fi/primary NIC as the default route. Tear down later with
`nmcli con down velodyne-vlp16`.

**The step that actually unlocks reception — disable `rp_filter`.** The Puck broadcasts to
`255.255.255.255`; reverse-path filtering (even *loose* mode `2`, the observed default) drops the
limited-broadcast frames at the IP layer, so `tcpdump` sees them but a bound socket gets **zero**.
Persist it:
```bash
sudo tee /etc/sysctl.d/99-velodyne-lidar.conf >/dev/null <<'EOF'
net.ipv4.conf.all.rp_filter = 0
net.ipv4.conf.default.rp_filter = 0
EOF
sudo sysctl --system
sysctl -n net.ipv4.conf.eno1.rp_filter   # must print 0 (effective = max(all, iface))
```

Host firewall on this box needed **no changes** (`ufw` inactive, `iptables -S INPUT` = `ACCEPT`,
`nft` had only Docker rules). Verify yours is similarly clear rather than assuming — if `ufw`/`nft`
is active, add allow rules for `UDP/2368` and `UDP/8308` inbound.

### 6.2 Verification ladder (Linux)

Same layered climb as §2; stop at the first failure. Rungs 2–3 hit the sensor's platform-independent
web API.

| # | Check | Linux | Pass = |
|---|-------|-------|--------|
| 1 | **Link/L3** | `cat /sys/class/net/eno1/carrier` (1 = cable up); `ping 192.168.1.201` | carrier 1, link `100 Mbps`, ping replies (unit #2 answered ICMP) |
| 2 | **Sensor alive + spinning** | `curl -s http://192.168.1.201/cgi/status.json` | `motor.state=On`, `rpm≈600`, `laser.state=On` |
| 3 | **Health rails** | `curl -s http://192.168.1.201/cgi/diag.json` | rails non-zero, temps sane (all-zero = fault) |
| 4 | **Packets at the NIC** | `sudo tcpdump -ni eno1 udp port 2368 -c 5` | 1206-byte frames from `192.168.1.201`, `0 dropped by kernel` |
| 5 | **Packets in a socket** | bind `0.0.0.0:2368` (snippet below) | count > 0, payload 1206 B |

**Rung 4 passes but rung 5 fails → `rp_filter` (§6.1), not the firewall.** That was the signature
failure on this host: `tcpdump` saw the stream, the socket saw `0`, and one `rp_filter=0` flipped the
same socket to `2261 packets in 3s`.

Linux one-shot socket sniff (pure stdlib — note the `0.0.0.0` bind; binding the host's own
`192.168.1.100` receives **nothing** for a `255.255.255.255` broadcast):
```bash
python3 - <<'PY'
import socket, time
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", 2368)); s.settimeout(3)
n = 0; t = time.time()
try:
    while time.time() - t < 3:
        d, a = s.recvfrom(2048); n += 1
        if n == 1: print("first pkt from", a, "len", len(d))
except socket.timeout: pass
print("received", n, "packets in 3s")
PY
```

### 6.3 Certified-good reference (Linux)

A healthy unit on this host (`rp_filter=0`, firewall untouched, static NM profile) produces:
```
VLP-16 Strongest | data 753 pkt/s | pos ~135 pkt/s | ~600 rpm | range 0.5-1.0 m | src 192.168.1.201
```
`~753 pps` single-return matches the §0 spec; `~600 rpm` is the Puck default.
