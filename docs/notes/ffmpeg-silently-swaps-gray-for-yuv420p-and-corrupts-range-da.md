---
title: ffmpeg silently swaps gray for yuv420p and corrupts range data
date: 2026-09-22
tags: ffmpeg,codec,h264,lidar,range-image,benchmark
source: tools/point-cloud-visualizer/docs/range-image-ingest.md
---

ffmpeg substitutes yuv420p for a requested gray pix_fmt when the libx264 build lacks i400/monochrome support, and does so without warning; the limited-range 16-235 squeeze corrupted 16-bit lidar range values by ~2 m RMSE while the run still reported a plausible 86x compression ratio, because ratio and RMSE both looked reasonable in isolation. yuvj420p (full-range) round-trips the Y plane exactly and is still ordinary H.264 to a hardware decoder. The corruption only surfaced because an FFV1 gray16 lossless config in the same comparison reported 0.0 mm error, making it obvious the fault was in one codec path and not the harness. Rule: in any lossy-codec benchmark keep a known-lossless config as a tripwire and assert round-trip equality on it before trusting a single ratio, and read the stored pix_fmt back with ffprobe rather than assuming the one you asked for was honoured — the same applies to any depth or range data pushed through a video codec, where a colourspace conversion is silent but a metric error.
