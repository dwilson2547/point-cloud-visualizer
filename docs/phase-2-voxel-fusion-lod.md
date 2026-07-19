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

**Idea:** derive coarser levels above the fused fine grid and stream each chunk at a detail matched
to how much screen space it occupies. Far/zoomed-out → coarse; near/zoomed-in → fine. Most chunks
never load at full resolution, so a building-scale cloud stays interactive.

#### Decision 1 — mip-per-chunk pyramid, not an additive octree

Two candidate level structures:

1. **Additive octree (potree/Entwine).** Each point belongs to exactly one node; refining a chunk
   sends only the *additional* points the finer level introduces. Best bandwidth, truest potree
   feel — but incremental insertion is stateful, and under **mutation** (points keep arriving and
   re-fusing) you must re-decide which point owns each cell as the underlying data shifts.
2. **Mip-per-chunk.** Level `ℓ` is an independent re-voxelization of the chunk's fine grid at voxel
   size `fineVoxel · 2^(Lmax−ℓ)`. Refining *replaces* a chunk's points with the finer level.

**Chosen: mip-per-chunk.** Rationale, weighted for our *live, mutable* store (the thing that makes
this not-potree):

- **Mutation-friendly.** When a chunk's fine voxels change, coarse levels are just re-derived by
  re-binning — no ownership rebalancing. Additive octree updates are genuinely hard under mutation.
- **Trivial derivation.** Coarse voxel bounds are powers-of-two multiples of the fine voxel, so they
  nest exactly. Build the pyramid bottom-up: level `ℓ` from `ℓ+1` by 2×2×2 mean-binning. This reuses
  the 2a accumulator math directly.
- **Bounded re-send cost.** For *surfaces* (2-D manifolds), level `ℓ` has ~4× the points of `ℓ−1`,
  so the finest level dominates; the sum of all coarser levels is ≈ ⅓ of the finest. Mip's "waste"
  from re-sending on refine is therefore ~33% **and only for chunks the camera actually approaches
  to full detail** — distant chunks never refine. Acceptable for the simplicity and mutability win.

Additive octree stays on the table as a later bandwidth optimization if refine re-sends ever measure
as a real bottleneck. Not now.

#### Decision 2 — two-layer viewer: LOD base + live overlay

The tension: LOD serving is **chunk-oriented** (send chunk X at level ℓ), but live deltas are
**batch-oriented** (a batch spans several chunks, carries local-frame points + one pose) and must
render at low latency. Forcing live updates through per-chunk re-sends would add settle latency and
kill the real-time feel.

Resolution — the two-layer viewer from [`architecture.md`](./architecture.md) §5:

- **Base layer** — per-chunk GPU buffers, view-driven LOD. Fed by `chunk_lod` (replace a chunk's
  points) and `chunk_drop` (free a chunk). This is the accumulated, LOD'd world.
- **Live overlay** — the **existing client ring buffer, reused unchanged**, fed by the current
  batch-oriented `chunk_update` deltas. Short-lived, bounded, renders the newest points instantly.

The live ring we already have *becomes* the overlay; 2b only *adds* the base layer. A point briefly
appears in both while the sensor is actively scanning a region (overlay still holds it, base already
refreshed) → a transient, harmless density bump in exactly the active-scan area. A watermark-based
de-dup can remove even that later; not needed for v1.

#### Data model

- Level ladder: `fineVoxelMeters` (2a's 0.04) and `numLevels` (~6 → coarsest voxel ≈ 2.56 m ≈ one
  point per 2 m chunk). Level 0 = coarsest (potree convention), `Lmax` = finest = the 2a grid.
- **Levels are derived on demand from the fine voxel set, not persisted.** Resident chunk → derive
  from its in-memory voxels; resting chunk → read its fine `.bin` and derive. No pyramid files, so
  nothing to invalidate when fine data mutates — always current. A per-`(chunk,level)` cache is a
  later optimization if derivation cost shows up under many viewers.

#### Serving

Per **viewer**, the server tracks the last view and the level currently sent for each chunk. On a
throttled `viewer_view`:

1. Build camera + frustum from the message.
2. For each session chunk (use the stored AABB `min/max`), frustum-cull and range-cull; for
   survivors, pick a target level from projected voxel size — roughly
   `screenPx ≈ voxelSize / distance · viewportH / (2·tan(fovY/2))`, choose the level giving ~1–2 px.
3. Diff against per-viewer sent-state: newly visible or level changed → send `chunk_lod` + payload;
   left frustum/range → send `chunk_drop`. Update sent-state.

The viewer also frustum-culls per object (cheap draw-call reduction); the server cull is about
**bandwidth** (don't ship far chunks), the viewer cull about **draw cost**.

Live base freshness: when new points fuse into a chunk, mark it dirty for viewers holding it and
re-send at their current level, coalesced/throttled. The live overlay masks base staleness in the
meantime, so v1 can start with a simple periodic "re-send changed visible chunks" pass.

#### Protocol additions (`protocol.ts`)

```ts
// client → server, throttled (~5–10 Hz) on camera settle
interface ViewerViewMessage {
  type: 'viewer_view';
  session_id: string;
  position: [number, number, number];      // camera, world frame
  forward: [number, number, number];       // view direction
  up: [number, number, number];
  fov_y_rad: number;
  viewport_px: [number, number];           // width, height
  near_m: number; far_m: number;
}

// server → client — evolves chunk_bootstrap: now carries chunk_key + level so the
// viewer can key a GPU buffer per chunk and replace/drop it. Binary payload follows.
interface ChunkLodMessage {
  type: 'chunk_lod';
  session_id: string;
  chunk_key: string;
  level: number;
  point_count: number;
  point_format: string;
  stride_bytes: number;
}
interface ChunkDropMessage {
  type: 'chunk_drop';
  session_id: string;
  chunk_key: string;
}
```

#### Implementation ladder

Each rung is independently reviewable and (for the server logic) unit-testable:

- **2b-1 — LOD derivation (server, no protocol change).** `ChunkStore.deriveChunkLevel(sessionId,
  chunkKey, level)`: mean-bin the fine voxels to a coarser grid (resident or from disk). Test:
  coarser level has ≤ fine count, representatives are child-voxel means, bounds preserved, nesting
  is exact. Pure and fully testable — the foundation.
- **2b-2 — level ladder + selection math (server).** `numLevels`, per-chunk `selectLevel(aabb,
  camera)` screen-space projection, frustum/range tests. Test: near→fine, far→coarse, monotonic.
- **2b-3 — protocol + `viewer_view` plumbing.** Add the three messages; server keeps per-viewer
  sent-state and emits `chunk_lod`/`chunk_drop` diffs; replace the eager full-bootstrap with
  view-driven serving (send coarsest in-range as a default until the first `viewer_view` arrives).
- **2b-4 — viewer base layer.** Per-chunk GPU buffers keyed by `chunk_key`; handle `chunk_lod`
  (replace) / `chunk_drop` (dispose); send `viewer_view` on camera settle. Live overlay unchanged.
- **2b-5 — live base refresh.** Periodic re-send of changed visible chunks at each viewer's level.

## Status / recommendation

- **2a — done.** Voxel fusion landed; density bounded; serving path unchanged.
- **2b — designed above.** Decisions made: **mip-per-chunk** (not additive octree) for
  mutability + simplicity, and a **two-layer viewer** (LOD base + reused live-ring overlay). Build
  the ladder 2b-1 → 2b-5; the first two rungs are pure server logic and make good standalone tasks.

## Open questions

- Fuse color/intensity by mean, or keep most-recent (freshness vs. denoising)? Default mean.
- Retire the client ring buffer once the base layer exists, or keep it as the live overlay?
  Current plan: **keep it** as the overlay (Decision 2).
- Voxel size / `numLevels` per session vs. global default — room-scale vs. building-scale want
  different bases.
- Draw-call ceiling: one `THREE.Points` per chunk is simplest but caps at ~1–2k chunks; move to a
  slab allocator (shared geometry, managed sub-ranges) if the count bites.
