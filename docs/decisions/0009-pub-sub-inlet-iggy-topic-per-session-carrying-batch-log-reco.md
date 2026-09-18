---
kind: decision
status: accepted
date: 2026-09-18T14:50:56-04:00
depends_on: [0002]
source: docs/pubsub.md
---

# 0009 — Pub/sub inlet: Iggy topic per session carrying batch-log records, consumed over HTTP

## Context

The WebSocket path pushes a batch and waits for a durable ack. A pub/sub alternative was wanted
for publishers that should keep capturing while the server is down, for fan-out of one raw stream,
and for bridging systems that already speak a broker (the Livox rig is ROS 2). The cluster runs
Apache Iggy (persistent binary streams) and Mosquitto (MQTT).

## Options

- **A. Iggy, one topic per session, messages = batch-log records**, consumed by the server over
  Iggy's HTTP API with offsets stored in the broker; control messages as JSON on the same topic.
- B. MQTT for everything through the existing Mosquitto.
- C. Iggy through the TCP SDKs.
- D. A new message schema (protobuf) instead of reusing the log record.

## Decision

Option A. The log record already carries sequence, pose, format and payload, so a topic is a
second copy of the session log and the consumer reuses the existing parser and the existing
durable path; redelivery is handled by the session's sequence check. B is fine for small control
traffic but Mosquitto's persistence is not built for 200 KB messages at 10 Hz per sensor. C was
set aside because the published Node SDK predates the 0.8 server; the HTTP API is versioned with
the server and was probed directly. D adds a schema for no gain over a format the system already
writes and reads.

## Consequences

- Delivery is at-least-once; duplicates are dropped by sequence, gaps are allowed.
- No ack: backpressure is the broker's buffer, so consumer lag must be watched.
- Base64 over HTTP costs ~33 % extra bytes between broker and server; negligible at poll rates,
  and revisitable with the TCP SDK once it matches the server.
- Iggy needs io_uring; a local container runs with `--security-opt seccomp=unconfined`.
- The WebSocket path remains primary and is unchanged; both inlets share the fusion tail.
