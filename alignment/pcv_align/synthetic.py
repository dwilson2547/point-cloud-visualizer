"""Synthetic drifted-loop scenario: a spinning sensor walks a rectangle inside a box room
and returns to its start, while the odometry it reports accumulates a yaw bias and a
scale error. Used by the tests and by the demo publisher, so the whole
publish -> align -> rebuild path can be exercised without hardware."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .log import Batch


@dataclass
class Scenario:
    room: tuple[float, float, float] = (10.0, 8.0, 3.0)  # x, y, z extents, origin at a corner
    sensor_height: float = 1.2
    rings: int = 16
    azimuth_steps: int = 360
    noise_m: float = 0.01
    step_m: float = 0.25  # travel per batch
    yaw_bias_deg_per_step: float = 0.15  # odometry drift
    scale_error: float = 1.02  # odometry over-estimates travel by 2%
    seed: int = 7


def yaw_matrix(yaw: float, position: np.ndarray) -> np.ndarray:
    c, s = np.cos(yaw), np.sin(yaw)
    m = np.eye(4)
    m[:3, :3] = [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
    m[:3, 3] = position
    return m


def rectangle_path(sc: Scenario) -> list[np.ndarray]:
    """True world_T_sensor poses along a rectangle 2 m inside the walls, heading along
    the direction of travel, returning to the start."""
    x0, y0 = 2.0, 2.0
    x1, y1 = sc.room[0] - 2.0, sc.room[1] - 2.0
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    poses = []
    for (ax, ay), (bx, by) in zip(corners[:-1], corners[1:]):
        length = np.hypot(bx - ax, by - ay)
        steps = int(round(length / sc.step_m))
        yaw = np.arctan2(by - ay, bx - ax)
        for k in range(steps):
            t = k / steps
            position = np.array([ax + (bx - ax) * t, ay + (by - ay) * t, sc.sensor_height])
            poses.append(yaw_matrix(yaw, position))
    poses.append(yaw_matrix(0.0, np.array([x0, y0, sc.sensor_height])))
    return poses


def scan_room(pose: np.ndarray, sc: Scenario, rng: np.random.Generator) -> np.ndarray:
    """Local-frame points: rays from the sensor intersected with the room's six planes."""
    elevations = np.deg2rad(np.linspace(-15.0, 15.0, sc.rings))
    azimuths = np.linspace(0.0, 2 * np.pi, sc.azimuth_steps, endpoint=False)
    el, az = np.meshgrid(elevations, azimuths, indexing="ij")
    local_dirs = np.stack(
        [np.cos(el) * np.cos(az), np.cos(el) * np.sin(az), np.sin(el)], axis=-1
    ).reshape(-1, 3)
    world_dirs = local_dirs @ pose[:3, :3].T
    origin = pose[:3, 3]
    t_hit = np.full(world_dirs.shape[0], np.inf)
    for axis, extent in enumerate(sc.room):
        for bound in (0.0, extent):
            d = world_dirs[:, axis]
            with np.errstate(divide="ignore", invalid="ignore"):
                t = (bound - origin[axis]) / d
            t = np.where((d != 0) & (t > 1e-6), t, np.inf)
            t_hit = np.minimum(t_hit, t)
    valid = np.isfinite(t_hit)
    points = local_dirs[valid] * t_hit[valid, None]
    points += rng.normal(0.0, sc.noise_m, points.shape)
    return points


def drifted_odometry(true_poses: list[np.ndarray], sc: Scenario) -> list[np.ndarray]:
    """What the publisher *reports*: integrate the true relative motion with a yaw bias
    and a scale error, so the reported trajectory diverges from the truth."""
    reported = [true_poses[0].copy()]
    bias = yaw_matrix(np.deg2rad(sc.yaw_bias_deg_per_step), np.zeros(3))
    for prev, curr in zip(true_poses[:-1], true_poses[1:]):
        delta = np.linalg.inv(prev) @ curr
        delta = delta.copy()
        delta[:3, 3] *= sc.scale_error
        reported.append(reported[-1] @ delta @ bias)
    return reported


def make_batches(sc: Scenario) -> tuple[list[Batch], list[np.ndarray]]:
    """Batches as the server would log them (local points + reported pose), plus the
    true poses for evaluation. Pose sequences are 1, 3, 5, ... and batch sequences
    2, 4, 6, ... to mirror a publisher that sends a pose before every batch."""
    rng = np.random.default_rng(sc.seed)
    true_poses = rectangle_path(sc)
    reported = drifted_odometry(true_poses, sc)
    batches = []
    for k, (truth, odom) in enumerate(zip(true_poses, reported)):
        batches.append(
            Batch(
                sequence=2 * k + 2,
                pose_sequence=2 * k + 1,
                timestamp="",
                pose=odom,
                points=scan_room(truth, sc, rng),
            )
        )
    return batches, true_poses
