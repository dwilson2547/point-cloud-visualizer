# `range_h264_v1` — proposed ingest format

**Status: proposed, nothing implemented.** Everything below is *planned*; the only measured claims
are in [`range-image-ingest.md`](./range-image-ingest.md), and the deskew prerequisite from
[`decisions/0007`](./decisions/0007-quantised-negotiated-wire-formats-over-laz-or-draco-for-stre.md)
is still unmeasured. This exists so the shape of the change is known before that question is
answered, not to authorise building it.

A third **point format**, not a third transport. `point_format` is already negotiated per batch
([`protocol-v1.md`](./protocol-v1.md) § `point_batch_header`), and the Iggy inlet carries batch-log
records that include it (`decisions/0009`), so one new format reaches **both** inlets with no new
path. A publisher that never names it is unaffected.

## Two streams per batch, because colour and geometry are not alike

One batch = one spin = **two** H.264 access units, Annex-B framed, both always IDR: a lossless
*geometry* stream and an optional, lossy *colour* stream.

Splitting them is the whole design, and it is the same asymmetry the MSB/LSB result exposed. A
2 mm error in geometry is a wrong measurement; a 2% error in colour is invisible. Coding them
together forces colour up to lossless — roughly tripling the payload to carry the channel that
tolerates loss best — and forces geometry down to whatever colour can survive. Kept apart, each
gets the treatment it wants and colour costs a fraction of geometry.

### Geometry stream (required, lossless)

A grid of `R` rings × `A` azimuth bins, three 8-bit planes stacked vertically into one `A × 3R`
luma image:

| rows | plane | meaning |
|---|---|---|
| `0 .. R-1` | range MSB | `distanceRaw >> 8` |
| `R .. 2R-1` | range LSB | `distanceRaw & 0xff` |
| `2R .. 3R-1` | intensity | as reported by the sensor |

`distanceRaw` is the sensor's native unit — 2 mm for the VLP-16, matching
[`src/vlp16-packet.ts`](../src/vlp16-packet.ts) — so the format is **bit-exact to what the sensor
said**, and strictly more faithful than `xyzi_q4_v2`, which quantises to a 4 mm *cartesian* grid.
`distanceRaw == 0` means no return, the same sentinel the VLP-16 packet uses; lossless coding
preserves it exactly.

`3R` is even whenever `R` is, which yuv420p requires: VLP-16 → 1800×48, VLP-32 → 1800×96.

### Colour stream (optional, lossy)

An `A × R` image — one sample per point, same grid, same row order — carrying RGB as ordinary
`yuv420p`. Unlike geometry this is a *natural image* and should be coded like one: chroma
subsampling is appropriate (adjacent samples are spatially adjacent points), and a normal quality
target such as `-crf 20` is fine. Lossy colour cannot corrupt a position, which is the point of
keeping it in its own stream.

`R` must be even for yuv420p; for an odd ring count pad one duplicate row and drop it on decode.

Colour is **optional and absent by default**: a bare VLP-16 has none. When the stream is absent the
server does what `xyzi_q4_v2` does today and fuses grey from intensity, so nothing downstream
changes. When present, it lands directly in the `r`, `g`, `b` bytes the internal 18-byte layout
already carries — colour is not a new concept anywhere past the ingest boundary, it is only the
current quantised ingest format that drops it.

Sources are a paired camera or a colourising sensor, so this stays specced-but-unbuilt until there
is one on the rig.

### Payload container

The batch payload is the two access units with a small fixed header, so one binary frame still
carries one batch:

| offset | field |
|---|---|
| 0 | magic `RIV1` (4 B) |
| 4 | `geometry_bytes` u32le |
| 8 | `colour_bytes` u32le — `0` when absent |
| 12 | geometry access unit |
| … | colour access unit |

### Encoder settings (non-negotiable parts of the format)

- Geometry: `-qp 0` (lossless), `-pix_fmt yuvj420p`, `-g 1`, `-bf 0`.
- Colour: `-crf 20` (tunable), `-pix_fmt yuv420p`, `-g 1`, `-bf 0` — lossy on purpose.
- **yuvj420p, not gray**: ffmpeg silently substitutes `yuv420p` for `gray` where libx264 lacks
  i400, and the limited-range 16–235 squeeze corrupts range by metres. See
  [`notes/ffmpeg-silently-swaps-gray-for-yuv420p-and-corrupts-range-da.md`](./notes/ffmpeg-silently-swaps-gray-for-yuv420p-and-corrupts-range-da.md).
- Lossless forces **High 4:4:4 Intra**; any decoder chosen must support it.
- Rows within each plane are ordered **by elevation, ascending** — not firing order. Worth 3–30%,
  measured.

Every access unit being an IDR is load-bearing, not incidental: it costs ~16% (measured) and buys
independent replay of any batch from the log, tolerance of gaps on the at-least-once Iggy inlet,
and no decoder state carried across batches.

## Session-scoped geometry

The grid is constant for a session, so it does **not** belong in the per-batch header. A
`sensor_profile` block is added to `create_session`, persisted by `session-store` and restored on
`resume_session`:

```json
{
  "type": "create_session",
  "sensor_profile": {
    "kind": "spinning_lidar",
    "rings": 16,
    "azimuth_bins": 1800,
    "distance_scale_m": 0.002,
    "elevations_deg": [-15, -13, -11, -9, -7, -5, -3, -1, 1, 3, 5, 7, 9, 11, 13, 15],
    "codec": "h264",
    "plane_layout": "msb_lsb_intensity",
    "colour": {
      "present": false,
      "codec": "h264",
      "pix_fmt": "yuv420p",
      "source": "none"
    }
  }
}
```

`session_ack` must be able to **reject** it: a server with no 4:4:4-capable decoder has to say so,
rather than failing per batch forever. Add `accepted_formats` to `session_ack` so the publisher can
fall back to `xyzi_q4_v2` at session start.

## Per-batch header

```json
{
  "type": "point_batch_header",
  "point_format": "range_h264_v1",
  "encoding": "annexb",
  "stride_bytes": 0,
  "point_count": 27431,
  "compression": "none"
}
```

- `stride_bytes: 0` — the payload is not an array of points. Every consumer that calls
  `ingestStride()` must be gated on this.
- `point_count` is the publisher's count of non-zero cells, validated by the server after decode;
  a mismatch is an `error`, not a silent accept.
- `compression: "none"` — the codec *is* the compression; permessage-deflate must **not** be
  applied on top (it will expand an already-entropy-coded payload).
- Whether a colour stream is present is session-scoped (`sensor_profile.colour.present`), but
  `colour_bytes == 0` in the container is always legal, so a publisher may drop colour for
  individual spins (dropped camera frame, exposure change) without renegotiating.
- `bounds_local` is computed server-side after decode rather than sent, since the publisher would
  have to project the whole grid to produce it.

## What this breaks, and the fix

This is the part that matters for the implementation estimate. Three functions in
[`src/point-formats.ts`](../src/point-formats.ts) assume a fixed-stride array of points:

- **`toInternalPoints()` is synchronous.** H.264 decode is not, or at minimum needs a decoder
  instance held per session. Either it gains an async variant, or the decode happens one level up
  and `toInternalPoints` is never called for this format. The latter is cleaner — decode at the
  ingest boundary, hand the 18-byte buffer onward, and nothing downstream learns a new format.
- **`worldPositions()` and `selectRows()` cannot operate on the wire payload.** Today the live
  overlay forwards ingest rows to viewers *unchanged* and culls by copying rows
  (`decisions/0008`). A compressed frame cannot be row-sliced. For this format the overlay path
  must cull on the decoded internal buffer and serve `q8_chunk_v2` or `xyz_rgb_i_v1` as usual.

**Consequence: the bandwidth saving applies to the ingest leg and the log, not to the overlay leg.**
The log stores the access unit as sent, so the saving reaches disk exactly as `xyzi_q4_v2`'s does —
and replay decodes, which the all-IDR rule makes safe at any offset.

Fusion, chunk store, LOD selection, serving and the viewer are untouched. They keep seeing the
same 18-byte rows they see today.

## Build order

1. **Measure deskew on a real capture first.** Everything here assumes a clean `(ring, azimuth)`
   grid; `vlp16-kiss-icp.md` records motion-model deskew only, no IMU. If the grid smears under
   real motion this format is not worth building.
2. Pick and benchmark a Node decoder with High 4:4:4 support — ffmpeg subprocess with a
   *persistent* pipe, a native binding, or WASM. Per-frame process spawn will not fit the 22 ms
   budget from `decisions/0003` on startup cost alone.
3. `sensor_profile` + `accepted_formats` negotiation, with the server rejecting cleanly when it
   cannot decode.
4. Encoder in the publishers: straightforward in the Python KISS-ICP client, a new dependency in
   the TypeScript VLP-16/32 clients.
5. Gate `ingestStride()` callers, then wire the decode boundary.
6. Colour last, and only once a colour source exists on the rig — the container reserves room for
   it so adding it later is not a format break.

## Open question this does not settle

The 91× variant in the PoC is **lossy before the log**, which conflicts with `decisions/0002`
keeping raw batches because fusion is destructive and later pose correction needs them. This spec
takes the bit-exact 9.8× path for that reason. If the 91× path is ever wanted, it needs its own
decision about what "raw" means, not a quiet format change.
