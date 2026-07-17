# VLP-16 Lite — getting started (Windows + Linux)

The front door for going from an unboxed **Velodyne VLP-16 Lite** to a live 1206-byte UDP stream in
a socket, and from there into the point-cloud-visualizer client. This is the linear happy path.
When a step fails, don't improvise — jump to the diagnostic ladder and failure-mode index in
[`vlp16-bench-bringup.md`](./vlp16-bench-bringup.md).

> **Scope.** Every step here was executed on real hardware on 2026-07-17 — the **Windows** path on
> unit #1 and the **Linux** path on unit #2 (`model: VLP-16Lite-A`). Nothing is extrapolated. The
> VLP-32 is deliberately not covered; it has not been bench-verified against this project.

The VLP-16 is the intended first bring-up target for the visualizer: low channel count, easy to
dedicate to the ingest/chunking/viewer pipeline, and enough to prove the whole path. Odometry is
**not** this guide's concern — the client sends an identity pose in v1; Point-LIO (or similar) on
the client is a later step (see [`vlp16-client.md`](./vlp16-client.md)).

---

## 1. What you need

- **VLP-16 Lite** + its **interface box** + a **12 V** supply for the box.
- A host with a **dedicated wired NIC** for the sensor.
- Sensor facts (defaults, same across units):
  - Factory IP **`192.168.1.201/24`**, DHCP off. Web UI: `http://192.168.1.201`.
  - Data: **UDP `2368`**, 1206-byte payload, ~**755 pps** single-return.
  - Position/telemetry: **UDP `8308`**.
  - Default data destination: **`255.255.255.255`** (limited broadcast). This guide uses the
    broadcast default — it works out of the box and a reconfigured unicast destination does **not**
    persist across a power cycle (`issues/2026_07_17_vlp16_host_dest_not_persisted.md`).

---

## 2. Connect the hardware

1. Wire the **interface box**: 12 V power in, the sensor's round cable to the box, and an **RJ45
   from the box to your host NIC**. Ethernet alone will *not* power the sensor — the box supplies
   both power and data.
2. Confirm the link (also your first proof the sensor is powered — the Puck negotiates a fixed
   **100 Mbps**):
   - **Windows:** `Get-NetAdapter -Name Ethernet` → `Up`, `100 Mbps`.
   - **Linux:** `cat /sys/class/net/eno1/carrier` → `1`; `cat /sys/class/net/eno1/speed` → `100`.

---

## 3. Host network setup

Put the sensor NIC on the Puck's subnet with a **static IP** (no gateway needed — it's a
point-to-point link). Then apply the **one OS-specific unlock** that actually lets the datagrams
reach a socket. This is the step that eats hours if skipped.

### Windows

Static IP (e.g. `192.168.1.10/24`), then — the part everyone misses — allow the ports **and mark
the link Private**. On the default **Public** profile Windows silently drops the inbound UDP even
with an allow rule (`issues/2026_07_17_windows_firewall_public_profile_drops_vlp16_udp.md`):

```powershell
New-NetFirewallRule -DisplayName 'VLP-16 data'     -Direction Inbound -Protocol UDP -LocalPort 2368 -Action Allow -Profile Any
New-NetFirewallRule -DisplayName 'VLP-16 position' -Direction Inbound -Protocol UDP -LocalPort 8308 -Action Allow -Profile Any
Set-NetConnectionProfile -InterfaceAlias 'Ethernet' -NetworkCategory Private
```

### Linux

Static IP via a **NetworkManager profile** (durable, and it stops the *"activation of network
failed"* popups + the DHCP flushes that cause intermittent zero-packet runs):

```bash
sudo nmcli con add type ethernet ifname eno1 con-name velodyne-vlp16 \
  ipv4.method manual ipv4.addresses 192.168.1.100/24 ipv4.never-default yes ipv6.method disabled
sudo nmcli con up velodyne-vlp16
```

Then the unlock — **disable `rp_filter`**. The Puck broadcasts to `255.255.255.255`; reverse-path
filtering (even loose mode `2`) drops those frames before a socket sees them — `tcpdump` shows the
stream, the socket gets zero (`issues/2026_07_17_linux_rp_filter_drops_vlp16_broadcast.md`):

```bash
sudo tee /etc/sysctl.d/99-velodyne-lidar.conf >/dev/null <<'EOF'
net.ipv4.conf.all.rp_filter = 0
net.ipv4.conf.default.rp_filter = 0
EOF
sudo sysctl --system
sysctl -n net.ipv4.conf.eno1.rp_filter   # must print 0
```

Host firewall on the test box needed no changes (`ufw` inactive, `iptables INPUT ACCEPT`). If yours
runs an active `ufw`/`firewalld`/`nftables`, add inbound allow rules for `UDP/2368` and `UDP/8308`.

---

## 4. Confirm the sensor is streaming

Two checks, in order — **never trust a zero-packet capture without first confirming the sensor is
live.**

1. **Sensor alive** (platform-independent web API):
   ```
   curl -s http://192.168.1.201/cgi/status.json           # Linux
   Invoke-RestMethod http://192.168.1.201/cgi/status.json # Windows
   ```
   Expect `motor.state=On`, `rpm≈600`, `laser.state=On`.
2. **Packets in a socket** — bind **`0.0.0.0:2368`** (binding the host's own unicast IP receives
   nothing for a broadcast stream). Ready-to-run one-shot sniffers are in `vlp16-bench-bringup.md`
   §2 (Windows) and §6.2 (Linux).

Certified-good reference (either OS): `VLP-16 Strongest | ~753 pps | 1206 B | ~600 rpm | src 192.168.1.201`.

---

## 5. Stream into the visualizer

Once packets land in a socket, hand the same stream to the VLP-16 client, which decodes it into
`xyz_rgb_i_v1` batches and publishes them to the server over WebSocket (full detail:
[`vlp16-client.md`](./vlp16-client.md)):

```bash
npm run client:vlp16 -- \
  --calibration-file ./vlp16-calibration.json \
  --session-id vlp16-room-a-001 \
  --publisher-id vlp16-main \
  --server-url ws://localhost:8080/ws/ingest
```

The client listens on `0.0.0.0:2368` (the broadcast default), uses a 16-laser calibration JSON, and
sends an identity pose for v1 — correct for a **stationary bench** sensor. A moving rig replaces the
identity pose with client-side odometry later.

---

## 6. When it doesn't work

Work the diagnosis in layers from the wire up, and confirm the source is live before believing any
zero. The full ladder, certified-good baselines, and failure-mode index live in
[`vlp16-bench-bringup.md`](./vlp16-bench-bringup.md). The signature host-side drops:

| Symptom | Cause | Where |
|---|---|---|
| NIC sees frames, socket gets 0 (Windows) | Public profile drops inbound UDP despite allow rule | `issues/2026_07_17_windows_firewall_public_profile_drops_vlp16_udp.md` |
| NIC sees frames, socket gets 0 (Linux) | `rp_filter` drops the `255.255.255.255` broadcast | `issues/2026_07_17_linux_rp_filter_drops_vlp16_broadcast.md` |
| Sensor unreachable from WSL2, fine from the Windows host | WSL2 NAT isolates the sensor subnet | `issues/2026_07_17_wsl2_nat_isolates_lidar_subnet.md` |
| `motor: Disabled`, `diag.json` all zeros | Protective shutdown (power sag / thermal) | `issues/2026_07_17_vlp16_protective_shutdown_confounds_capture.md` |

> **Developing in WSL2:** you cannot receive live sensor UDP in default NAT mode. Either enable
> `networkingMode=mirrored` in `.wslconfig`, or (simpler for a dev box) work against **captured
> pcap replay** rather than the live sensor.
