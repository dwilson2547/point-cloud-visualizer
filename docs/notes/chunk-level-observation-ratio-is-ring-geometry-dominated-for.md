---
title: Chunk-level observation ratio is ring-geometry dominated for a 16-ring lidar
date: 2026-09-18
tags: lidar,voxel,filter,vlp16,measurement
source: tools/point-cloud-visualizer/docs/observation-filter.md
---

A hits/opportunities ratio where opportunities are counted per chunk (batches whose FOV covered the chunk box) removes real walls along with artefacts on a VLP-16-class sensor: 16 rings over 30 deg are ~14 cm apart at 4 m, so a 4 cm voxel is on a ring for only a fraction of the batches that see its chunk. Measured on the synthetic fliers scenario: min hits 2 removed 88% of fliers for 12.5% wall loss; min ratio 0.1 removed 86% for 39% wall loss. Use the hit count as the primary knob; a meaningful ratio needs per-voxel, ring-aware opportunity counting (voxel elevation within half a ring spacing of a ring), run on resident chunks and sub-sampled.
