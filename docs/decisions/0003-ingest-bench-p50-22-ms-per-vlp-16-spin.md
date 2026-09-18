---
kind: outcome
status: verified
date: 2026-09-18T14:28:00-04:00
resolves: 0001
source: scripts/bench-ingest.ts
---

# 0003 — Ingest bench: p50 22 ms per VLP-16 spin

## Measurement

`npm run bench:ingest` on 2026-09-18, root ext4 SSD, 60 VLP-16-sized spins of 28,800 points in an
8 × 8 × 2.7 m room from a slowly turning sensor, ~41 two-metre chunks touched per batch:

| Path | p50 | p90 | fsyncs per batch |
|---|---|---|---|
| transaction-per-batch (before [0002](0002-append-only-batch-log-is-the-durability-anchor-chunk-files-a.md)) | 780 ms | 883 ms | ~250 |
| batch log (after) | 22 ms | 39 ms | ~6 |
| fusion only, no disk | 16–32 ms | | 0 |

Re-measured after the observation counters landed: p50 21 ms, no change. Full details in
[`../batch-log.md`](../batch-log.md).

## Closes

[0001](0001-ingest-must-sustain-a-vlp-16-at-10-hz.md): 22 ms against a 100 ms spin period.
Synthetic batches only; a real VLP-16 stream through the KISS-ICP publisher has not been run against
this build.
