from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
import struct

import numpy as np

VLP16_PACKET_BYTES = 1206
BLOCK_COUNT = 12
BLOCK_BYTES = 100
LASERS_PER_FIRING = 16
FIRINGS_PER_BLOCK = 2
DISTANCE_SCALE_METERS = 0.002
FIRING_INTERVAL_US = 55.296
BLOCK_INTERVAL_US = FIRING_INTERVAL_US * FIRINGS_PER_BLOCK
LASER_INTERVAL_US = 2.304
TOP_OF_HOUR_US = 3_600_000_000


@dataclass(frozen=True)
class LaserCalibration:
    laser_id: int
    vertical_degrees: float
    rotational_degrees: float = 0.0
    distance_offset_meters: float = 0.0


@dataclass(frozen=True)
class Firing:
    azimuth_degrees: float
    points: np.ndarray
    intensities: np.ndarray
    timestamps_us: np.ndarray


@dataclass(frozen=True)
class Spin:
    points: np.ndarray
    intensities: np.ndarray
    timestamps: np.ndarray
    timestamp_us: float


def load_calibration(path: str | Path) -> list[LaserCalibration]:
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    lasers = document if isinstance(document, list) else document.get("lasers")
    if not isinstance(lasers, list) or len(lasers) != LASERS_PER_FIRING:
        raise ValueError("Calibration must contain exactly 16 laser entries")

    result = []
    for expected_id, laser in enumerate(sorted(lasers, key=lambda item: item["laserId"])):
        if laser.get("laserId") != expected_id:
            raise ValueError(f"Calibration is missing laserId {expected_id}")
        result.append(
            LaserCalibration(
                laser_id=expected_id,
                vertical_degrees=_finite(laser.get("verticalDegrees"), "verticalDegrees"),
                rotational_degrees=_finite(
                    laser.get("rotationalDegrees", 0.0), "rotationalDegrees"
                ),
                distance_offset_meters=_finite(
                    laser.get("distanceOffsetMeters", 0.0), "distanceOffsetMeters"
                ),
            )
        )
    return result


def packet_timestamp_us(packet: bytes) -> int:
    _validate_packet_length(packet)
    return struct.unpack_from("<I", packet, 1200)[0]


def parse_packet(
    packet: bytes,
    calibration: list[LaserCalibration],
    timestamp_epoch_us: int = 0,
) -> list[Firing]:
    _validate_packet_length(packet)
    if len(calibration) != LASERS_PER_FIRING:
        raise ValueError("Expected 16 laser calibration entries")

    packet_time_us = timestamp_epoch_us + packet_timestamp_us(packet)
    block_azimuths = []
    for block_index in range(BLOCK_COUNT):
        block_offset = block_index * BLOCK_BYTES
        flag = struct.unpack_from("<H", packet, block_offset)[0]
        if flag != 0xEEFF:
            raise ValueError(f"Invalid data block flag at block {block_index}")
        block_azimuths.append(struct.unpack_from("<H", packet, block_offset + 2)[0] / 100.0)

    firings: list[Firing] = []
    previous_delta = 0.0
    for block_index, azimuth_degrees in enumerate(block_azimuths):
        if block_index + 1 < BLOCK_COUNT:
            delta_degrees = (block_azimuths[block_index + 1] - azimuth_degrees) % 360.0
            if delta_degrees < 10.0:
                previous_delta = delta_degrees
        else:
            delta_degrees = previous_delta

        block_offset = block_index * BLOCK_BYTES
        for firing_index in range(FIRINGS_PER_BLOCK):
            firing_azimuth = (
                azimuth_degrees + delta_degrees * firing_index / FIRINGS_PER_BLOCK
            ) % 360.0
            points = []
            intensities = []
            timestamps = []
            for laser_index, laser in enumerate(calibration):
                channel_index = firing_index * LASERS_PER_FIRING + laser_index
                channel_offset = block_offset + 4 + channel_index * 3
                distance_raw = struct.unpack_from("<H", packet, channel_offset)[0]
                if distance_raw == 0:
                    continue
                distance = (
                    distance_raw * DISTANCE_SCALE_METERS + laser.distance_offset_meters
                )
                if distance <= 0.0:
                    continue

                azimuth = math.radians(firing_azimuth + laser.rotational_degrees)
                vertical = math.radians(laser.vertical_degrees)
                xy = distance * math.cos(vertical)
                points.append(
                    [
                        xy * math.cos(azimuth),
                        xy * math.sin(azimuth),
                        distance * math.sin(vertical),
                    ]
                )
                intensities.append(packet[channel_offset + 2])
                timestamps.append(
                    packet_time_us
                    + block_index * BLOCK_INTERVAL_US
                    + firing_index * FIRING_INTERVAL_US
                    + laser_index * LASER_INTERVAL_US
                )

            firings.append(
                Firing(
                    azimuth_degrees=firing_azimuth,
                    points=np.asarray(points, dtype=np.float64).reshape(-1, 3),
                    intensities=np.asarray(intensities, dtype=np.uint8),
                    timestamps_us=np.asarray(timestamps, dtype=np.float64),
                )
            )
    return firings


class SpinAssembler:
    def __init__(
        self, calibration: list[LaserCalibration], minimum_points: int = 1_000
    ) -> None:
        if len(calibration) != LASERS_PER_FIRING:
            raise ValueError("Expected 16 laser calibration entries")
        self.calibration = calibration
        self.minimum_points = minimum_points
        self._synchronized = False
        self._previous_azimuth: float | None = None
        self._points: list[np.ndarray] = []
        self._intensities: list[np.ndarray] = []
        self._timestamps_us: list[np.ndarray] = []
        self._timestamp_epoch_us = 0
        self._previous_packet_timestamp_us: int | None = None

    def add_packet(self, packet: bytes) -> list[Spin]:
        raw_timestamp = packet_timestamp_us(packet)
        timestamp_epoch_us = self._timestamp_epoch_us
        if (
            self._previous_packet_timestamp_us is not None
            and raw_timestamp + TOP_OF_HOUR_US // 2 < self._previous_packet_timestamp_us
        ):
            timestamp_epoch_us += TOP_OF_HOUR_US

        firings = parse_packet(packet, self.calibration, timestamp_epoch_us)
        self._timestamp_epoch_us = timestamp_epoch_us
        self._previous_packet_timestamp_us = raw_timestamp

        completed: list[Spin] = []
        for firing in firings:
            wrapped = (
                self._previous_azimuth is not None
                and firing.azimuth_degrees + 180.0 < self._previous_azimuth
            )
            if wrapped:
                if self._synchronized:
                    spin = self._finish_spin()
                    if spin is not None:
                        completed.append(spin)
                else:
                    self._synchronized = True
                    self._clear()

            if self._synchronized and firing.points.size:
                self._points.append(firing.points)
                self._intensities.append(firing.intensities)
                self._timestamps_us.append(firing.timestamps_us)
            self._previous_azimuth = firing.azimuth_degrees
        return completed

    def _finish_spin(self) -> Spin | None:
        if not self._points:
            self._clear()
            return None
        points = np.concatenate(self._points)
        intensities = np.concatenate(self._intensities)
        timestamps_us = np.concatenate(self._timestamps_us)
        self._clear()
        if points.shape[0] < self.minimum_points:
            return None

        start = float(timestamps_us.min())
        duration = float(timestamps_us.max() - start)
        if duration > 0.0:
            normalized = (timestamps_us - start) / duration
        else:
            normalized = np.linspace(0.0, 1.0, points.shape[0], endpoint=False)
        return Spin(
            points=points,
            intensities=intensities,
            timestamps=normalized.astype(np.float64),
            timestamp_us=start,
        )

    def _clear(self) -> None:
        self._points.clear()
        self._intensities.clear()
        self._timestamps_us.clear()


def _validate_packet_length(packet: bytes) -> None:
    if len(packet) != VLP16_PACKET_BYTES:
        raise ValueError(
            f"Expected {VLP16_PACKET_BYTES}-byte VLP-16 packet, got {len(packet)}"
        )


def _finite(value: object, field: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{field} must be finite")
    return number
