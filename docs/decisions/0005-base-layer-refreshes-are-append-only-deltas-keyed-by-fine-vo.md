---
kind: decision
status: accepted
date: 2026-09-18T14:28:00-04:00
source: docs/phase-2-voxel-fusion-lod.md
---

# 0005 — Base-layer refreshes are append-only deltas keyed by fine voxel count

## Context

The LOD serving path re-sent every dirty chunk whole on each refresh tick. Metered on the synthetic
room at VLP-16 density that was 112 MB of re-sends over 12 s for one viewer holding the whole
scene. The phase-2 design had already chosen mip-per-chunk over an additive octree for the *level*
structure (see `../phase-2-voxel-fusion-lod.md`, Decision 1); this is the refresh structure.

## Options

- **A. Append-only deltas keyed by fine voxel count.** Voxels are append-only and stay in
  insertion order in memory and on disk, so a viewer's "version" of a chunk is the fine voxel count
  it last saw; a refresh sends the tail (finest level) or the coarse cells whose first fine voxel
  is new. Keyframes on level change, on count divergence (observation filter), and when the chunk
  doubles since the last keyframe so early means get re-sent.
- B. Additive octree (each point owned by exactly one node; refine sends only additional points).
- C. Keep whole-chunk re-sends and rely on compression.

## Decision

Option A. It needs no new storage (order is the version), is exactly right for a fused map that
only gains voxels, and converges for a stationary sensor. B's bandwidth argument was for
*refinement*, and deltas make it largely moot; its mutation cost was the reason it was set aside
in phase 2 and that has not changed. C was measured at 1.6× and does not change the shape of the
problem.

## Consequences

- 4.5 MB keyframes + 2.4 MB deltas where whole-chunk re-sends were 112 MB (18-byte format).
- The refresh tick could drop from 500 ms to 250 ms.
- A voxel's mean is frozen at first sight between keyframes; the doubling rule bounds the drift.
- Made the live overlay the dominant per-viewer stream, which led to
  [0008](0008-live-overlay-culled-per-point-per-viewer-with-opt-out-and-ca.md).
