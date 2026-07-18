# Phase 2 — Voxel fusion + LOD

Design for the density-bounding and level-of-detail layer. This is the "make streamed data feel
like potree" work: bound how many points a surface can ever cost, and load coarse-to-fine so a
viewer sees something instantly and refines toward it.

Realizes [`architecture.md`](./architecture.md) §2 (fusion: "deduplicating or downsampling repeated
observations") and §3 (mutable spatial store: "voxel blocks keyed by 3D grid index").

## Why

The Phase 1 loop stores and serves **every measurement**. Problems that surface at scale:

- **Unbounded density.** A stationary or slow sensor re-measures the same wall thousands of times.
  Storage, bootstrap payload, and GPU point count all grow without bound for zero new information.
- **Bootstrap sends everything.** On join we stream every chunk's full contents. Fine at 2M points,
  fatal at 200M.
- **No LOD.** The viewer gets full-resolution points whether the chunk fills the screen or is a
  speck 80 m away. The client ring buffer (`CAPACITY = 1_000_000`) is a stopgap that drops *oldest*
  points — spatially arbitrary, not detail-aware.

Voxel fusion fixes the first two; LOD fixes the third.

## Staging

Two increments. **2a is self-contained and ships the biggest win with no protocol or viewer
change.** 2b is the true potree-like experience and needs a protocol addition.

### 2a — Voxel fusion on ingest (bounded density) — **implemented**

Landed in `chunk-store.ts`. Ingest fuses into per-chunk voxel accumulators (4 cm default); flush
overwrites the chunk file with representatives; a re-touched resting chunk is re-seeded from disk so
fusion continues in place; `readSessionWorldChunks` emits resident chunks from memory and only
non-resident chunks from disk (no double count). No protocol or viewer change. E2e: a moving
synthetic sensor streaming 1,032,000 raw points collapsed to 459,584 fused (~2.2× — far higher for
slow/stationary sensors; the unit test's identical-batch case is 15→2).

**Idea:** quantize world points to a fine global voxel grid; keep one representative point per
occupied voxel. A fully-sampled surface stops growing — occupied-voxel count is bounded by
`surface_area / voxel_area`, independent of dwell time or revisits.

**Key property: the on-disk chunk format and the entire serving path stay unchanged.** Fusion is
purely an ingest-side transform. Chunk files still hold 18-byte world-frame points
(`xyz_rgb_i_v1`), so `readSessionWorldChunks`, bootstrap, and the viewer need zero changes — the
bootstrap payload simply gets smaller because the file now holds fused representatives instead of
raw appends.

**Mechanics (in `chunk-store.ts`):**

- Config `FUSE_VOXEL_METERS` (default `0.04` — ~VLP-16 range noise; finer just stores noise).
- Global voxel index of a world point: `vi = floor(world / voxelSize)` → integer triple → map key.
  Global (not chunk-local) so fusion is consistent across chunk boundaries.
- Per **active** chunk, replace the raw append buffer with a voxel accumulator map
  `voxelKey -> { sx, sy, sz (f64 sums), sr, sg, sb, si (u32 sums), n (count) }`. Merge is
  commutative/associative → order-independent, robust to out-of-order batches and revisits.
- Representative on output = component means (`sx/n`, …), re-encoded as an 18-byte point.
- **Flush = full rewrite** of the chunk file with current representatives (not append). Occupied
  voxels per 2 m chunk are bounded (a few thousand for a surface at 4 cm), so rewriting is cheap.
- **Reload/revisit:** when a point lands in a previously-flushed chunk, read its representatives
  back and seed the accumulator with each at `n = 1`. Slightly under-weights pre-eviction history
  on a revisit; positions converge regardless — visually negligible, and it keeps disk = the
  18-byte format with no side-car accumulator file.

**Live path is untouched.** `chunk_update` deltas still stream the raw incoming batch (local frame +
pose) to connected viewers for low latency; the viewer ring buffer bounds the *live* cloud. Only the
*persisted / bootstrap* cloud is fused. Consistent enough: the live ring is overwritten continuously
anyway, and a rejoin lands on the fused version.

**Win:** storage and bootstrap payload become proportional to *observed surface*, not *measurement
count*. This is the single biggest scale lever and it drops in behind the existing interfaces.

### 2b — LOD pyramid + view-driven streaming (potree-like)

**Idea:** build coarser levels above the fused fine grid and stream per-chunk detail matched to how
much screen space the chunk occupies. Far/zoomed-out → coarse; near/zoomed-in → fine.

**Level structure — two candidates (decide at 2b start, not now):**

1. **Additive octree (potree/Entwine model).** Each point belongs to exactly one node: the coarsest
   level whose cell it can still claim; if the cell is taken, descend and claim a child. Rendering
   levels `0..L` shows increasing detail with **no double-counting and no re-sends on refine** —
   refining a chunk sends only the next level's *additional* points. Best bandwidth and the truest
   potree feel; more complex incremental insertion and state.
2. **Mip pyramid (per-chunk, per-level re-voxelization).** Level `k` voxel size = `base * 2^k`,
   independently fused. Refining a chunk *replaces* its points with the finer level. Simple to
   reason about and implement; costs a re-send on each refine step.

Recommendation: target the **additive octree** because it's the experience the user asked for and
avoids refine re-sends, but a **mip-per-chunk** first cut is acceptable if additive insertion proves
fiddly under streaming.

**Serving changes (protocol additions):**

- New viewer→server message `viewer_view` (camera position, orientation, fov, viewport px), sent
  throttled (~5–10 Hz) as the camera moves.
- Per-chunk LOD selection server-side: project voxel size to screen space (or bucket by distance);
  pick the level where a voxel is ~1–2 px.
- Chunk/level delivery keyed by `(chunkKey, level)` so the viewer can swap or stack a chunk's points
  (replace for mip, append for additive). Frustum-cull off-screen chunks entirely.

**Viewer changes:** replace the single global ring buffer with per-chunk GPU buffers (or a slab
allocator) so individual chunks can be upgraded/downgraded/evicted independently. Send `viewer_view`
on camera settle.

## Recommendation

Build **2a first** — biggest scale win, self-contained, no protocol/viewer churn, immediately
shrinks bootstrap. Then design **2b** as its own milestone (protocol + viewer changes), resolving
additive-vs-mip at that point.

## Open questions

- Fuse color/intensity by mean, or keep most-recent (freshness vs. denoising)? Default mean.
- Should the **live** delta path also fuse (bounded live cloud) once per-chunk viewer buffers land
  in 2b, retiring the client ring buffer entirely? Likely yes.
- Voxel size per session vs. global default — room-scale vs. building-scale want different bases.
