---
title: Durable ack must not rewrite chunk files per batch
date: 2026-09-18
tags: durability,ingest,fsync,lidar,benchmark
source: tools/point-cloud-visualizer/docs/batch-log.md
---

Acking a point batch only after every touched chunk file was rewritten and fsynced cost p50 780 ms per VLP-16 spin (~250 fsyncs) on an SSD, one eighth of the 10 Hz sensor rate; the blocking publisher would overflow its UDP queue in seconds. Fix was an append-only per-session batch log (one write + one fsync per batch, p50 22 ms) with chunk files as a derived, incrementally checkpointed cache and per-chunk applied-sequence for idempotent replay. Rule: measure the durable write path with a realistic batch (npm run bench:ingest) before designing an ack boundary around file rewrites, and keep raw batches because voxel fusion is destructive and later pose correction needs them.
