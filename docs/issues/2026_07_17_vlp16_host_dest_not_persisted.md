# VLP-16 data destination (`host.addr`) set via the web API reverts to broadcast on power-cycle, so a configured unicast target is silently lost after a reboot

**Date:** 2026-07-17
**Component:** VLP-16 web API `POST /cgi/setting/host` (firmware `3.0.41.1`); consumer network assumptions in `docs/vlp16-client.md`.
**Severity:** Low — operational gotcha, not a data-loss bug; matters mainly because it caused a confounded test during this session.

---

## Observed symptom

- `POST /cgi/setting/host` with `addr=192.168.1.10` returned `204` and `GET /cgi/settings.json` confirmed `host.addr == "192.168.1.10"`; the NIC RX split confirmed the stream actually switched to unicast (`unicast +1806, broadcast +0` per 2 s).
- After an unrelated **power-cycle**, `GET /cgi/settings.json` showed `host.addr == "255.255.255.255"` again and the NIC saw broadcast (`broadcast +1815, unicast +0`) — the unicast target was gone.
- This silently invalidated a subsequent "unicast test": the sensor was actually broadcasting the whole time, so the socket result did not reflect the unicast path at all.

---

## Root cause

### The setting applies to the running config but is not persisted to non-volatile storage across a power cycle

Via this endpoint/firmware, `POST /cgi/setting/host` takes effect immediately on the live stream but does not survive a power cycle — the unit boots back to its default data destination of `255.255.255.255` (limited broadcast). (Whether a separate save/commit step or a different field would persist it was not pursued, since broadcast is acceptable once the host firewall is fixed.)

---

## Troubleshooting steps taken

1. **Set unicast and confirmed via `settings.json` + NIC split** — verified the running stream genuinely switched to unicast `192.168.1.10`.
2. **Observed reversion after power-cycle** — `settings.json` showed `255.255.255.255` and the NIC showed broadcast again, without any manual change.
3. **Recognized the confound** — an earlier "unicast didn't fix reception" conclusion was invalid because the stream had reverted to broadcast (and the sensor had also faulted); reception was actually a host-firewall problem (see companion issue).

---

## Fix

### Operational — pick one

- **Rely on broadcast (simplest).** Default `255.255.255.255` works fine once the host firewall honors inbound `UDP/2368` (on Windows: Private profile + allow rule). No per-boot step.
- **Or re-apply unicast on each boot** if you specifically want directed traffic:

```powershell
Invoke-WebRequest -Uri 'http://192.168.1.201/cgi/setting/host' -Method POST `
  -Body @{ addr='192.168.1.10'; dport='2368'; tport='8308' } -UseBasicParsing
```

Always re-verify with `GET /cgi/settings.json` and a NIC check that the stream actually reflects the change.

### API note

Use `Invoke-WebRequest -UseBasicParsing` on Windows PowerShell 5.1 — without it the call throws `Object reference not set to an instance of an object` (legacy IE-parser dependency) and the POST never sends.

---

## Files changed

- No repo source files (sensor configuration).
- `docs/vlp16-bench-bringup.md` — notes broadcast-vs-unicast tradeoff and the per-boot reversion.
