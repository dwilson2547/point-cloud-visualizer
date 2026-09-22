# Range-image ingest — measured, not adopted

A proof of concept for option D of [`decisions/0007`](./decisions/0007-quantised-negotiated-wire-formats-over-laz-or-draco-for-stre.md)
("range-image ingest with an image/video codec"), which that decision kept on the list and
[`architecture.md`](./architecture.md) still carries as a deferred stretch goal. This records what
was measured, what it costs, and the three things that are still unknown. **No decision follows
from it yet** — in particular the deskew prerequisite 0007 named is still unmeasured.

Code: `scripts/spike-range-image.ts` and `public/spike-webcodecs.html` on branch
`spike/range-image-codec` (`eb75d5d`, `9d2580e`), pushed to origin. Throwaway by intent; the
numbers below are the part worth keeping.

## The sensor already produces a range image

A spinning lidar's native output *is* a 2D image: one row per laser, one column per azimuth step.
[`src/vlp16-packet.ts`](../src/vlp16-packet.ts) receives exactly that —
`(laserIndex, azimuth, distanceRaw @ 2 mm, intensity)` — and discards the grid at the
spherical-to-cartesian step, after which every point must carry its own coordinates.

Keeping the grid instead means the wire payload is an image, and reconstruction on the far side is
a table lookup per pixel with no per-point metadata at all: row index gives elevation, column index
gives azimuth, pixel value gives range. That property is what makes the whole idea cheap, and it
was confirmed end to end in a browser (below).

## What was measured

Synthetic room (six boxes, an inside-out room shell), 16 × 1800 grid, 40 spins at 10 Hz, sensor on
a slow yawing circle. Baseline is the current wire format: `xyzi_q4_v2` at 7 B/point plus
permessage-deflate level 1, per [`protocol-v1.md`](./protocol-v1.md).

**Baseline: 121.2 KB/spin** (28,800 points) — *verified, synthetic scene*.

| config | bytes/spin | vs base | RMSE | max err | enc/spin | H.264 profile |
|---|---|---|---|---|---|---|
| `x264-8bit-lossless` | 1.3 KB | **91.4×** | 45.2 mm | **78 mm** | 1.5 ms | High 4:4:4 |
| `x264-8bit-qp1-High` | 1.5 KB | 82.2× | 48.0 mm | 364 mm | 1.6 ms | High |
| `x264-8bit-crf18` | 328 B | 378.5× | 92.6 mm | **2356 mm** | 1.7 ms | High |
| `x265-8bit-lossless` | 1.9 KB | 64.4× | 45.2 mm | 78 mm | 4.8 ms | Rext |
| `x264-msb-lsb-lossless` | 12.4 KB | 9.8× | **0.0 mm** | **0 mm** | 2.5 ms | High 4:4:4 |
| `x264-msb-lsb-qp1-High` | 12.4 KB | 9.8× | 53.4 mm | 1026 mm | 2.5 ms | High |
| `x264-msb-lsb-INTRA-only` | 14.4 KB | 8.4× | 0.0 mm | 0 mm | 2.4 ms | High 4:4:4 Intra |
| `ffv1-gray16-lossless` | 8.3 KB | 14.5× | 0.0 mm | 0 mm | 1.9 ms | not browser-decodable |

Error is measured by decoding each stream back and comparing to ground truth in millimetres, over
returned points only, counting points destroyed by the `0 = no return` sentinel. **A ratio without
a max-error column is meaningless here** — see finding 3.

Encode cost is 1.5–2.7 ms/spin against the 22 ms p50 ingest budget from
[`decisions/0003`](./decisions/0003-ingest-bench-p50-22-ms-per-vlp-16-spin.md) — *verified, but
single-process ffmpeg on this machine, not a server-embedded encoder*.

## Findings

**1. Inter-frame prediction buys almost nothing — 9.8× with a GOP vs 8.4× intra-only.** Only ~16%.
The sensor rotates, so the range image translates horizontally between spins and motion
compensation has little to hold onto. This matters more than the ratio: it means **every spin can
stay an IDR keyframe**, which preserves the per-batch independence the current protocol has. No GOP
state on the server, no mid-stream join problem, no keyframe request path. The feature that looked
like the main prize turns out to be the one worth giving up.

**2. WebCodecs accepts High 4:4:4 Intra.** This was the expected blocker: lossless x264 (`-qp 0`) is
forced into High 4:4:4, which most *hardware* decoders refuse, so "lossless" looked like it would
cost the browser path. It does not — `avc1.f41016` reported supported and decoded 40/40 frames, and
plain High (`avc1.641016`) decodes too, so both ends of the precision tradeoff are open.
*Verified on Chromium via Playwright on this machine, 2026-09-22; not surveyed across browsers, and
whether 4:4:4 lands on hardware or a software fallback was not determined.*

**3. Lossy video on range data fails at the edges, and the mean hides it.** `crf18` looks
spectacular at 378× until the tail is checked: **2356 mm max error** and 662 points annihilated by
the no-return sentinel. Even `qp=1` gives 364 mm. A range image is almost entirely depth
discontinuities, and ringing at those is unbounded. RMSE stays respectable (92.6 mm) throughout,
which is exactly why it must not be the reported statistic.

**4. Sort rows by elevation, not firing order.** Free 3–30% (largest on FFV1: 14.5× vs 11.2×). The
VLP-16 fires its 16 lasers interleaved (`-15, 1, -13, 3, …`), so the natural row order destroys the
vertical correlation a codec depends on.

## Precision versus decodability

The MSB/LSB split (range's high byte in one 8-bit plane, low byte in another) is the only way to
carry full 2 mm precision through an 8-bit codec, and it fails for an instructive reason: the two
planes have wildly different error tolerance. **One step of MSB error is 512 mm; one step of LSB
error is 2 mm.** So any lossy mode corrupts the MSB plane catastrophically — the 1026 mm max error
on `msb-lsb-qp1-High` is almost exactly two MSB steps. Exact MSB coding requires lossless, which
requires High 4:4:4.

That leaves a clean choice rather than a compromise:

- **91× at ≤78 mm bounded error** (`x264-8bit-lossless`). The error is pure 8-bit quantisation of
  the range span, with zero codec error on top, so it is a hard bound rather than a tail. At the
  20 m span used for the browser export the step halves to ~39 mm. The store voxel-fuses at 4 cm,
  so this is at or below the voxel it gets rounded into anyway.
- **9.8× bit-exact** (`x264-msb-lsb-lossless`), if the raw log must stay lossless — and
  [`decisions/0002`](./decisions/0002-append-only-batch-log-is-the-durability-anchor-chunk-files-a.md)
  keeps raw batches precisely because fusion is destructive and later pose correction needs them.

That tension is the real decision, and it is not made here: the 91× path is lossy *before* the log,
which is a different thing from lossy after it.

## Traps

Three, each of which produced a confident wrong answer first:

- **ffmpeg silently substitutes `yuv420p` for `gray`** when the x264 build lacks i400/monochrome
  support, and the limited-range 16–235 squeeze introduced ~2 m of error while still reporting a
  plausible 86× ratio. `yuvj420p` (full-range) round-trips the Y plane exactly and is still ordinary
  H.264 to a decoder. The FFV1 control being exact at 0.0 mm is what exposed it — **keep a
  known-lossless config in any codec comparison purely as a tripwire.**
- **Scanning Annex-B byte by byte double-counts start codes**: `00 00 00 01` also matches the 3-byte
  `00 00 01` one byte later. That yielded a 1-byte leading access unit and a decoder insisting it
  had never been given a keyframe. Test the 4-byte code first and step past whatever matched.
- **Lossless forces the profile.** `-qp 0` is what pushes x264 into High 4:4:4; there is no lossless
  mode within plain High.

## Not established

- ⚠ **The scene is synthetic** — six boxes and a room shell are far smoother than a real space, so
  the absolute ratios are optimistic. The comparisons *between* configs are the durable part. No
  real VLP-16 capture exists on this machine to check against.
- ⚠ **Deskew is still the blocker 0007 named.** Everything here assumes a clean `(ring, azimuth)`
  grid. [`vlp16-kiss-icp.md`](./vlp16-kiss-icp.md) records that only motion-model deskew is
  available with no IMU, and on real moving data the grid smears. The effect on ratio and on
  reconstruction error is **unmeasured**, and it gates the whole idea.
- ⚠ **Latency was not measured.** The browser figure (44.8 ms/spin) submits all 40 access units at
  once, so it is dominated by queueing and is a throughput bound, not a latency number. It clears
  10 Hz with room; it should not be quoted as latency.
- The serve path is untouched by this. A range image is sensor-space and per-spin; by serve time
  the data is world-space fused chunks with no ring/azimuth structure left, so this applies to
  **ingest only**.

## Next

1. Measure on a real captured spin sequence, with deskew, before anything else. Until then the
   ratios are a lower bound on difficulty, not an upper bound on payoff.
2. If it survives that, the shape of the change is specced in
   [`range-image-format-spec.md`](./range-image-format-spec.md) — `range_h264_v1` as a third
   negotiated `point_format`, decoded at the ingest boundary, with fusion, store and serve
   untouched.
3. The lossy-before-the-log question needs answering first, since it conflicts with `0002`.
