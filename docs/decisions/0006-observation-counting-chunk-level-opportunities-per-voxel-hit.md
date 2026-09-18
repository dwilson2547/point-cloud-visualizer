---
kind: decision
status: accepted
date: 2026-09-18T14:28:00-04:00
source: docs/observation-filter.md
---

# 0006 — Observation counting: chunk-level opportunities, per-voxel hits; ring-aware counting deferred

## Context

Sensor artefacts (fliers, reflections) are voxels hit once or twice while the sensor kept looking
at the area. The Livox scanner project uses log-odds occupancy with a min-hits gate and ray
clearing. The question was what to run live on the ingest path here.

## Options

- **A. Per-voxel hits (already in the accumulator) plus a per-chunk opportunity counter** from a
  27-sample field-of-view test per batch, with each voxel keeping the chunk count at its creation
  as a baseline; filter at serve time on `min_hits` and hits/opportunities.
- B. Per-voxel ring-aware opportunities: count only when a ring's elevation passes through the
  voxel. O(voxels in view) per batch.
- C. Ray clearing (miss integration) on the ingest path.

## Decision

Option A now, B deferred, C deferred to a post-alignment pass in the sidecar. A is O(chunks) per
batch and measured no ingest cost. C on a drifted trajectory carves holes in real walls and is the
part of the scanner's pipeline that took minutes, so it belongs after loop closure and off the
ingest path.

## Consequences

- Measured on the synthetic room at VLP-16 density with 2 % fliers: `min hits 2` removed 88 % of
  fliers for 12.5 % wall loss; `min ratio 0.1` removed 86 % for 39 % wall loss. The ratio as
  counted here is dominated by ring geometry (16 rings ~14 cm apart at 4 m vs 4 cm voxels), so hit
  count is the usable knob and the ratio is experimental until B exists
  ([`../observation-filter.md`](../observation-filter.md)).
- The filter never mutates the store; a voxel that later gains hits reappears on its own.
- `.acc` sidecars moved to v2 (72-byte records) to carry the baseline; v1 files still load.
