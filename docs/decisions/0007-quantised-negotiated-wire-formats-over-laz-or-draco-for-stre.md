---
kind: decision
status: accepted
date: 2026-09-18T14:28:00-04:00
source: docs/protocol-v1.md
---

# 0007 — Quantised negotiated wire formats over LAZ or Draco for streaming

## Context

Everything was 18 bytes per point, uncompressed, in both directions: 5.2 MB/s ingest for a VLP-16
and the same again per viewer for the overlay. LAZ was raised as the community's usual answer.

## Options

- **A. Quantised, negotiated formats.** `xyzi_q4_v2` for ingest (int16 xyz at 4 mm, ±131 m, 8-bit
  intensity, 7 B) and `q8_chunk_v2` for the served base layer (u8 xyz relative to the chunk at
  chunk_size/256, rgb, intensity, 7 B), chosen per batch header and per viewer connection, with
  the 18-byte v1 kept everywhere; permessage-deflate level 1 on both WebSocket roles.
- B. LAZ / LASzip on the wire.
- C. Draco or G-PCC per chunk.
- D. Range-image ingest with an image/video codec.

## Decision

Option A. B is a file format: its ratio comes from arithmetic-coded prediction inside sealed
chunks, which cannot be appended to or delta'd, so it does not transport a live stream. C encodes
per chunk per refresh, too heavy in Node for 4 Hz refreshes and only worth it for keyframes once
deltas carry the rest. D is the real "video-like" path for spinning lidar and stays on the list
(see `../protocol-v1.md`, `../architecture.md`) but needs server-side deskew first.

## Consequences

- Measured on real payloads: 18 → 7 B per point (2.6×) both ways; deflate on the integer streams
  another 1.5–2×, on the float format only 1.6×. Column splitting would give 6.6× on ingest but
  was not adopted (it complicates row copying for the culled overlay).
- The log stores payloads as sent, so the saving reaches disk.
- v2 ingest carries no colour; the store fuses grey from intensity. The KISS-ICP publisher and the
  demo default to v2; the Velodyne TypeScript clients still send v1.
