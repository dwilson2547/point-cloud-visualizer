# Pub/sub inlet — Apache Iggy consumer

A second way into the server besides the WebSocket ingest socket: publishers write to an Apache
Iggy stream and the server consumes it. The WebSocket path stays primary (it has real backpressure
through the ack, and it is the viewer channel); this inlet is for publishers that should keep
capturing while the server is down, for fan-out of one raw stream to several consumers, and for
bridging other systems (a ROS 2 node publishing to a broker is standard plumbing).

## Message format

The message *is* the batch-log record (`docs/batch-log.md`): magic `PCVL`, header length, payload
length, crc32, header JSON (`sequence`, `pose_sequence`, `timestamp`, `point_count`, `pose`,
`point_format`) and the raw payload in whatever ingest format the publisher chose. Pose and batch
travel together, so no `pose_update` precedes a batch. Control messages are plain JSON with a
`type`: `create_session` (same fields as the WebSocket message; `session_id` is taken from the
topic) and `close_session`. The consumer tells them apart by the magic bytes.

Because the record is self-contained, a topic is a second copy of the session log and any
consumer can rebuild the session from it with the same parser.

## Layout and delivery

- One stream (`IGGY_STREAM`, default `pcv`), one topic per session named by session id, one
  partition, so per-session order is preserved.
- The server consumer (`src/iggy-consumer.ts`) lists the stream's topics every 2 s to pick up new
  sessions, polls each topic from its stored consumer offset (`IGGY_CONSUMER`, default
  `pcv-server`), stores each batch through the same durable path as socket batches, then commits
  the offset. Delivery is therefore at-least-once; a redelivered batch is dropped by the session's
  sequence check (`SessionStore.prepareExternalBatch`: a sequence at or below the last committed
  one is a duplicate). Sequences only need to increase, not step by one.
- `create_session` for an existing session reopens it (a restarted publisher or a replayed topic),
  rather than failing as the socket path does. A batch before its session's `create_session` is
  skipped with a log line.
- Durable-storage failures exit the process, as on the socket path; other rejections are logged
  and the offset still advances (a malformed message is not retried forever).
- Backpressure is the broker's buffer, not an ack: watch consumer lag (topic `messages_count` vs
  the stored offset) or the server will look healthy while falling behind.

## Transport

The consumer and the Python publisher (`pcv_align/iggy_http.py`) use Iggy's **HTTP API**, not the
TCP protocol: the published Node SDK predates the 0.8 server, and the HTTP API is versioned with
the server. Shapes were probed against `apache/iggy:0.8.0` (the cluster's version): login tokens
last an hour and are refreshed on 401; partitions are zero-indexed; topic `message_expiry` and
`max_topic_size` are integers with 0 meaning unlimited; payloads are base64 in JSON (≈33 % wire
overhead over binary, irrelevant at a few polls per second); polling past the end returns an empty
page. A 600 KB message round-trips in ~2 ms on the laptop.

## Run it

Locally (Iggy needs io_uring, so Docker's default seccomp profile must be relaxed):

```bash
docker run -d --name pcv-iggy --security-opt seccomp=unconfined -p 3000:3000 -p 8090:8090 \
  -e IGGY_ROOT_USERNAME=iggy -e IGGY_ROOT_PASSWORD=iggy \
  -e IGGY_HTTP_ENABLED=true -e IGGY_HTTP_ADDRESS=0.0.0.0:3000 -e IGGY_TCP_ADDRESS=0.0.0.0:8090 \
  apache/iggy:0.8.0
IGGY_HTTP_URL=http://localhost:3000 npm run dev
alignment/.venv/bin/pcv-align-demo --session-id iggy-loop --transport iggy   # publishes to the broker
alignment/run.sh --session-id iggy-loop --loop-min-gap 15                       # aligns the consumed session
```

Against the cluster, `IGGY_HTTP_URL` is the pub-sub namespace's Iggy HTTP endpoint (port 3000;
`infra/cluster-config/pub-sub/deployment.yml`) with its credentials in `IGGY_USERNAME` /
`IGGY_PASSWORD`. The integration test runs when `IGGY_HTTP_URL` is set:
`IGGY_HTTP_URL=http://localhost:3000 npm test`.

Server environment: `IGGY_HTTP_URL` (unset = consumer disabled), `IGGY_USERNAME`,
`IGGY_PASSWORD`, `IGGY_STREAM`, `IGGY_CONSUMER`, `IGGY_POLL_MS` (idle poll, default 100),
`IGGY_PAGE_SIZE` (messages per poll, default 32).

## Verified

- Unit: message classification (record, control, corrupt, truncated) and the external batch rules
  (no pose_update, duplicates dropped, gaps allowed, payload validated).
- Integration against `apache/iggy:0.8.0` in Docker: a session published as control + two records
  in two formats is consumed once, survives a server restart without double counting (stored
  offset), drops a redelivered record, accepts a later one, and closes; the chunks match what the
  socket path would have fused.
- End to end: the synthetic loop published through Iggy, consumed live, then aligned by
  `pcv-align` against the consumed session.

## Not built

- MQTT for small control/telemetry messages (the cluster's Mosquitto): not needed for the point
  stream and not wired.
- The TCP/binary SDK path. Worth revisiting when the Node SDK catches up with the server, or for a
  Rust/Python publisher on the sensor host where the base64 overhead matters.
- A ROS 2 bridge for the Livox rig: a small rclpy node subscribing to the registered cloud and
  odometry and sending records to the topic. This would be the first real sensor data into the
  system through this inlet.
