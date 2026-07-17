# VLP-16 entered a protective disabled state (motor/laser off, all-zero diagnostics) mid-session, silently confounding network capture tests

**Date:** 2026-07-17
**Component:** VLP-16 sensor hardware + power delivery; diagnostic method (`/cgi/status.json`, `/cgi/diag.json`).
**Severity:** High — dual impact: (1) it masquerades as a network fault and derails debugging, and (2) it signals a real power/thermal margin problem that will recur under the same conditions.

---

## Observed symptom

- After ~30+ minutes of continuous bench operation, `/cgi/status.json` reported:
  `motor: { state: "Disabled", rpm: 0 }`, `laser: { state: "Disabled" }` — despite the stored settings still commanding `laser: On`, `rpm: 600`.
- `/cgi/diag.json` read **all zeros**: every voltage rail (`pwr_v_in`, `pwr_5v`, `pwr_3_3v`, …), all board temps, `hv` — everything 0.
- The web UI (base/comms board) stayed fully responsive throughout.
- The NIC RX rate for sensor traffic fell to **~0**, and multiple socket captures returned **0 packets** — which were initially (wrongly) attributed to the ongoing network problem.
- A **power-cycle fully recovered it**: `motor: On @ 600 rpm`, `laser: On`, and `diag.json` rails returned to healthy values (5 V rails ≈ 2048 ADC counts, 2.5 V ≈ 2047, 3.3 V ≈ 2676, 1.2 V ≈ 985; board LM20 temps ≈ 40 °C; detector `ad_temp` ≈ 90 °C).

---

## Root cause

### Protective shutdown of the spinning sensor assembly, base board still powered

`"Disabled"` is a **fault/interlock state**, distinct from the commanded `"On"`/`"Off"` — the hardware overrode the commanded settings and parked the motor + laser. The base/comms board kept enough power to serve HTTP, while the sensor rails read zero (the monitoring ADC reported nothing in the fault state).

The most likely trigger is a **power sag under load** from a marginal/underrated supply or injector: the unit starts fine, then peak draw (motor + laser) browns out the sensor rails and trips the protection. A **thermal** contribution is plausible too — the detector ran ~90 °C on a static bench with no airflow. That a simple power-cycle (not a long cooldown) recovered it points more toward power than pure thermal.

### Diagnostic method failure: trusting a zero-packet capture without verifying the source is live

Several "0 packets" results during this session were recorded *after* the sensor had already faulted, but were interpreted as network failures (e.g. a "unicast didn't fix it" and a "firewall-off didn't help" conclusion were both confounded by the sensor not emitting). Each negative capture should have been gated on a live-source check first.

---

## Troubleshooting steps taken

1. **Read `status.json`** — found `motor: Disabled, rpm: 0`, `laser: Disabled` where earlier it was `On @ 599–600 rpm`; identified a fault state, not a network issue.
2. **Read `diag.json`** — all rails/temps zero, confirming the sensor assembly had lost power/monitoring while the comms board stayed up.
3. **Correlated with NIC RX** — sensor traffic had dropped to ~0, explaining the run of zero-packet captures and exposing them as confounded.
4. **Power-cycled** — sensor recovered immediately to `motor On @ 600`, `laser On`, healthy `diag.json`; confirmed transient protection rather than a dead unit.

---

## Fix

### Operational — recovery and prevention

- **Recover:** power-cycle the interface box (~10 s off), then re-read `status.json`/`diag.json`.
- **Prevent:** power the Puck from a supply with real current headroom (9–32 V, generously rated — a borderline wall-wart is the usual culprit for eBay units); reseat the interface-box connectors; provide airflow if running long on a static bench.
- **Watch:** if it re-faults after ~20–30 min, the cause is confirmed marginal — upgrade the supply (power) and/or add a fan (thermal, detector was ~90 °C).

### Method — always confirm the source is live before trusting a negative capture

Before concluding "0 packets = network problem," verify in the same breath:
- `status.json` shows `motor.state == "On"` and a non-zero `rpm`, and
- the NIC RX counter is climbing (`Get-NetAdapterStatistics`).

This single guard would have prevented the two confounded conclusions in this session. The runbook's verification steps bake it in.

### Reference — VLP-16 `diag.json` ADC conversions (firmware 3.0.41.1)

Raw fields are 12-bit ADC counts. Healthy sanity checks used here:
- rails: `pwr_5v ≈ 2048`, `pwr_2_5v ≈ 2047`, `pwr_3_3v ≈ 2676`, `pwr_1_2v ≈ 985` (all-zero = fault).
- LM20 board temp °C ≈ `-1481.96 + sqrt(2.1962e6 + (1.8639 - raw*5/4096)/3.88e-6)` → ~40 °C running.

---

## Files changed

- No repo source files (sensor hardware / power).
- `docs/vlp16-bench-bringup.md` — verification steps include a mandatory live-source check.
