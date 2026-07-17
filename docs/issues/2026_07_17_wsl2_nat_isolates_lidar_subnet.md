# WSL2 default NAT networking isolates the sensor subnet, so tools run inside WSL2 cannot reach or receive from the VLP-16

**Date:** 2026-07-17
**Component:** Host networking topology (WSL2 virtual switch vs. Windows physical NIC).
**Severity:** Medium — not a hard blocker (work from the Windows side), but it silently misleads: the sensor is reachable from Windows yet invisible from the WSL2 shell where you're likely working.

---

## Observed symptom

- Inside the WSL2 shell, `ip -brief addr` showed `eth0 = 172.25.60.243/20` — a NAT address on the WSL virtual switch, **not** on the sensor's `192.168.1.x` subnet.
- `ping 192.168.1.201` (the Puck) from WSL2 returned **100% packet loss**.
- `ip route` had no route to `192.168.1.0/24`; only the WSL NAT default via `172.25.48.1`.
- The same Puck was fully reachable from Windows (`ping`, web UI, UDP) — the device was fine; WSL just couldn't see it.

---

## Root cause

### WSL2 runs behind a NAT'd virtual switch by default

WSL2's default networking mode places the Linux VM on an internal Hyper-V virtual switch with NAT. It gets its own subnet (`172.25.x.x` here) and reaches the outside world only through address translation via the Windows host. Devices on a *physical* LAN segment — like a LiDAR on a dedicated NIC — are on a different L2/L3 domain that the NAT does not bridge. There is no route, and broadcast/unicast sensor traffic never crosses into the VM.

`/etc/wsl.conf` had only `[boot] systemd=true` — no `networkingMode=mirrored`, confirming default NAT.

---

## Troubleshooting steps taken

1. **Enumerated WSL interfaces** — `eth0` was a `172.25.x` NAT address, immediately explaining why the `192.168.1.x` sensor was unreachable.
2. **Checked `/etc/wsl.conf`** — no mirrored-networking setting; confirmed default NAT mode.
3. **Verified the sensor from Windows** — `ping`/web UI/UDP all worked from `powershell.exe`, proving the device and physical link were healthy and the isolation was purely WSL's NAT boundary.

---

## Fix

### Option A (used here) — drive the sensor from the Windows side

Run reachability, web-UI, and packet-capture commands via `powershell.exe` from the WSL shell (or a native Windows terminal). All the diagnostics in the runbook use this pattern. Simplest for one-off bring-up.

### Option B — enable WSL2 mirrored networking (Windows 11 22H2+)

Mirrored mode makes WSL2 share the Windows host's interfaces (including the sensor NIC), so Linux tools can bind and receive directly.

```ini
# %USERPROFILE%\.wslconfig
[wsl2]
networkingMode=mirrored
```

Then `wsl --shutdown` and reopen. After this, the WSL2 shell sees `192.168.1.x` and can bind the capture socket natively.

### Option C — native Linux host

Running the point-cloud-visualizer client on a native Linux machine on the sensor subnet avoids the WSL boundary entirely (this is the unit #2 verification path; the Linux procedure will be documented in `docs/vlp16-bench-bringup.md` §6 once observed).

---

## Files changed

- No repo source files (host/WSL configuration only).
- `docs/vlp16-bench-bringup.md` — runbook (Windows path documented; Linux path pending unit #2, §6).
