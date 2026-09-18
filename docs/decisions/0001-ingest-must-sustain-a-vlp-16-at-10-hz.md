---
kind: requirement
status: done
date: 2026-09-18T14:28:00-04:00
source: docs/batch-log.md
---

# 0001 — Ingest must sustain a VLP-16 at 10 Hz

## What

The server must accept a Velodyne VLP-16's output at its native rate: one spin of ~28.8k points
every 100 ms, acknowledged fast enough that a publisher keeping one batch in flight never falls
behind. The KISS-ICP publisher blocks on each ack and drops UDP packets after ~5 s of backlog, so
"fast enough" means well under 100 ms per batch end to end.

## Why

Every publisher in the project is a spinning lidar and the bring-up sensor is the VLP-16. A server
that cannot keep up with one sensor at full rate has no path to anything else.

## Done when

`npm run bench:ingest` reports a p50 per-batch cost under the 100 ms spin period with headroom.
Closed by [0003](0003-ingest-bench-p50-22-ms-per-vlp-16-spin.md).
