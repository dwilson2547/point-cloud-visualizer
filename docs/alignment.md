# Alignment — pose graph and loop closure

First cut of server-side scene alignment: a Python sidecar (`alignment/`) that reads a session's
batch log, builds a keyframe pose graph with ICP-verified loop closures, and installs corrected
poses on the server, which re-fuses the session from its log. The publisher's odometry stays the
input; alignment is a correction layer over it.

Builds on [`batch-log.md`](./batch-log.md): the log keeps every raw batch with the pose it was
registered with, which is what makes re-fusion under new poses possible. Lifts the "server-side
pose estimation" and "loop-closure-aware remapping" stretch goals in
[`architecture.md`](./architecture.md) from deferred to started.

## Shape

```
publisher ──pose+batch──▶ server ──▶ log/<session>.log   (raw poses, never modified)
                                        │
                     GET /sessions/:id/log
                                        ▼
                                  pcv-align (Python, Open3D)
                                  keyframes → odometry edges → loop candidates → ICP verify
                                  → global optimisation → corrected poses + tail
                                        │
                     PUT /sessions/:id/pose-corrections
                                        ▼
                                  server: data/poses/<session>.json, rebuild from log,
                                  viewers get session_rebuilt and re-fetch the base layer
```

### Server side

- **Corrections** (`src/pose-corrections.ts`): `{ poses: [{pose_sequence, pose}], tail?, metadata? }`
  stored at `data/poses/<session>.json`. At fuse time (`ChunkStore.effectivePose`) a batch uses the
  correction for its `pose_sequence` if there is one, else `tail ∘ logged_pose` when it is past the
  last corrected sequence, else the logged pose. This applies to live ingest, log replay and
  rebuilds alike, so a correction survives restarts and a still-connected publisher keeps landing
  in the corrected frame.
- **Rebuild** (`ChunkStore.rebuildChanged`): the store keeps a per-batch index (`batches`,
  `batch_chunks` in SQLite: log offset, the pose each batch was fused with, the chunks its points
  span). Installing corrections compares every batch's fused pose with its new effective pose;
  batches that moved by less than `REFUSE_TOLERANCE_M` (default half the fusion voxel, 2 cm, or the
  equivalent rotation at 25 m) are left alone. If nothing moved the call is a no-op; if more than
  half moved the session is rebuilt wholesale (`rebuildSession`: drop everything, replay the log);
  otherwise a **partial rebuild** drops only the chunks the moved batches used to span plus the
  ones they now span, and re-fuses every batch spanning those chunks, restricted to them, using
  random-access reads at the indexed log offsets. The partial result is byte-identical to a full
  rebuild (asserted in the chunk-store tests). Either way the checkpoint is reset first so a crash
  mid-rebuild replays the log on restart. Rebuilds are synchronous on the event loop, so ingest for
  that session waits for roughly the fusion cost of the batches being re-fused.
- **HTTP**: `GET /sessions/:id/log` (supports `Range: bytes=N-` so a tailing sidecar fetches only
  what was appended; 416 when nothing is new), `GET|PUT|DELETE /sessions/:id/pose-corrections`,
  `POST /sessions/:id/rebuild`. Responses carry `mode: full | partial | unchanged`. After any
  rebuild every viewer of the session receives
  `session_rebuilt`, clears both layers, and the refresh tick re-sends the base layer for its
  camera. Live `chunk_update` overlays carry the effective pose, not the publisher's.

### Sidecar (`alignment/pcv_align`)

1. **Keyframes** (`select_keyframes`): a batch becomes a keyframe when odometry has moved
   ≥ `keyframe_distance_m` (0.5) or turned ≥ `keyframe_angle_deg` (10) since the last one. Each
   keyframe's cloud is voxel-downsampled (`icp_voxel_m`, 0.1) with normals.
2. **Odometry edges** between consecutive keyframes from the publisher's poses. `--refine-odometry`
   replaces each with ICP. Either way the edge's information matrix is measured from the two clouds
   so odometry and loop edges are weighted on the same scale.
3. **Loop candidates** (`find_loop_candidates`): for each keyframe, the nearest
   `loop_max_candidates` (2) earlier keyframes within `loop_radius_m` (3) and at least
   `loop_min_gap` (20) keyframes back. Odometry positions are used, so the radius must exceed the
   drift you expect at the point of return.
4. **Verification** (`verify_loops`): coarse-to-fine point-to-plane ICP seeded from odometry;
   accepted when fitness ≥ `min_fitness` (0.4), inlier RMSE ≤ `max_rmse_m` (0.15) and the ICP
   correction is no larger than `loop_radius_m`.
5. **Optimisation** (`optimize`): Open3D pose graph, Levenberg-Marquardt, node 0 fixed, loop edges
   `uncertain=True` so the line process can down-weight a bad closure.
6. **Propagation** (`propagate`): every batch keeps its odometry offset from the keyframe at or
   before it. The tail is the world-frame correction of the last keyframe.

### Incremental mode

`IncrementalAligner` (`pcv_align/incremental.py`) holds the graph between feeds. `extend(batches)`
adds keyframes and odometry edges as they arrive, searches loop candidates for each new keyframe
against the **optimised** positions (so a later revisit is found even after earlier closures moved
the trajectory), verifies with ICP seeded from the optimised relative pose, and re-optimises only
when a loop was newly accepted, warm-started from the previous solution. The one-shot `align()` is
this class fed the whole log at once; the two agree to within 5 cm at the end of the synthetic
loop (`test_incremental_feed_matches_one_shot_alignment`).

`pcv-align --watch` runs it against a live session: every `--interval` seconds it fetches the log
tail with a Range request, keeps any half-received record for the next read, feeds complete
batches to the aligner, and installs corrections whenever a closure was accepted. It waits for the
session to appear, and exits once the session is closed and the tail is drained. Live run on the
synthetic loop streamed at 10 Hz: first closure at 37 keyframes (7 loops, installed as a full
rebuild of 75 batches), refinement at 41 keyframes (15 loops, 81 batches), final cloud identical
to the one-shot result. Both installs were full rebuilds because a closure moves most of the
trajectory past the 2 cm tolerance; partial rebuilds kick in for small refinements and for tail
changes.

Frame convention, because it is the easiest thing to get backwards: a node pose is
`world_T_node`; an Open3D edge from `source` to `target` carries
`target_T_source = inv(pose_target) @ pose_source`, and `registration_icp(source, target, …)`
returns exactly that transform.

## Result on the synthetic loop

`pcv_align.synthetic` walks a spinning sensor around a rectangle inside a 10 × 8 × 3 m box and
back to the start, reporting odometry with a 0.15°-per-step yaw bias and a 2 % scale error.
Measured with `alignment/.venv/bin/python -m pytest` and the numbers below from one run
(`AlignConfig(loop_min_gap=15)`, 81 batches of 5,760 points):

| | Drifted odometry | After alignment |
|---|---|---|
| Position error at end of loop | 0.751 m | 0.005 m |
| Mean position error over the trajectory | 0.306 m | 0.029 m |
| Keyframes / candidates / loops accepted | 41 / 15 / 15 | |
| Wall time | 0.4 s | |

The test `test_loop_closure_reduces_end_of_loop_drift` asserts the end-of-loop error falls below
30 % of the drifted value. Real VLP-16 data is untested; expect to tune `--loop-radius` to the
drift and `--icp-voxel`/`--max-range` to the scene. ⚠ unverified on hardware.

## Try it

```bash
alignment/setup.sh                                  # venv with open3d (PYTHON=python3.12 if 3.14 lacks a wheel)
npm run dev                                          # server
alignment/.venv/bin/pcv-align-demo --session-id demo-loop   # publish the drifted loop
# open http://localhost:8080/?session_id=demo-loop — the walls double up where the loop closes
alignment/run.sh --session-id demo-loop --loop-min-gap 15   # align and install; the viewer snaps
alignment/run.sh --session-id demo-loop --watch --loop-min-gap 15   # or: start this first, then the demo
curl -X DELETE localhost:8080/sessions/demo-loop/pose-corrections   # back to raw odometry
```

`alignment/run.sh --session-id X --dry-run --out corrections.json` computes without installing.
`--log-file path` reads a log directly instead of fetching it.

## Limits and next steps

- **A closure still re-fuses most of the session.** The graph is incremental and the server
  re-fuses only what moved, but a loop closure moves nearly everything since the last closure. The
  remaining lever is to make the fused chunks follow keyframes (submaps rigidly attached to a
  keyframe, re-fused only when *their* keyframe moves beyond tolerance), which the batch index
  already makes possible.
- **Loop search is odometry-proximity only.** Large drift or a long loop can put the true revisit
  outside `loop_radius_m`. Place recognition (scan context or a global descriptor) would find those.
- **No IMU or gravity prior.** Nothing constrains roll/pitch beyond ICP; fine for a level VLP-16.
- **Keyframe attachment is rigid.** Batches between keyframes keep their odometry offset; with
  0.5 m keyframes that is well below the 4 cm fusion voxel for walking-speed drift.
- **Cross-session alignment** (registering a new session to an existing map) needs a per-session
  world transform in the store and a global registration front end. Not started.
