---
kind: decision
status: accepted
date: 2026-09-18T14:28:00-04:00
satisfies: [0001]
source: docs/batch-log.md
---

# 0002 — Append-only batch log is the durability anchor; chunk files are a derived cache

## Context

The first durable design acked a batch only after every touched chunk file had been rewritten,
fsynced and renamed through a staged transaction directory. Measured with a VLP-16-sized batch on
the laptop's SSD that cost p50 780 ms and ~250 fsyncs per batch, one eighth of the sensor rate
([`../batch-log.md`](../batch-log.md)). Separately, voxel fusion is destructive: once a point is
averaged into a world voxel it cannot be moved by a later pose correction.

## Options

- **A. Append-only per-session batch log as the durability anchor.** One write and one fsync per
  batch, then ack. Chunk files become a cache checkpointed in the background; each chunk carries
  the last batch sequence fused into it so replay is idempotent per chunk; a session-level
  checkpoint offset bounds replay.
- B. Keep the transaction-per-batch design and tune it (fewer fsyncs, smaller sidecars).
- C. Batch the transactions (ack every N batches).

## Decision

Option A. It fixes throughput by construction rather than by tuning, and it keeps every raw batch
with the pose it was registered with, which any later alignment needs. B could not close the gap
(~340 ms of the 780 was fsync, the rest was rewriting ~30 MB of chunk files per batch). C keeps the
per-batch rewrite cost and only amortises the fsyncs.

## Consequences

- p50 22 ms per batch ([0003](0003-ingest-bench-p50-22-ms-per-vlp-16-spin.md)).
- The log grows ~19 GB per hour for a VLP-16 and nothing compacts it yet; retention is open.
- SQLite runs in WAL mode with `synchronous = NORMAL`: on power loss, rows since the last WAL
  checkpoint can be lost while acked batches survive in the log. Unverified beyond SQLite's own
  documentation.
- Enabled [0004](0004-alignment-is-a-correction-layer-over-the-raw-log-produced-by.md).
