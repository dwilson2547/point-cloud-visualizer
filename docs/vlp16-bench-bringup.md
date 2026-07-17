# VLP-16 bench bring-up runbook

Fast path to get a Velodyne VLP-16 streaming into a socket on a fresh host. Written after a
multi-hour bring-up on 2026-07-17 that should have taken ten minutes — the failures that ate that
time are captured in `docs/issues/2026_07_17_*` and cross-referenced below.

> **Scope.** Everything below is the **Windows** path and was *executed* on the 2026-07-17 bring-up
> (unit #1). The **Linux** path (§6) is a stub — it will be written from the actual unit #2 Linux
> bring-up, not from guesswork.

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

_To be written from the unit #2 Linux bring-up (in progress). Capture the actual commands and
observed behavior — static IP method (netplan/NetworkManager/`ip`), whether any firewall
(`ufw`/`firewalld`/`nftables`) had to be touched, `rp_filter` behavior, broadcast vs. unicast
reception, and the working socket/`tcpdump` verification — and replace this stub. Do not
pre-populate with assumptions._
