# Batch log — the durability anchor

Ingest durability moved from per-batch chunk rewrites to an append-only per-session log of raw
batches. Fused chunk files are now a cache derived from that log. This note records why, the on-disk
layout, the recovery rules, and what the log makes possible next.

Realizes [`architecture.md`](./architecture.md) §3 ("the live store should be the system of
record") in a way that keeps the raw observations, which the earlier fused-only layout threw away.

## Why

The earlier design acked a batch only after every touched chunk's `.bin` and `.acc` had been fully
rewritten, fsynced and renamed through a staged transaction directory. Measured with
`npm run bench:ingest` on this laptop (root ext4 SSD, `/tmp`), VLP-16-sized spins of 28,800 points
touching ~41 two-metre chunks each:

| Write path | Per-batch latency (p50 / p90) | fsyncs per batch |
|---|---|---|
| transaction-per-batch (before) | 780 ms / 883 ms | ~250 |
| batch log (after) | 22 ms / 39 ms | ~6 (1 for the log, the rest threshold flushes) |
| fusion only, no disk | 16–32 ms | 0 |

A VLP-16 produces a spin every 100 ms, so the old path sustained about one eighth of the sensor
rate and the blocking KISS-ICP publisher would have overflowed its UDP queue within seconds. The new
path is bounded by fusion CPU, not disk.

The second reason is architectural: voxel fusion is destructive (a point averaged into a world voxel
cannot be re-transformed later), so any server-side alignment work — scan-to-map refinement, pose
graph and loop closure, cross-session registration — needs the raw batches and the poses they were
registered with. The log is exactly that record.

## Layout

```
data/
  metadata.sqlite            sessions (+ checkpoint_offset), chunks (+ applied_sequence); WAL mode
  log/<session_id>.log       append-only batch records, one per accepted point_batch
  chunks/<session_id>/
    <cx>_<cy>_<cz>.bin       fused representatives, 18-byte xyz_rgb_i_v1 world-frame points
    <cx>_<cy>_<cz>.acc       exact accumulator sums, 16-byte header + 64 bytes per voxel
```

### Log record

Little-endian, defined in `src/batch-log.ts`:

| Field | Bytes | Notes |
|---|---|---|
| magic `PCVL` | 4 | `0x4C564350` |
| header length | 4 | JSON bytes |
| payload length | 4 | point bytes, `point_count × 18` |
| crc32 | 4 | over header ++ payload |
| header JSON | var | `{ sequence, pose_sequence, timestamp, point_count, pose }` |
| payload | var | the raw local-frame batch exactly as the publisher sent it |

The header carries the full pose the batch was registered with, so a record is self-contained: no
pose table is needed to re-fuse it, and a future pose correction is a new pose applied to the same
payload.

### Accumulator sidecar header

`.acc` files gained a 16-byte header: `u32 magic 'PCVA'`, `u32 version`, `f64 applied_sequence`,
where `applied_sequence` is the highest batch sequence fused into that chunk when it was written.
A headerless `.acc` from before this change is still readable and is treated as `applied_sequence`
0.

## Write path

`ChunkStore.storeAcceptedBatchDurably`:

1. Reject the batch if it fans out over more chunks than the resident budget (unchanged).
2. Append one record to the session log and fsync it. **This is the durability point.**
3. Evict resident chunks if needed, then fuse the batch into the resident voxel grids. Chunks that
   cross `FLUSH_POINT_THRESHOLD` raw points are persisted inline and stay resident.
4. Update the session row in SQLite (counters, last sequence). SQLite runs in WAL mode with
   `synchronous = NORMAL`, so this is a WAL append without an fsync.
5. Return the touched chunk keys; the server acks and fans the batch out to viewers.

If anything after step 2 throws, the server exits (fail-fast, unchanged) and the batch is replayed
from the log at the next start.

## Checkpoint

A session's `checkpoint_offset` is the byte offset in its log before which every record is already
reflected in persisted chunk files. Replay starts there. It is advanced by a **sweep**:

1. Snapshot the log end offset `O` and the set `D` of resident chunks that are dirty.
2. Persist the chunks in `D`, a bounded number per call, keeping them resident.
3. When none of `D` remains dirty, set `checkpoint_offset = O`.

This is correct under continuous ingest because every record before `O` was fused into some chunk
that was either in `D` (now persisted with data at least as new as `O`) or already clean at `O`
(persisted earlier). Chunks dirtied again after `O` are covered by records after `O`, which will be
replayed.

The server runs `checkpointTick` every `CHECKPOINT_TICK_MS` (default 1000) rewriting at most
`CHECKPOINT_CHUNKS_PER_TICK` (default 8) chunk files, so a checkpoint never stalls ingest for a full
cache rewrite. With the default resident budget of 128 chunks a sweep finishes in at most 16 ticks.
A full checkpoint of the benchmark's 68 chunks took ~630 ms and ~270 fsyncs, which is why it is
spread out. `close_session` and shutdown checkpoint fully.

## Recovery

On startup, for every session row:

1. Replay the log from `checkpoint_offset`. Each record is fused as a normal batch, except that a
   chunk whose `applied_sequence` is already at or past the record's sequence skips it. This makes
   replay idempotent per chunk, which is what allows chunks to be persisted piecemeal (threshold
   flushes, evictions, partial sweeps) without a transaction manifest.
2. A record whose sequence is past the persisted `last_sequence` was never counted, so session
   counters (`last_sequence`, `total_points`, `point_batches`) are advanced from the log.
3. A torn or corrupt tail (short frame, bad magic, CRC mismatch, unparsable header) ends the replay
   and the file is truncated there.
4. The session is checkpointed so the next start has nothing to redo.

A log file with no session row is left untouched and reported.

### What is and is not guaranteed

- **Process crash** at any point: every acked batch is recovered exactly once. Verified by the
  `chunk-store` tests (`replays a logged batch after a crash before fusion`, `replay skips batches a
  chunk already holds from a partial flush`) and the `server-restart` end-to-end test.
- **Power loss**: the log record is fsynced before the ack, so acked batches survive. SQLite rows
  written since the last WAL checkpoint may be lost (`synchronous = NORMAL`). A lost
  `checkpoint_offset` only means more replay; a lost chunk row means a chunk file exists that the
  LOD listing does not know about until it is next touched. ⚠ unverified: no power-loss test
  exists; this is the documented SQLite behaviour, not a measurement.
- **`pose_update` sequences** are not logged. After a crash the server's `last_sequence` is the last
  acked batch (or a later pose the WAL happened to keep). A resuming publisher should therefore use
  its last *acked batch* sequence as `last_client_sequence`.

## Growth

The log keeps every raw batch: a VLP-16 at full rate writes about 520 KB per spin, so roughly
19 GB per hour. Nothing compacts it yet. This is deliberate for now — the raw record is the input to
the alignment work — but a retention policy (drop records before the checkpoint once a session is
closed, or keep only keyframes) is the obvious next lever if disk becomes the constraint.

## What it enables

- **Re-fusion under a corrected pose table.** A future pose graph writes corrected poses per
  `pose_sequence`; invalidating a session's chunks and replaying its log with the corrected poses
  rebuilds the world cloud. No new storage format is needed.
- **Offline tooling.** A log is a complete, self-describing capture of a session that a Python
  sidecar can read directly (`kiss-icp`, Open3D, a pose-graph solver) without touching the server.
- **Deterministic replay for tests and benchmarks** of the fusion and LOD paths.
