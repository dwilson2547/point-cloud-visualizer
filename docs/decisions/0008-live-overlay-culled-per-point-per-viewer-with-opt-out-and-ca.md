---
kind: decision
status: accepted
date: 2026-09-18T14:28:00-04:00
depends_on: [0005]
source: docs/protocol-v1.md
---

# 0008 — Live overlay culled per point per viewer, with opt-out and cap

## Context

After [0005](0005-base-layer-refreshes-are-append-only-deltas-keyed-by-fine-vo.md) the live
overlay (every accepted batch rebroadcast to every viewer) was three quarters of what a viewer
received. Culling by the batch's bounding box was the obvious first idea.

## Options

- A. Cull whole batches by their world bounding box against the viewer frustum.
- **B. Cull per point:** transform the batch to the world frame once per batch, test each point
  against each LOD viewer's frustum, send each viewer only its rows (still in the publisher's wire
  format, still with the pose), with `overlay: false` and `overlay_max_points` in `viewer_view`.
- C. Drop the overlay and rely on faster delta refreshes.

## Decision

Option B, with C available per viewer through the opt-out. A does nothing for a spinning lidar
inside a room: every batch's box spans the room and intersects every frustum. B costs one
transform per point per batch plus one plane test per point per viewer, a few milliseconds for a
handful of viewers.

## Consequences

- Metered: a viewer looking down at the whole room still receives 100 % of the points (the sensor
  is inside the room, so everything is in view); a corner view along one wall receives 30 %.
  Overlay bytes are now proportional to what the viewer looks at.
- Plain (non-LOD) viewers still receive full batches.
- Even-stride decimation for the cap relies on spin order (points ordered by azimuth) to thin
  uniformly; a publisher that shuffles points would get uneven thinning.
