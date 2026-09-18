"""Keyframe pose graph with ICP-verified loop closures over a session's batch log.

Pipeline (docs/alignment.md):

1. Keyframes: a batch becomes a keyframe when the publisher's odometry has moved far
   enough (distance or rotation) from the previous keyframe. Every other batch is
   rigidly attached to the keyframe before it.
2. Odometry edges between consecutive keyframes, from the publisher's poses (optionally
   refined with ICP). Their information matrix is measured from the point clouds so it
   is on the same scale as loop edges.
3. Loop candidates: keyframe pairs whose odometry positions are within `loop_radius_m`
   but at least `loop_min_gap` keyframes apart. Each is verified with coarse-to-fine
   point-to-plane ICP seeded from odometry and accepted on fitness / RMSE.
4. Open3D global optimisation (Levenberg-Marquardt with a line process on loop edges,
   node 0 fixed) yields corrected keyframe poses. Attached batches follow their keyframe;
   a tail transform is derived so batches after the last keyframe stay consistent.

Frame conventions follow Open3D's multiway registration: a node pose is world_T_node,
and an edge (source -> target) carries target_T_source = inv(pose_target) @ pose_source.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import time
from typing import Callable, Sequence

import numpy as np
import open3d as o3d

from .log import Batch, matrix_to_pose

Logger = Callable[[str], None]


@dataclass
class AlignConfig:
    keyframe_distance_m: float = 0.5
    keyframe_angle_deg: float = 10.0
    loop_radius_m: float = 3.0
    loop_min_gap: int = 20
    loop_max_candidates: int = 2
    icp_voxel_m: float = 0.1
    icp_coarse_m: float = 1.0
    icp_fine_m: float = 0.3
    min_fitness: float = 0.4
    max_rmse_m: float = 0.15
    max_loop_correction_m: float | None = None  # default: loop_radius_m
    refine_odometry: bool = False
    max_range_m: float | None = None


@dataclass
class Keyframe:
    index: int  # keyframe index (graph node id)
    batch_index: int  # index into the batch list
    pose: np.ndarray  # odometry world_T_kf
    cloud: o3d.geometry.PointCloud


@dataclass
class Loop:
    source: int
    target: int
    transformation: np.ndarray
    fitness: float
    rmse: float
    information: np.ndarray


@dataclass
class AlignResult:
    corrected_keyframes: list[np.ndarray]
    poses: dict[int, np.ndarray]  # pose_sequence -> corrected world_T_sensor
    tail: np.ndarray  # world-frame transform for poses after the last keyframe
    keyframes: list[Keyframe]
    loops: list[Loop]
    candidates: int
    stats: dict = field(default_factory=dict)

    def to_corrections(self, session_id: str) -> dict:
        return {
            "session_id": session_id,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "poses": [
                {"pose_sequence": int(seq), "pose": matrix_to_pose(matrix)}
                for seq, matrix in sorted(self.poses.items())
            ],
            "tail": matrix_to_pose(self.tail),
            "metadata": {
                "producer": "pcv-align",
                "keyframes": len(self.keyframes),
                "loop_candidates": self.candidates,
                "loops_accepted": len(self.loops),
                **self.stats,
            },
        }


def make_cloud(points: np.ndarray, cfg: AlignConfig) -> o3d.geometry.PointCloud:
    pts = np.asarray(points, dtype=np.float64)
    if cfg.max_range_m is not None:
        pts = pts[np.linalg.norm(pts, axis=1) <= cfg.max_range_m]
    cloud = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(pts))
    cloud = cloud.voxel_down_sample(cfg.icp_voxel_m)
    cloud.estimate_normals(
        o3d.geometry.KDTreeSearchParamHybrid(radius=cfg.icp_voxel_m * 4, max_nn=30)
    )
    return cloud


def rotation_angle_deg(matrix: np.ndarray) -> float:
    cos = (np.trace(matrix[:3, :3]) - 1.0) / 2.0
    return float(np.degrees(np.arccos(np.clip(cos, -1.0, 1.0))))


def select_keyframes(batches: Sequence[Batch], cfg: AlignConfig) -> list[Keyframe]:
    keyframes: list[Keyframe] = []
    last_pose: np.ndarray | None = None
    for batch_index, batch in enumerate(batches):
        if batch.points.shape[0] == 0:
            continue
        if last_pose is not None:
            delta = np.linalg.inv(last_pose) @ batch.pose
            if (
                np.linalg.norm(delta[:3, 3]) < cfg.keyframe_distance_m
                and rotation_angle_deg(delta) < cfg.keyframe_angle_deg
            ):
                continue
        keyframes.append(
            Keyframe(
                index=len(keyframes),
                batch_index=batch_index,
                pose=batch.pose.copy(),
                cloud=make_cloud(batch.points, cfg),
            )
        )
        last_pose = batch.pose
    return keyframes


def relative(source_pose: np.ndarray, target_pose: np.ndarray) -> np.ndarray:
    """target_T_source for two world_T_node poses."""
    return np.linalg.inv(target_pose) @ source_pose


def register(
    source: o3d.geometry.PointCloud,
    target: o3d.geometry.PointCloud,
    init: np.ndarray,
    cfg: AlignConfig,
) -> tuple[np.ndarray, float, float, np.ndarray]:
    """Coarse-to-fine point-to-plane ICP seeded from `init` (target_T_source)."""
    estimation = o3d.pipelines.registration.TransformationEstimationPointToPlane()
    criteria = o3d.pipelines.registration.ICPConvergenceCriteria(max_iteration=60)
    coarse = o3d.pipelines.registration.registration_icp(
        source, target, cfg.icp_coarse_m, init, estimation, criteria
    )
    fine = o3d.pipelines.registration.registration_icp(
        source, target, cfg.icp_fine_m, coarse.transformation, estimation, criteria
    )
    information = o3d.pipelines.registration.get_information_matrix_from_point_clouds(
        source, target, cfg.icp_fine_m, fine.transformation
    )
    return np.asarray(fine.transformation), float(fine.fitness), float(fine.inlier_rmse), np.asarray(information)


def find_loop_candidates(keyframes: Sequence[Keyframe], cfg: AlignConfig) -> list[tuple[int, int]]:
    """(source, target) keyframe index pairs with target well before source."""
    if len(keyframes) == 0:
        return []
    positions = np.stack([kf.pose[:3, 3] for kf in keyframes])
    pairs: list[tuple[int, int]] = []
    for i in range(cfg.loop_min_gap, len(keyframes)):
        earlier = positions[: i - cfg.loop_min_gap + 1]
        distances = np.linalg.norm(earlier - positions[i], axis=1)
        order = np.argsort(distances)
        taken = 0
        for j in order:
            if distances[j] > cfg.loop_radius_m or taken >= cfg.loop_max_candidates:
                break
            pairs.append((i, int(j)))
            taken += 1
    return pairs


def verify_loops(
    keyframes: Sequence[Keyframe],
    candidates: Sequence[tuple[int, int]],
    cfg: AlignConfig,
    log: Logger = lambda _: None,
) -> list[Loop]:
    loops: list[Loop] = []
    max_correction = cfg.max_loop_correction_m if cfg.max_loop_correction_m is not None else cfg.loop_radius_m
    for source, target in candidates:
        init = relative(keyframes[source].pose, keyframes[target].pose)
        transformation, fitness, rmse, information = register(
            keyframes[source].cloud, keyframes[target].cloud, init, cfg
        )
        correction = np.linalg.norm((np.linalg.inv(init) @ transformation)[:3, 3])
        ok = fitness >= cfg.min_fitness and rmse <= cfg.max_rmse_m and correction <= max_correction
        log(
            f"loop {source}->{target}: fitness={fitness:.2f} rmse={rmse:.3f} "
            f"correction={correction:.2f} m {'accepted' if ok else 'rejected'}"
        )
        if ok:
            loops.append(Loop(source, target, transformation, fitness, rmse, information))
    return loops


def optimize(
    keyframes: Sequence[Keyframe],
    loops: Sequence[Loop],
    cfg: AlignConfig,
    log: Logger = lambda _: None,
) -> list[np.ndarray]:
    graph = o3d.pipelines.registration.PoseGraph()
    for kf in keyframes:
        graph.nodes.append(o3d.pipelines.registration.PoseGraphNode(kf.pose.copy()))

    for a, b in zip(keyframes[:-1], keyframes[1:]):
        init = relative(a.pose, b.pose)
        if cfg.refine_odometry:
            transformation, fitness, rmse, information = register(a.cloud, b.cloud, init, cfg)
            if fitness < cfg.min_fitness:
                transformation, information = init, _information(a, b, init, cfg)
        else:
            transformation, information = init, _information(a, b, init, cfg)
        graph.edges.append(
            o3d.pipelines.registration.PoseGraphEdge(
                a.index, b.index, transformation, information, uncertain=False
            )
        )
    for loop in loops:
        graph.edges.append(
            o3d.pipelines.registration.PoseGraphEdge(
                loop.source, loop.target, loop.transformation, loop.information, uncertain=True
            )
        )

    option = o3d.pipelines.registration.GlobalOptimizationOption(
        max_correspondence_distance=cfg.icp_fine_m,
        edge_prune_threshold=0.25,
        reference_node=0,
    )
    with o3d.utility.VerbosityContextManager(o3d.utility.VerbosityLevel.Error):
        o3d.pipelines.registration.global_optimization(
            graph,
            o3d.pipelines.registration.GlobalOptimizationLevenbergMarquardt(),
            o3d.pipelines.registration.GlobalOptimizationConvergenceCriteria(),
            option,
        )
    corrected = [np.asarray(node.pose) for node in graph.nodes]
    log(f"optimised {len(keyframes)} keyframes with {len(loops)} loop edges")
    return corrected


def _information(a: Keyframe, b: Keyframe, transformation: np.ndarray, cfg: AlignConfig) -> np.ndarray:
    info = o3d.pipelines.registration.get_information_matrix_from_point_clouds(
        a.cloud, b.cloud, cfg.icp_fine_m, transformation
    )
    info = np.asarray(info)
    if not np.isfinite(info).all() or np.trace(info) <= 0:
        info = np.eye(6)
    return info


def propagate(
    batches: Sequence[Batch],
    keyframes: Sequence[Keyframe],
    corrected: Sequence[np.ndarray],
) -> tuple[dict[int, np.ndarray], np.ndarray]:
    """Corrected pose per batch: each batch keeps its odometry offset from the keyframe
    at or before it. Returns {pose_sequence: world_T_sensor} and the tail transform
    (world-frame correction of the last keyframe) for batches not yet logged."""
    poses: dict[int, np.ndarray] = {}
    if not keyframes:
        return poses, np.eye(4)
    kf_iter = iter(range(len(keyframes)))
    current = next(kf_iter)
    next_kf = next(kf_iter, None)
    for batch_index, batch in enumerate(batches):
        while next_kf is not None and keyframes[next_kf].batch_index <= batch_index:
            current = next_kf
            next_kf = next(kf_iter, None)
        kf = keyframes[current]
        if batch_index < kf.batch_index:
            continue  # before the first keyframe (empty batches only)
        world_correction = corrected[current] @ np.linalg.inv(kf.pose)
        poses[batch.pose_sequence] = world_correction @ batch.pose
    last = keyframes[-1]
    tail = corrected[-1] @ np.linalg.inv(last.pose)
    return poses, tail


def align(batches: Sequence[Batch], cfg: AlignConfig, log: Logger = lambda _: None) -> AlignResult:
    """One-shot alignment of a whole log: the incremental aligner fed everything at once."""
    from .incremental import IncrementalAligner  # local import: incremental depends on this module

    started = time.perf_counter()
    aligner = IncrementalAligner(cfg, log)
    aligner.extend(batches)
    log(f"{len(batches)} batches -> {len(aligner.keyframes)} keyframes, {aligner.candidates} candidates")
    if not aligner.loops:
        log("no loops accepted; poses unchanged")
    result = aligner.result()
    result.stats["seconds"] = round(time.perf_counter() - started, 2)
    return result
