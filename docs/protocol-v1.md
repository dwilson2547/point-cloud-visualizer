# Protocol v1

## Status

Draft protocol for the first implementation of the live ingest and viewer update path.

## Scope

Version 1 is intentionally narrow:

- transport is **WebSocket**
- clients are authoritative for **pose/odometry**
- clients send **point batches**
- each point carries **XYZ + RGB + intensity**
- sessions are explicitly created or resumed with a **session ID**

This protocol is designed for browser clients and native publishers. It does not require gRPC-Web
or a proxy layer in the first pass.

## Transport

- **Protocol:** WebSocket
- **Direction:** bidirectional
- **Encoding:** JSON control messages plus binary point-batch frames

Recommended endpoint shape:

```text
ws://<host>/ws/ingest
ws://<host>/ws/view
```

`/ws/ingest` is for publishers. `/ws/view` is for viewers. A single endpoint could support both
later, but separate roles keep v1 simpler.

## Session model

A session represents one logical recording or mapping run. Sessions allow the server to:

- group incoming data
- track publisher progress
- resume interrupted uploads
- persist multiple recordings independently

### Session lifecycle

1. Client connects to `/ws/ingest`
2. Client sends `create_session` or `resume_session`
3. Server replies with `session_ack`
4. Client streams `pose_update` and `point_batch`
5. Client optionally sends `close_session`
6. Server marks the session closed or idle

### Session fields

| Field | Type | Notes |
|---|---|---|
| `session_id` | string | Globally unique recording identifier |
| `publisher_id` | string | Publisher identity within the session |
| `project_id` | string? | Optional logical grouping |
| `site_id` | string? | Optional site/building identifier |
| `room_id` | string? | Optional room identifier |
| `started_at` | string | RFC 3339 timestamp |
| `frame_id` | string | Human-readable frame label, e.g. `map` |
| `units` | string | v1 requires `meters` |
| `sequence` | uint64 | Monotonic message sequence for resume/order |

## Coordinate conventions

v1 requires a single explicit convention per session:

- units are **meters**
- coordinates are **right-handed**
- timestamps are **RFC 3339** or Unix nanoseconds, chosen consistently by implementation
- points in a `point_batch` are expressed in the publisher's local sensor frame
- the accompanying pose places that batch into the session/world frame

If the client already has world-frame points, it may send an identity local transform and a
world-frame pose.

## Message types

All control messages are JSON objects with a top-level `type`.

### `create_session`

Sent by a client to start a new recording session.

```json
{
  "type": "create_session",
  "protocol_version": 1,
  "session_id": "scan-room-a-001",
  "publisher_id": "scanner-rig-01",
  "started_at": "2026-07-10T00:00:00Z",
  "frame_id": "map",
  "units": "meters",
  "metadata": {
    "project_id": "hq-demo",
    "site_id": "office-1",
    "room_id": "conference-a"
  }
}
```

### `resume_session`

Sent by a client to continue an existing session after reconnect or process restart.

```json
{
  "type": "resume_session",
  "protocol_version": 1,
  "session_id": "scan-room-a-001",
  "publisher_id": "scanner-rig-01",
  "last_client_sequence": 1842
}
```

### `session_ack`

Sent by the server in response to `create_session` or `resume_session`.

```json
{
  "type": "session_ack",
  "session_id": "scan-room-a-001",
  "accepted": true,
  "server_sequence": 1839,
  "resume_from_sequence": 1840,
  "viewer_endpoint": "/ws/view?session_id=scan-room-a-001"
}
```

If the session cannot be created or resumed, the server should send `error`.

### `pose_update`

Sent by the client when pose changes independently of a point batch, or to establish the current
transform before subsequent batches.

```json
{
  "type": "pose_update",
  "session_id": "scan-room-a-001",
  "publisher_id": "scanner-rig-01",
  "sequence": 1840,
  "timestamp": "2026-07-10T00:00:01.234Z",
  "pose": {
    "translation_m": [1.25, -0.44, 0.91],
    "rotation_xyzw": [0.0, 0.0, 0.3826834, 0.9238795]
  }
}
```

v1 uses a full 6DOF pose per update. Incremental odometry can be added later, but is not required
for the first pass.

### `point_batch_header`

Sent as JSON immediately before a binary batch payload.

```json
{
  "type": "point_batch_header",
  "session_id": "scan-room-a-001",
  "publisher_id": "scanner-rig-01",
  "sequence": 1841,
  "timestamp": "2026-07-10T00:00:01.250Z",
  "pose_sequence": 1840,
  "point_count": 32768,
  "point_format": "xyz_rgb_i_v1",
  "encoding": "binary_le",
  "compression": "none",
  "stride_bytes": 18,
  "bounds_local": {
    "min": [-1.2, -0.8, 0.4],
    "max": [1.3, 0.9, 3.2]
  }
}
```

The next WebSocket frame after this header is the binary payload for the batch.

### Binary point layout: `xyz_rgb_i_v1`

Each point is packed little-endian as:

| Field | Type | Bytes |
|---|---|---|
| `x` | float32 | 4 |
| `y` | float32 | 4 |
| `z` | float32 | 4 |
| `r` | uint8 | 1 |
| `g` | uint8 | 1 |
| `b` | uint8 | 1 |
| `intensity` | uint16 | 2 |
| padding | uint8[1] | 1 |

Total: **18 bytes**

The v1 layout includes one pad byte so the layout can be extended or aligned more predictably in
some implementations. If alignment pressure disappears in implementation, this can be revised before
code is published as stable.

### Binary point layout: `xyzi_q4_v2` (ingest)

A quantised ingest format for lidar publishers, negotiated per batch through `point_format` and
`stride_bytes` (defined in `src/point-formats.ts`):

| Field | Type | Bytes |
|---|---|---|
| `x`, `y`, `z` | int16 each, sensor frame, in 4 mm steps (±131 m) | 6 |
| `intensity` | uint8 | 1 |

Total: **7 bytes**, 2.6× smaller than v1. It carries no colour; the server fuses it with r = g = b =
intensity. The batch log stores the payload as sent, so the saving applies to disk as well as the
wire, and the store decodes at fuse time. Both formats stay accepted; the KISS-ICP publisher and the
demo publisher default to this one.

### Binary point layout: `q8_chunk_v2` (serve)

A viewer connecting with `?fmt=q8_chunk_v2` receives `chunk_lod` and `chunk_delta` payloads as:

| Field | Type | Bytes |
|---|---|---|
| `x`, `y`, `z` | uint8 each, relative to the chunk origin in steps of `chunk_size / 256` | 3 |
| `r`, `g`, `b` | uint8 | 3 |
| `intensity` | uint8 | 1 |

Total: **7 bytes**. The message carries `origin` and `quantum`; the viewer reconstructs cell
centres. With a 2 m chunk the step is 7.8 mm, below the 4 cm fusion voxel, so nothing visible is
lost. Without `fmt` the server keeps sending `xyz_rgb_i_v1`.

### Compression

Both WebSocket endpoints offer permessage-deflate (level 1, no context takeover; `WS_DEFLATE=0`
disables it). Browsers, `ws` and the Python `websockets` library negotiate it by default. Measured
on the synthetic room at VLP-16 density, deflate takes the quantised streams a further 1.5–2×; on
the float formats it was worth about 1.6×.

### `point_batch_ack`

Sent by the server after a batch has been validated, appended and fsynced to the session's batch
log, and fused into the resident chunk cache. The log is replayed at startup, so the current server
treats this as a process-restart-safe acceptance boundary without waiting for chunk files.

```json
{
  "type": "point_batch_ack",
  "session_id": "scan-room-a-001",
  "sequence": 1841,
  "accepted_points": 32768,
  "rejected_points": 0
}
```

### `snapshot_ready`

Sent by the server when a new persisted snapshot or export is available.

```json
{
  "type": "snapshot_ready",
  "session_id": "scan-room-a-001",
  "snapshot_id": "scan-room-a-001-0003",
  "format": "potree",
  "uri": "/snapshots/scan-room-a-001-0003/"
}
```

### `close_session`

Sent by the client when it is done publishing for now.

```json
{
  "type": "close_session",
  "session_id": "scan-room-a-001",
  "publisher_id": "scanner-rig-01",
  "sequence": 1842
}
```

### `error`

Sent by the server when it rejects a request or detects a protocol violation.

```json
{
  "type": "error",
  "code": "sequence_conflict",
  "message": "Expected sequence 1840, received 1838",
  "session_id": "scan-room-a-001",
  "retryable": true
}
```

## Ordering rules

- Every ingest message after session creation carries a monotonic `sequence`
- The server may reject duplicate or out-of-order messages
- `pose_update` and `point_batch_header` are independently sequenced in the same session stream
- A `point_batch_header` references the pose to use via `pose_sequence`
- A publisher keeps at most one point batch in flight and waits for `point_batch_ack` before sending
  another batch
- After `resume_session`, the publisher sends a fresh `pose_update`; old pose bodies are not retained
  across server restarts
- `last_client_sequence` may trail the server when an ACK was lost, but it may not be ahead of the
  persisted server sequence; publishers should send their last *acked batch* sequence, since a
  `pose_update` accepted just before a crash may not have been persisted

This gives the server a deterministic resume point and avoids ambiguity during reconnects.

## Viewer messages

A viewer connects to `/ws/view?session_id=<id>[&lod=1][&fmt=<served format>]`. Without `lod=1` it
is a *plain* viewer: it receives `viewer_session_state`, a `chunk_bootstrap` per persisted chunk
(the whole accumulated cloud, 18-byte world-frame points) and every `chunk_update`. With `lod=1` it
is an *LOD* viewer and drives its own base layer with `viewer_view`. `snapshot_ready` from the
original draft was never implemented.

Client → server:

- `viewer_join { session_id }` — alternative to the query parameter.
- `viewer_view { session_id, position, forward, up, fov_y_rad, viewport_px, near_m, far_m,
  filter?, overlay?, overlay_max_points? }` — sent on camera settle (the web viewer throttles to
  ~5 Hz; the server ignores anything within 100 ms of the last). `filter` is the observation
  filter `{ min_hits, min_ratio }` ([`observation-filter.md`](./observation-filter.md)).
  `overlay: false` turns the live overlay off for this viewer; `overlay_max_points` caps it per
  batch (0 = uncapped).

Server → client (a binary payload follows each of `chunk_bootstrap`, `chunk_update`, `chunk_lod`
and `chunk_delta`):

- `viewer_session_state` — counters at join.
- `chunk_update` — one accepted batch in the publisher's wire format, local frame, with the pose
  it was fused with (corrected if corrections are installed). For an LOD viewer it is culled per
  point to the viewer's frustum and decimated to its cap; a batch with nothing in view is not sent.
- `chunk_lod { chunk_key, level, version, point_count, point_format, stride_bytes, origin?,
  quantum? }` — a keyframe: replace this chunk with these points at this level.
- `chunk_delta { … same fields … }` — append these points to the chunk the viewer holds.
- `chunk_drop { chunk_key }` — the chunk left the view; free it.
- `session_rebuilt { batches, chunks }` — pose corrections changed; drop everything and re-request.
- `error`.

The base layer is served in `xyz_rgb_i_v1` unless the viewer asked for `q8_chunk_v2`.

## HTTP

- `GET /healthz`, `GET /storage`, `GET /sessions` (each session includes `log` counters),
  `GET /sessions/:id/chunks` (persisted chunks with hit/opportunity counters).
- `GET /sessions/:id/log` — the raw batch log; `Range: bytes=N-` for tailing, 416 when nothing new.
- `GET | PUT | DELETE /sessions/:id/pose-corrections`, `POST /sessions/:id/rebuild` — the
  alignment layer ([`alignment.md`](./alignment.md)).

## Validation rules

The server should reject or flag:

- unknown `protocol_version`
- missing `session_id`
- invalid `point_count`
- invalid binary payload size for the declared format
- non-monotonic sequence numbers
- unknown referenced `pose_sequence`
- unsupported `units`
- NaN or infinite coordinates
- invalid or non-normalized pose quaternions
- unsafe session or publisher identifiers
- batches exceeding the configured point limit
- batches spanning more than the configured spatial chunk limit
- invalid viewer camera/FOV/viewport ranges
- an observation filter outside `min_hits ≥ 1`, `0 ≤ min_ratio ≤ 1`, or a negative overlay cap
- an unknown served format on the viewer upgrade

## Flow control

Publishers use the ACK as their backpressure signal and keep one batch in flight. Viewers that stop
consuming data are disconnected with WebSocket close code `1013` before the configured outbound
buffer limit is exceeded; they may reconnect and reconstruct the current base layer from persisted
chunks.

## Deferred items

Explicitly out of scope for protocol v1:

- gRPC or gRPC-Web transport
- server-side SLAM / Point-LIO
- loop closure and pose graph correction
- ~~compressed point payloads~~ — quantised formats and permessage-deflate, above
- multi-publisher consistency guarantees beyond per-session ordering
- mutable historical rewrites of previously accepted batches
