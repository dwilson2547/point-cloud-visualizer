---
kind: decision
status: accepted
date: 2026-09-18T14:28:00-04:00
depends_on: [0002]
source: docs/alignment.md
---

# 0004 — Alignment is a correction layer over the raw log, produced by a Python sidecar

## Context

Publishers own odometry (the KISS-ICP client does scan matching sensor-side), and it drifts. With
the raw batches retained in the log ([0002](0002-append-only-batch-log-is-the-durability-anchor-chunk-files-a.md))
the server can re-fuse a session under different poses. The question was where pose correction
lives and how it reaches the store.

## Options

- **A. A correction layer over the raw log.** A Python sidecar (Open3D) builds a keyframe pose
  graph from the log, verifies loop candidates with ICP, optimises, and installs
  `{pose_sequence → pose}` corrections plus a tail transform over HTTP. The server applies them at
  fuse time (live ingest, replay, rebuild); the log is never modified.
- B. Server-side scan-to-map ICP on every incoming batch in Node.
- C. Rewrite the log with corrected poses.

## Decision

Option A. B duplicates what the KISS-ICP client already does and Node is the wrong host for ICP
and a graph solver; it only earns its place for publishers without odometry. C destroys the ability
to remove a bad correction; keeping raw and corrected separate means `DELETE pose-corrections`
always returns to the publisher's frame.

## Consequences

- Synthetic loop: end-of-loop error 0.75 m → 5 mm, doubled walls collapse (254k → 158k voxels).
- Incremental: the sidecar keeps its graph, re-optimises only on a new closure, and `--watch`
  tails a live session; the server keeps a per-batch index so a correction re-fuses only what
  moved (no-op below half a voxel, partial rebuild, or full when most of the session moved).
- A closure still moves most of the trajectory since the last closure, so it is usually a full
  re-fusion; keyframe-attached submaps are the next rung.
- Open3D's edge convention (`target_T_source = inv(pose_target) @ pose_source`) is the one thing
  here that fails silently when wrong; recorded in `docs/notes/`.
- Untested on real VLP-16 data.
