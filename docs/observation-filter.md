# Observation filter — hits, opportunities and artefact rejection

A serve-time filter over the fused cloud that hides voxels the sensor rarely hit. The store
already counts hits per voxel (the accumulator's `n`); this adds a per-chunk **opportunity**
counter driven by a field-of-view test per batch, so each voxel also knows how many batches
*could* have re-observed it. The filter never mutates the store: the map stays lossless, the
threshold is a viewer knob, and a voxel that later gains hits reappears on its own.

Ray clearing (miss integration) is deliberately not part of this; see "Next" below. The idea
descends from the Livox scanner's voxel color map (`robotics/livox_handheld_scanner/docs/
VOXEL_COLOR_MAP.md`: log-odds occupancy, `--min-hits`, `--ray-clear`), reduced to what can run
live on the ingest path.

## Model

- **Hits** `n`: samples fused into the voxel (already tracked).
- **Chunk opportunities**: per chunk, the number of batches whose sensor pose had the chunk's box
  in the field of view. Tested per batch on a 3×3×3 lattice over the box against the session's
  elevation band and max range (`SENSOR_ELEVATION_MIN_DEG`/`MAX_DEG`, `SENSOR_MAX_RANGE_M`,
  defaults −15°/+15°/100 m for a level VLP-16; per-session override via `create_session`
  `metadata.sensor_fov`). A chunk that receives points counts regardless of the geometry test.
  Cost is O(chunks) per batch, not O(voxels).
- **Voxel baseline** `o0`: the chunk's opportunity count when the voxel first appeared. Its own
  opportunities are `chunk.opportunities − o0 + 1`, and its ratio is `n / opportunities`.
- **Filter** `{ min_hits, min_ratio }` in `viewer_view`: a voxel is served when
  `n ≥ min_hits` and `ratio ≥ min_ratio`. Coarser LOD levels bin only the survivors. The live
  overlay is never filtered.

Counters are persisted with the chunk (`.acc` v2 carries `o0` per voxel; the `chunks` row carries
`opportunities` and `fov_sequence`) and rebuilt by log replay, full rebuilds, and partial rebuilds,
with the same idempotency guard the point data uses (`fov_sequence`, like `applied_sequence`). A
crash mid-partial-rebuild can leave counters of non-rebuilt chunks slightly stale; they are a
heuristic, not data.

## Measured

`pcv-align-demo --fliers 0.02 --azimuth-steps 1800` publishes the synthetic room at VLP-16
density (28.8k points per spin, 16 rings over ±15°) with 2 % one-off artefact returns at random
ranges. Publishing the same scene with `--fliers 0` gives the wall voxel set, so a flier voxel is
one present only in the fliers session. Filters were evaluated at the store level over all
chunks (81 batches, 234k wall voxels, 66.5k flier voxels):

| Filter | Fliers removed | Wall voxels lost |
|---|---|---|
| min hits 2 | 87.6 % | 12.5 % |
| min hits 3 | 96.5 % | 23.2 % |
| min ratio 0.1 | 86.3 % | 38.9 % |
| min ratio 0.25 | 95.0 % | 68.8 % |
| min ratio 0.5 | 97.5 % | 86.2 % |
| hits 2 + ratio 0.25 | 99.4 % | 69.4 % |

**Reading it:** the hit count is the useful knob; the ratio, as counted here, is not. A 16-ring
sensor samples elevation sparsely: at 4 m the rings are ~14 cm apart, so a 4 cm wall voxel lies on
a ring for only a fraction of the batches whose field of view covers its chunk. Chunk-level
opportunities therefore over-count for every voxel between rings, and a ratio threshold that
removes fliers also removes most of the wall. The wall voxels that `min hits 2` loses are the
ones a ring crossed exactly once during the walk; on a real capture where the sensor lingers they
would accumulate hits. ⚠ synthetic only; no real VLP-16 data yet.

The field-of-view pass itself is cheap: the ingest benchmark shows no measurable change (p50 per
batch within noise of the pre-filter 22 ms).

## Recommended use for now

Start with `min hits 2` (first-order flier rejection, cheap, safe) and leave `min ratio` at 0.
Raise `min hits` while the sensor dwells. Treat `min ratio` as experimental until the per-voxel
counting below exists.

## Next

- **Ring-aware, per-voxel opportunities.** Count an opportunity for a voxel only when a ring
  actually passes through it: elevation of the voxel centre relative to the sensor within half a
  ring spacing of one of the sensor's ring elevations. That is O(voxels in view) per batch, so run
  it on resident chunks only (in-view surfaces are the ones receiving points and staying
  resident) and sub-sample batches when the session grows. The synthetic fliers scenario above is
  the acceptance test: wall loss at a ratio that removes ≥ 90 % of fliers should drop well below
  the hit-count filter's.
- **Ray clearing** as a post-alignment pass in the sidecar, off the log, never on the ingest path.
  Clearing against a drifted trajectory carves holes in real walls, so it belongs after loop
  closure. The Livox project's vectorised Amanatides–Woo is the reference.
- **Temporal decay** for dynamic scenes (a person walking through the room) is a different
  problem and untouched.
