# VLP-16 KISS-ICP moving client

This client provides an interim moving-sensor path while the external IMU hardware is unavailable.
It receives raw VLP-16 UDP packets, assembles complete revolutions, estimates LiDAR-only odometry
with KISS-ICP, and sends each spin plus its sensor-to-world pose to the existing WebSocket ingest
endpoint.

```text
VLP-16 UDP packets -> revolution assembler -> KISS-ICP -> pose + local points -> server
```

It runs as a standalone Python process and does not require ROS 2.

## Setup

Requirements:

- Python 3.10 or newer with `venv` support
- a running point-cloud-visualizer server
- the VLP-16 configured to send data packets to this host
- a 16-laser JSON calibration file for the specific sensor

Create the isolated environment:

```bash
cd clients/kiss-icp
./setup.sh
```

On Debian or Ubuntu, install the matching `python3-venv` package first if Python reports that
`ensurepip` is unavailable.

## Calibration

`clients/kiss-icp/vlp16-calibration.example.json` shows the required format. Copy it outside the
example file and replace the values with the factory corrections for the actual sensor:

```bash
cp clients/kiss-icp/vlp16-calibration.example.json ./vlp16-calibration.json
```

The example contains nominal VLP-16 vertical angles and zero rotational/range offsets. It is useful
for a first connectivity test, but should not be treated as a substitute for the sensor's factory
calibration when evaluating map quality.

## Run

Start the server from the project root:

```bash
npm start
```

Then start the publisher:

```bash
clients/kiss-icp/run.sh \
  --calibration-file ./vlp16-calibration.json \
  --session-id vlp16-kiss-room-a
```

The default endpoints are UDP port `2368` and
`ws://localhost:8080/ws/ingest`. Useful overrides include:

```bash
clients/kiss-icp/run.sh \
  --calibration-file ./vlp16-calibration.json \
  --session-id vlp16-kiss-room-a \
  --server-url ws://192.168.1.20:8080/ws/ingest \
  --udp-port 2368 \
  --sensor-ip 192.168.1.201 \
  --min-range 1.0 \
  --max-range 60.0
```

Open `http://localhost:8080/?session_id=vlp16-kiss-room-a` on the server host to view the session.
Stop the publisher with `Ctrl-C`; it closes the ingest session after processing the current frame.

## Bring-up sequence

1. Leave the VLP-16 stationary for several complete spins after startup.
2. Confirm the publisher reports increasing spin counts and no sustained UDP drops.
3. Confirm `/sessions` reports increasing `pointBatches` and `totalPoints`.
4. Move slowly through an area with walls, corners, furniture, and other non-repetitive geometry.
5. Return near the starting pose and inspect the cloud for doubling, bending, or accumulated drift.

Start with walking-speed translation and slow rotation. Rapid handheld motion can distort a complete
spin before scan matching has enough information to estimate it.

## Tuning

- `--min-range` rejects near returns before registration; default `1.0` meter.
- `--max-range` rejects distant returns; default `100.0` meters. Lowering it to the useful indoor
  range generally reduces work and removes weak far returns.
- `--voxel-size` overrides KISS-ICP's map voxel size. By default it is derived from `max-range`.
- `--minimum-points` rejects incomplete revolutions; default `1000`.
- `--kiss-config` loads a KISS-ICP YAML configuration for advanced tuning.

The UDP receiver runs in a dedicated thread with a bounded queue. If ICP cannot keep up, packets are
dropped rather than allowing memory use to grow without bound. Malformed datagrams are ignored
instead of terminating the session. Set `--sensor-ip` on shared networks to ignore traffic from
other hosts; the publisher reports dropped, malformed, and filtered packet counts.

Use a new session ID when restarting the KISS-ICP process. Its in-memory odometry map is not
checkpointed, so resuming an old server session after a process restart would place a new local
trajectory into the previous world frame incorrectly.

## Current limitations

- LiDAR-only odometry can drift or fail in geometrically weak or repetitive scenes.
- There is no loop closure or global pose-graph optimization.
- KISS-ICP deskews from its motion model, but no IMU is available for high-rate rotational motion.
- The initial partial revolution is discarded so every registered frame starts at an azimuth wrap.
- Source intensity is not preserved through KISS-ICP preprocessing; published RGB is currently
  synthesized from range.
- Factory Velodyne XML calibration is not parsed directly.

The planned ESP32/BMI088 plus Point-LIO path remains the preferred final moving-rig design because
the IMU provides stronger motion observability and deskewing.
