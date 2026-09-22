# Notes index

- [Attach ws message listeners before awaiting open](attach-ws-message-listeners-before-awaiting-open.md) — In Node's ws client a frame that arrives in the same read as the 101 handshake is emitted from the process.ne… `websocket,ws,nodejs,race,testing`
- [Chunk-level observation ratio is ring-geometry dominated for a 16-ring lidar](chunk-level-observation-ratio-is-ring-geometry-dominated-for.md) — A hits/opportunities ratio where opportunities are counted per chunk (batches whose FOV covered the chunk box… `lidar,voxel,filter,vlp16,measurement`
- [Durable ack must not rewrite chunk files per batch](durable-ack-must-not-rewrite-chunk-files-per-batch.md) — Acking a point batch only after every touched chunk file was rewritten and fsynced cost p50 780 ms per VLP-16… `durability,ingest,fsync,lidar,benchmark`
- [ffmpeg silently swaps gray for yuv420p and corrupts range data](ffmpeg-silently-swaps-gray-for-yuv420p-and-corrupts-range-da.md) — ffmpeg substitutes yuv420p for a requested gray pix_fmt when the libx264 build lacks i400/monochrome support,… `ffmpeg,codec,h264,lidar,range-image,benchmark`
- [Open3D pose graph edge convention](open3d-pose-graph-edge-convention.md) — In Open3D pose graphs a node pose is world_T_node and an edge from source to target carries target_T_source =… `open3d,pose-graph,icp,slam`
