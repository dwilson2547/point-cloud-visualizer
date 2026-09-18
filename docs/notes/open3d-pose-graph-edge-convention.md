---
title: Open3D pose graph edge convention
date: 2026-09-18
tags: open3d,pose-graph,icp,slam
source: tools/point-cloud-visualizer/docs/alignment.md
---

In Open3D pose graphs a node pose is world_T_node and an edge from source to target carries target_T_source = inv(pose_target) @ pose_source, which is exactly what registration_icp(source, target, ...) returns. Getting this backwards makes global_optimization silently produce garbage with no error. Odometry edges should get an information matrix measured from the clouds (get_information_matrix_from_point_clouds) so they sit on the same scale as ICP loop edges; identity weights let loops distort the whole trajectory.
