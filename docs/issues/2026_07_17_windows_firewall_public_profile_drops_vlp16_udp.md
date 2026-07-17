# Windows Firewall silently drops inbound VLP-16 UDP on the Public network profile, so the receiving socket gets zero packets even though the data reaches the NIC

**Date:** 2026-07-17
**Component:** Host network configuration (Windows Defender Firewall / `Get-NetConnectionProfile` network category) — not a repo file. Affects any consumer binding `UDP/2368` on the sensor host, including the point-cloud-visualizer VLP-16 client (`docs/vlp16-client.md`).
**Severity:** High — total loss of sensor data reception with no error surfaced; cost several hours of misdiagnosis because the failure is completely silent.

---

## Observed symptom

- A UDP socket bound to `0.0.0.0:2368` received **0 packets** over repeated 4-second windows.
- Simultaneously, the NIC RX counter (`Get-NetAdapterStatistics`) showed **~910 packets/sec arriving** on the sensor interface — the data was physically present on the wire and accepted by the NIC.
- A WFP packet-drop capture (`netsh wfp capture`) showed every Puck packet (from `192.168.1.201`, both `2368` data and `8308` position) dropped by a **single filter, id `159320`**:
  - name: `Port Scanning Prevention Filter`
  - provider: `FWPM_PROVIDER_MPSSVC_WF` (Windows Defender Firewall service — **not** a third-party/VPN filter)
  - layer: `FWPM_LAYER_INBOUND_TRANSPORT_V4_DISCARD`, action: silent drop
  - description (verbatim): *"This filter prevents port scanning. This many times means there are no listeners. If debugging ensure your scenario has one."*
- **Decisive test:** with `netsh advfirewall set allprofiles state off`, the socket immediately received **624 packets while 775 arrived at the NIC** (~80% capture in a 0.8s window). Turning the firewall back on returned it to 0.
- Adding an inbound allow rule for `UDP/2368` **did not help** while the interface stayed on the **Public** profile. Flipping the interface to **Private** (rule + firewall still on) restored reception: **613 packets** received, then a clean certification run of **757 packets @ 1206 bytes @ ~755 pps**.

---

## Root cause

### The direct sensor link is classified as an "unidentified" network → Public profile

A point-to-point link to the sensor has no gateway/internet and shows `IPv4Connectivity: NoTraffic`. Windows tags such links as **unidentified**, which are placed in the **Public** firewall profile — the strictest one.

### Windows Firewall discards unsolicited inbound UDP before it reaches the socket

On the Public profile, the default inbound action is Block. The packet is dropped at the transport layer *before* any socket can consume it, so it falls through to `FWPM_LAYER_INBOUND_TRANSPORT_V4_DISCARD`, where the built-in **Port Scanning Prevention Filter** silently drops it. Its "no listeners" wording is misleading here — a socket *was* bound; the firewall simply never let the datagram reach it.

Critically, a plain inbound allow rule (`New-NetFirewallRule -LocalPort 2368 -Protocol UDP -Action Allow -Profile Any`) was **not sufficient** while the interface remained Public. Reception only worked after the interface's network category was changed to **Private**.

This is not broadcast-specific and not VPN-related — both were investigated and ruled out (see troubleshooting). It reproduces identically for unicast (`192.168.1.10`) and broadcast (`255.255.255.255`) destinations.

---

## Troubleshooting steps taken

1. **Confirmed data on the wire** — `Get-NetAdapterStatistics` on the sensor NIC showed ~910 RX pkt/s; ruled out cabling, power (at the time), and sensor output as the cause of the socket seeing nothing.
2. **Ruled out a competing listener** — `Get-NetUDPEndpoint -LocalPort 2368` was empty; no other process was consuming the port.
3. **Ruled out NordVPN** — NordVPN services were running (and auto-restarted after being killed), but the WFP capture attributed the drop to `MPSSVC` (Windows' own firewall), not any Nord filter. NordVPN was a dead end despite strong initial suspicion.
4. **Ruled out broadcast-vs-unicast** — reconfiguring the Puck's `host.addr` to unicast `192.168.1.10` (verified: NIC switched to `unicast +1806/broadcast +0`) still yielded 0 packets in the socket. The delivery problem was independent of destination type.
5. **Isolated to the firewall (decisive)** — a self-validating test measured NIC arrival immediately before sniffing with the firewall disabled: `arriving_at_nic=775, sniffer_with_fw_off=624`. Firewall = the blocker.
6. **Found the allow rule insufficient on Public** — recreating the `UDP/2368`+`8308` allow rules and re-enabling the firewall still gave `sniffer=0` while the interface was Public.
7. **Fixed by Private profile** — `Set-NetConnectionProfile -InterfaceAlias Ethernet -NetworkCategory Private` (rule + firewall on) → `sniffer=613`, then certified at 757 pkt @ 1206 B @ ~755 pps.

---

## Fix

### Host firewall / network profile — mark the sensor link Private and add allow rules

```powershell
# 1. Inbound allow rules for VLP-16 data + position ports (any profile)
New-NetFirewallRule -DisplayName 'VLP-16 data'     -Direction Inbound -Protocol UDP -LocalPort 2368 -Action Allow -Profile Any
New-NetFirewallRule -DisplayName 'VLP-16 position' -Direction Inbound -Protocol UDP -LocalPort 8308 -Action Allow -Profile Any

# 2. The actual unlock: move the sensor interface out of the Public profile
Set-NetConnectionProfile -InterfaceAlias 'Ethernet' -NetworkCategory Private
```

The Private classification is what makes Windows honor the inbound allow rule for unsolicited UDP. It is also the *correct* classification for a dedicated point-to-point sensor link.

**Note:** swapping a different sensor into the same physical port can make Windows re-identify the network as Public again — re-run the `Set-NetConnectionProfile` step if reception drops to zero after a swap. To make it permanent for that port, set unidentified networks to Private via Local Security Policy → Network List Manager Policies → Unidentified Networks → Location type = Private.

(Linux host behavior is deliberately not documented here — it will be captured from the unit #2 bring-up in `docs/vlp16-bench-bringup.md` §6.)

---

## Files changed

- Host OS network configuration only (no repo source files changed).
- `docs/vlp16-bench-bringup.md` — new runbook capturing the working procedure.
- `docs/issues/2026_07_17_windows_firewall_public_profile_drops_vlp16_udp.md` — this document.
