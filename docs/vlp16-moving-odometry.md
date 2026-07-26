# VLP-16 moving-sensor odometry

## Goal

Support a handheld or vehicle-mounted VLP-16 by generating client-side LiDAR-inertial odometry,
then streaming each point batch with the pose that places it in the server's world frame.

The intended pipeline mirrors the working Livox Horizon scanner:

```text
VLP-16 packets ───────────────┐
                              ├── Point-LIO ──► registered cloud + odometry ──► ingest publisher
BMI088 ──SPI── ESP32 ──ROS 2──┘
```

The VLP-16 does not contain an IMU. Point-LIO therefore requires a rigidly mounted external IMU.
The current low-cost direction is a custom BMI088 module rather than a tactical-grade commercial
unit.

## Hardware direction

### Recommended first build

- **IMU:** Bosch BMI088
- **Controller:** ESP32-S3 preferred; a conventional ESP32 is also sufficient
- **Connection:** BMI088 over SPI
- **Host transport:** native USB CDC on ESP32-S3, UART/USB bridge, or wired Ethernet
- **Synchronization:** shared PPS input with the VLP-16 when practical
- **Mount:** rigid bracket or PCB fixed directly to the LiDAR assembly

The ESP32 only samples and timestamps the IMU. Point-LIO continues to run on the ROS 2 host.

An ESP32 is adequate because the workload is small: read six raw channels at 200–400 Hz, timestamp
them at acquisition, and send compact binary records. A Teensy would offer simpler deterministic
USB behavior, but is not required if timestamps are captured in the data-ready interrupt.

Avoid Wi-Fi for the primary transport. Wi-Fi latency and packet scheduling are variable; device-side
timestamps prevent transport delay from changing measurement time, but a wired link is simpler and
more reliable.

## Firmware requirements

1. Configure the BMI088 accelerometer and gyroscope for raw output at **200–400 Hz**.
2. Use the sensor data-ready interrupt rather than polling from a general application loop.
3. Timestamp each sample from a monotonic hardware timer inside or immediately after the interrupt.
4. Maintain a sequence counter and report dropped or overwritten samples.
5. Use fixed-size buffers and avoid allocation in the sampling path.
6. If PPS is connected, discipline the device clock and include PPS-lock/clock-health status.
7. Send raw acceleration and angular velocity; do not replace them with ESP32-side AHRS orientation.

A transport record should eventually contain:

- protocol/version identifier
- sequence number
- device timestamp
- accelerometer XYZ
- gyroscope XYZ
- temperature
- PPS/clock status

## ROS 2 boundary

A small ROS 2 node on the host should:

1. Read and validate the ESP32 binary stream.
2. Convert device timestamps into the same time domain used by the VLP-16 packets.
3. Publish `sensor_msgs/msg/Imu`, initially on `/vlp16/imu`.
4. Report sequence gaps, stale data, clock offset, and PPS-lock loss.
5. Expose axis/sign, scale, bias, and timestamp-offset configuration.

The Velodyne ROS 2 driver should publish timestamped VLP-16 points or packets. Point-LIO consumes the
LiDAR and `/vlp16/imu` topics and publishes its registered world-frame cloud and odometry. A bridge
publisher then adapts those outputs to this project's `pose_update` and point-batch protocol.

The existing TypeScript UDP publisher remains useful for stationary bench testing. Moving operation
should use the ROS 2 + Point-LIO path rather than attempting to estimate motion inside that publisher.

## Interim KISS-ICP path

While the BMI088 hardware is being assembled, the standalone
[KISS-ICP publisher](./vlp16-kiss-icp.md) can estimate LiDAR-only odometry directly from complete
VLP-16 revolutions. It requires no ROS 2 or IMU and publishes the estimated sensor pose with each
spin through the existing ingest protocol.

KISS-ICP is a useful way to unblock live moving tests, but it is not the final replacement for the
Point-LIO path. Fast motion, weak geometry, repetitive corridors, and motion within a spin can all
increase drift or produce registration failures.

## Calibration and timing

Accurate timing and extrinsics matter more than buying an expensive IMU.

- Measure the rigid LiDAR-to-IMU translation and rotation and configure them in Point-LIO.
- Keep the IMU close to the LiDAR and prevent bracket flex.
- Verify axis directions and units before moving the rig.
- Record raw LiDAR and IMU topics so timing and calibration changes can be replayed.
- Start with a stationary initialization period while viewing varied 3D geometry.
- Validate clock offset and drift from recorded data before trusting the map.

The VLP-16 can accept PPS and NMEA timing inputs. A common PPS source for the LiDAR and ESP32 is the
preferred final arrangement. Initial bench work may use host/device offset estimation, but it should
not be treated as the final timing design.

## Implementation stages

1. Build the ESP32/BMI088 sampler and verify loss-free 400 Hz raw output.
2. Add the ROS 2 serial/USB bridge and timestamp diagnostics.
3. Record stationary and controlled-motion bags with the VLP-16.
4. Configure and validate Point-LIO using the measured extrinsic.
5. Add a ROS 2 publisher bridge from registered points and odometry to this server.
6. Compare a closed-loop scan for drift, deskewing quality, and server reconstruction.
