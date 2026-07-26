---
tier: project
domain: tools
status: design
---

# point-cloud-visualizer

A Potree-based point cloud visualization and streaming backend project for accepting client-produced
point clouds plus pose/odometry updates, persisting a mutable world model, and serving both
real-time updates and static viewer-friendly snapshots.

## Goals

- Accept live client streams of point batches plus pose/odometry.
- Persist a room- or site-scale point cloud that updates over time.
- Support low-latency viewer updates without rebuilding the entire dataset for every change.
- Reuse Potree where it helps, while keeping the backend free to evolve beyond Potree's static
  dataset assumptions.
- Track recordings by negotiated session ID so multiple capture sessions can be persisted and
  resumed cleanly.

## Initial direction

The current direction is a hybrid architecture:

1. **Ingest** client-provided point batches, pose/odometry, and session metadata over a streaming
   API.
2. **Fuse** updates into a mutable spatial store on the server.
3. **Serve** live chunk/delta updates to clients.
4. **Publish** periodic static snapshots in a Potree-friendly format for cold-start and archival.

This keeps Potree useful as a visualization layer while avoiding the need to treat its static octree
format as the live source of truth.

For the first version, the backend does **not** assume responsibility for SLAM or Point-LIO style
pose estimation. Clients are expected to provide already-registered points and updated pose data.
Direct sensor-to-server ingestion can remain a stretch goal.

## Project docs

- [`docs/architecture.md`](docs/architecture.md) — initial backend and viewer architecture
- [`docs/protocol-v1.md`](docs/protocol-v1.md) — draft WebSocket ingest protocol for v1
- [`docs/vlp16-client.md`](docs/vlp16-client.md) — recommended Velodyne VLP-16 publisher setup
- [`docs/vlp16-kiss-icp.md`](docs/vlp16-kiss-icp.md) — IMU-free moving VLP-16 trial with KISS-ICP
- [`docs/vlp16-moving-odometry.md`](docs/vlp16-moving-odometry.md) — ESP32/BMI088 + Point-LIO design
- [`docs/vlp32-client.md`](docs/vlp32-client.md) — first-pass Velodyne VLP-32 publisher setup
- [`docs/notes/README.md`](docs/notes/README.md) — atomic project notes index

## Current scaffold

The repository now includes a first-pass TypeScript server with:

- `GET /healthz` for health and protocol metadata
- `GET /storage` for chunk-store summary
- `GET /sessions` for restored and active session summaries
- `GET /sessions/:sessionId/chunks` for persisted chunk metadata
- `WS /ws/ingest` for publisher connections
- `WS /ws/view` for viewer connections
- SQLite-backed session/chunk metadata under `data/metadata.sqlite`
- fused world-space `.bin` chunks plus exact accumulator `.acc` sidecars under `data/chunks/`
- session recovery from SQLite so persisted recordings remain viewable and resumable after restart
- atomic chunk-file replacement before `point_batch_ack`
- bounded dirty chunk buffers with flush-on-threshold, cache pressure, and session close
- bounded in-memory pose tracking
- live viewer fan-out of accepted point batches

This is still a scaffold, but storage is now disk-backed. The live write path partitions accepted
points into fixed world chunks, fuses them into bounded voxel representatives, and atomically
replaces touched chunk files while tracking metadata in SQLite.

## Quickstart

```bash
npm install
npm test
npm run build
./start.sh
```

The server listens on `http://localhost:8080` by default.

### Storage knobs

The chunk store is configurable by environment variables:

- `DATA_DIR` — root storage directory (default: `./data`)
- `CHUNK_SIZE_METERS` — world chunk edge length (default: `2`)
- `FLUSH_POINT_THRESHOLD` — flush a dirty chunk after this many buffered points (default: `50000`)
- `MAX_DIRTY_CHUNKS` — flush oldest dirty chunks when this cache size is exceeded (default: `128`)
- `MAX_CHUNKS_PER_BATCH` — reject a batch spanning more spatial chunks than this (default: `128`;
  cannot exceed the effective `MAX_DIRTY_CHUNKS` resident budget)
- `MAX_POINTS_PER_BATCH` — hard ingest batch limit (default: `1000000`)
- `MAX_RETAINED_POSES` — recent poses retained per active session (default: `64`)
- `MAX_VIEWER_BUFFERED_BYTES` — disconnect viewers that stop consuming before their outbound queue
  exceeds this limit (default: `33554432`)
- `LIVE_REFRESH_MS` — coalescing interval for refreshing changed LOD chunks (default: `500`)

`point_batch_ack` is sent only after every touched chunk has been atomically replaced and the
session sequence/counters have been persisted. Publishers should keep at most one point batch in
flight and wait for its ACK before sending the next. After a server restart, a resumed publisher
must send a fresh `pose_update` before its next point batch.

Node 22 currently exposes `node:sqlite` as an experimental API, so test runs and server startup may
print an experimental warning while using the built-in SQLite-backed metadata store.

## Velodyne clients

The recommended bring-up path is now the **VLP-16** client:

```bash
npm run client:vlp16 -- \
  --calibration-file ./vlp16-calibration.json \
  --session-id vlp16-room-a-001
```

The repo also still includes a first-pass `client:vlp32` path if you want to revisit the older
sensor later.

See [`docs/vlp16-client.md`](docs/vlp16-client.md) for the preferred starting setup and required
calibration JSON shape.

For moving tests before the external IMU is ready, use the standalone
[KISS-ICP publisher](docs/vlp16-kiss-icp.md).

## Runtime scripts

- `./start.sh` — starts the development server in the background and writes logs to `.runtime/server.log`
- `./stop.sh` — stops the background server using the recorded PID

## Nearby references

- Workspace Potree checkout: [`../potree/`](../potree/)
