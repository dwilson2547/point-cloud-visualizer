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

### `point_batch_ack`

Sent by the server after a batch has been validated, fused into its touched chunks, atomically
written to chunk files, and committed to persisted session sequence state. The current server
therefore treats this as a process-restart-safe acceptance boundary.

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
  persisted server sequence

This gives the server a deterministic resume point and avoids ambiguity during reconnects.

## Viewer messages

The viewer protocol can stay simpler than the ingest protocol in v1. The minimum useful messages
are:

- `viewer_join`
- `viewer_session_state`
- `chunk_update`
- `snapshot_ready`
- `error`

The server should be free to send chunk-level updates in whatever internal representation best fits
the first backend implementation, as long as the ingest contract remains stable.

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
- compressed point payloads
- multi-publisher consistency guarantees beyond per-session ordering
- mutable historical rewrites of previously accepted batches
