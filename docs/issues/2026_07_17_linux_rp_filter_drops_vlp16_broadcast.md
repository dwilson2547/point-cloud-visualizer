# Linux reverse-path filtering (`rp_filter`) silently drops the VLP-16 limited-broadcast UDP, so the receiving socket gets zero packets even though the data reaches the NIC

**Date:** 2026-07-17
**Component:** Host kernel network configuration (`net.ipv4.conf.*.rp_filter`) — not a repo file. Affects any consumer binding `UDP/2368` on a Linux sensor host, including the point-cloud-visualizer VLP-16 client (`docs/vlp16-client.md`).
**Severity:** High — total loss of sensor data reception with no error surfaced. Same silent-drop signature as the Windows firewall issue (`2026_07_17_windows_firewall_public_profile_drops_vlp16_udp.md`), different layer.

This is the **Linux unit #2** counterpart to the Windows firewall drop. The symptom is identical (NIC sees the frames, socket sees nothing); the cause and fix are different. Verified end-to-end on the 2026-07-17 Linux bring-up — every number below was observed on this host, not carried over from the Windows write-up.

---

## Observed symptom

- A UDP socket bound to `0.0.0.0:2368` received **0 packets** over repeated 3-second windows.
- Simultaneously, `tcpdump -ni eno1` showed a continuous stream of **1206-byte** UDP frames from `192.168.1.201:2368` to `255.255.255.255:2368` (plus 512-byte position packets on `8308`): `30 packets captured, 84 received by filter, 0 dropped by kernel`. The data was physically present and accepted by the NIC.
- **Decisive test:** with `net.ipv4.conf.{all,default,eno1}.rp_filter=0`, the *same* socket immediately received **2261 packets in 3s** (`first pkt from ('192.168.1.201', 2368) len 1206`). No other change was made. Restoring `rp_filter` returned it to zero.
- Host firewall was **ruled out, not assumed**: `ufw` inactive, `iptables -S INPUT` policy `ACCEPT`, `nft list ruleset` contained only Docker's forward-chain rules — nothing touching the INPUT path for `UDP/2368`.

---

## Root cause

### Reverse-path filtering discards the limited-broadcast frame before the socket

The Puck's default data destination is the limited broadcast address `255.255.255.255`. Linux reverse-path filtering (`rp_filter`) validates inbound packets against the routing table and drops the limited-broadcast frames at the IP layer, *before* any bound socket can consume them — which is why `tcpdump` (an `AF_PACKET` tap ahead of that check) still saw every frame while the `AF_INET` socket saw none.

Notably this reproduced with `rp_filter=2` (**loose** mode), not just strict mode: the default on this host was `2` on `all`/`default`/`eno1`, and it still dropped the broadcast. Setting the value to `0` was the only thing that let the socket receive.

### Corollary: the socket must bind `0.0.0.0`, not the host's unicast IP

A socket bound to the interface's unicast address (`192.168.1.100`) does **not** receive datagrams addressed to `255.255.255.255`; binding `INADDR_ANY` (`0.0.0.0`) is required for limited-broadcast reception. (An early attempt to bind `192.168.1.100` also failed outright with `Errno 99 Cannot assign requested address` — see the NetworkManager confound below.)

---

## Troubleshooting steps taken

1. **Confirmed data on the wire** — `tcpdump -ni eno1 udp` showed ~continuous 1206-byte frames from `192.168.1.201` and `0 dropped by kernel`; ruled out cabling, power, and sensor output. Link negotiated at **100 Mbps** (the Puck's fixed rate), confirming the sensor was powered.
2. **Ruled out the host firewall** — `ufw status` = inactive, `iptables -S INPUT` = `-P INPUT ACCEPT`, `nft list ruleset` = only Docker forward/nat rules. No INPUT-layer block existed, so the Windows-style firewall cause did **not** apply here.
3. **Ruled out a competing listener as the *cause*** — a stale earlier listener was found bound to `2368`/`8308` (`ss -lunp`) and killed, but the raw-socket test used `SO_REUSEADDR` and still returned 0 while `rp_filter` was on, so contention was not the blocker.
4. **Isolated to `rp_filter` (decisive)** — one `sysctl -w …rp_filter=0` flipped the identical socket test from `0` to `2261 packets in 3s`. Single-variable change, reversible, reproducible.
5. **Controlled for a NetworkManager confound** — earlier intermittent zero-packet runs (and "activation of network failed" desktop popups) were NetworkManager repeatedly trying to DHCP the sensor NIC and flushing the manually-added `ip addr`. Replaced with a static NM profile so the IP stops disappearing mid-test (see fix + `docs/vlp16-bench-bringup.md` §6).

---

## Fix

### Kernel — disable reverse-path filtering (persisted)

`/etc/sysctl.d/99-velodyne-lidar.conf`:
```ini
# Velodyne VLP-16 broadcasts data to 255.255.255.255; reverse-path filtering
# drops the limited-broadcast frames before they reach the UDP socket.
net.ipv4.conf.all.rp_filter = 0
net.ipv4.conf.default.rp_filter = 0
```
Apply with `sudo sysctl --system`. The effective value is `max(all, <iface>)`, so `all=0` is required — setting only the interface leaves it clamped by `all`. Verify: `sysctl -n net.ipv4.conf.eno1.rp_filter` → `0`.

### Application — bind `0.0.0.0`, not the unicast host IP

The VLP-16 client must bind `INADDR_ANY:2368` (and `:8308`) to receive the `255.255.255.255` broadcast. Binding the host's own `192.168.1.x` will silently receive nothing.

---

## Certified-good reference (this host)

```
VLP-16 Strongest | data 753 pkt/s | pos ~135 pkt/s | ~600 rpm | range 0.5-1.0 m | src 192.168.1.201
```
(`rp_filter=0`, firewall untouched, static NM profile on `eno1`.)

---

## Files changed

- Host kernel/network configuration only: `/etc/sysctl.d/99-velodyne-lidar.conf` and a static NetworkManager profile `velodyne-vlp16` (no repo source files changed).
- `docs/vlp16-bench-bringup.md` §6 — Linux host path written from this bring-up.
- `docs/issues/2026_07_17_linux_rp_filter_drops_vlp16_broadcast.md` — this document.
