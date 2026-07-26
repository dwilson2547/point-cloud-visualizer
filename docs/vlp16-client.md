# VLP-16 client setup

The recommended starting lidar for this project is now a **Velodyne VLP-16**. This repo includes a
first-pass UDP client that listens for VLP-16 packets on the host, converts them into
`xyz_rgb_i_v1` point batches, and streams them into the point cloud server over WebSocket.

## What it does today

- listens for **1206-byte Velodyne UDP packets** on port `2368` by default
- decodes **distance + intensity** samples using a **16-laser calibration file**
- converts points into local XYZ coordinates
- maps intensity to grayscale RGB for the current protocol
- publishes batches into `WS /ws/ingest`
- sends a static identity pose for v1

This is the right shape for a **stationary lidar** or an initial bench setup. If you later want a
moving rig, the next step is to replace the identity pose with odometry from another source.
The selected moving-rig direction is documented in
[`vlp16-moving-odometry.md`](./vlp16-moving-odometry.md).
An IMU-free [KISS-ICP publisher](./vlp16-kiss-icp.md) is also available for short-term moving tests.

## Why VLP-16 first

For the current project phase, a VLP-16 is a better bring-up target than the VLP-32 on your SLAM
rig:

- easier to dedicate to this server without disturbing another system
- lower channel count makes the first client and storage tests simpler
- still plenty good for proving the ingest, chunking, and viewer pipeline

## Network setup

The VLP-16 should be configured to send UDP packets to the host IP on the dedicated NIC connected to
the sensor.

Typical practical setup:

1. Assign a static IP to the NIC connected to the lidar.
2. Configure the lidar's destination IP to that NIC address.
3. Keep the UDP data port at `2368` unless you intentionally change it.
4. Run the point cloud server on the same machine or on another reachable host.

Your 40G NIC is fine as the host interface. The lidar itself does not need that bandwidth, but the
dedicated link and SSD-backed storage are both good for keeping the ingest path simple.

## Calibration file

The client expects a JSON calibration file with **16** entries, one per laser:

```json
{
  "lasers": [
    { "laserId": 0, "verticalDegrees": -15.0, "rotationalDegrees": 0.0, "distanceOffsetMeters": 0.0 },
    { "laserId": 1, "verticalDegrees": 1.0,   "rotationalDegrees": 0.0, "distanceOffsetMeters": 0.0 }
  ]
}
```

Required fields:

- `laserId` — integer `0..15`
- `verticalDegrees` — vertical correction angle

Optional fields:

- `rotationalDegrees` — horizontal correction per laser
- `distanceOffsetMeters` — additive range correction

For accurate geometry, use values derived from the factory calibration for your actual sensor.

## Running the client

```bash
npm run client:vlp16 -- \
  --calibration-file ./vlp16-calibration.json \
  --session-id vlp16-room-a-001 \
  --publisher-id vlp16-main \
  --server-url ws://localhost:8080/ws/ingest
```

Useful flags:

- `--udp-port 2368`
- `--batch-packets 10`
- `--frame-id map`
- `--project-id <id>`
- `--site-id <id>`
- `--room-id <id>`

## Current limitations

- pose is currently fixed to identity
- factory XML calibration is not parsed directly yet; convert it to the JSON shape above first
- RGB is synthesized from intensity for now
- the packet decoder is a first pass and does not yet model every Velodyne correction nuance
- the second firing azimuth in each block is approximated from adjacent block azimuths rather than
  using full per-laser timing correction

## Good next steps

1. Add a small converter for the factory calibration format you actually have.
2. Add a pose source interface so odometry can come from another process.
3. Add a packet capture/replay mode for repeatable testing without the live sensor.
4. After the VLP-16 path is stable, back-port the same improvements to the VLP-32 client.
