"""Incremental pose graph: keyframes, odometry edges and loop closures are added as
batches arrive, and the graph is re-optimised (warm-started from its last solution)
only when a new loop is accepted. `graph.align` is this class run once over a whole
log; the watch mode of the CLI feeds it the log tail on a timer."""
from __future__ import annotations

from typing import Sequence

import numpy as np
import open3d as o3d

from .graph import (
    AlignConfig,
    AlignResult,
    Keyframe,
    Logger,
    Loop,
    make_cloud,
    propagate,
    register,
    relative,
    rotation_angle_deg,
    verify_loops,
)
from .log import Batch


class IncrementalAligner:
    def __init__(self, cfg: AlignConfig, log: Logger = lambda _: None) -> None:
        self.cfg = cfg
        self.log = log
        self.batches: list[Batch] = []
        self.keyframes: list[Keyframe] = []
        self.corrected: list[np.ndarray] = []  # world_T_kf, optimised
        self.odometry: list[tuple[np.ndarray, np.ndarray]] = []  # (kf_T_prev, information)
        self.loops: list[Loop] = []
        self.candidates = 0
        self.optimisations = 0

    def extend(self, new_batches: Sequence[Batch]) -> int:
        """Absorb batches; returns how many loop closures were newly accepted (the graph
        was re-optimised if that is non-zero)."""
        accepted = 0
        for batch in new_batches:
            self.batches.append(batch)
            if batch.points.shape[0] == 0 or not self._is_keyframe(batch):
                continue
            accepted += self._add_keyframe(batch, len(self.batches) - 1)
        if accepted:
            self.optimize()
        return accepted

    def _is_keyframe(self, batch: Batch) -> bool:
        if not self.keyframes:
            return True
        delta = np.linalg.inv(self.keyframes[-1].pose) @ batch.pose
        return (
            np.linalg.norm(delta[:3, 3]) >= self.cfg.keyframe_distance_m
            or rotation_angle_deg(delta) >= self.cfg.keyframe_angle_deg
        )

    def _add_keyframe(self, batch: Batch, batch_index: int) -> int:
        kf = Keyframe(
            index=len(self.keyframes),
            batch_index=batch_index,
            pose=batch.pose.copy(),
            cloud=make_cloud(batch.points, self.cfg),
        )
        if self.keyframes:
            prev = self.keyframes[-1]
            init = relative(prev.pose, kf.pose)  # kf_T_prev from odometry
            if self.cfg.refine_odometry:
                transformation, fitness, _, information = register(prev.cloud, kf.cloud, init, self.cfg)
                if fitness < self.cfg.min_fitness:
                    transformation, information = init, _information(prev, kf, init, self.cfg)
            else:
                transformation, information = init, _information(prev, kf, init, self.cfg)
            self.odometry.append((transformation, information))
            # Extend the optimised trajectory by the odometry step: world_T_kf = world_T_prev @ prev_T_kf.
            self.corrected.append(self.corrected[-1] @ np.linalg.inv(transformation))
        else:
            self.corrected.append(kf.pose.copy())
        self.keyframes.append(kf)

        pairs = self._candidates_for(kf.index)
        self.candidates += len(pairs)
        if not pairs:
            return 0
        # Seed ICP from the *optimised* relative pose, which after earlier closures is
        # far closer to the truth than raw odometry.
        seeded = [
            Keyframe(k.index, k.batch_index, self.corrected[k.index], k.cloud) for k in self.keyframes
        ]
        new_loops = verify_loops(seeded, pairs, self.cfg, self.log)
        self.loops.extend(new_loops)
        return len(new_loops)

    def _candidates_for(self, index: int) -> list[tuple[int, int]]:
        cfg = self.cfg
        if index < cfg.loop_min_gap:
            return []
        positions = np.stack([pose[:3, 3] for pose in self.corrected])
        earlier = positions[: index - cfg.loop_min_gap + 1]
        distances = np.linalg.norm(earlier - positions[index], axis=1)
        pairs: list[tuple[int, int]] = []
        for j in np.argsort(distances):
            if distances[j] > cfg.loop_radius_m or len(pairs) >= cfg.loop_max_candidates:
                break
            pairs.append((index, int(j)))
        return pairs

    def optimize(self) -> None:
        graph = o3d.pipelines.registration.PoseGraph()
        for pose in self.corrected:
            graph.nodes.append(o3d.pipelines.registration.PoseGraphNode(pose.copy()))
        for k, (transformation, information) in enumerate(self.odometry):
            graph.edges.append(
                o3d.pipelines.registration.PoseGraphEdge(k, k + 1, transformation, information, uncertain=False)
            )
        for loop in self.loops:
            graph.edges.append(
                o3d.pipelines.registration.PoseGraphEdge(
                    loop.source, loop.target, loop.transformation, loop.information, uncertain=True
                )
            )
        option = o3d.pipelines.registration.GlobalOptimizationOption(
            max_correspondence_distance=self.cfg.icp_fine_m,
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
        self.corrected = [np.asarray(node.pose) for node in graph.nodes]
        self.optimisations += 1
        self.log(f"optimised {len(self.keyframes)} keyframes with {len(self.loops)} loop edges")

    def result(self) -> AlignResult:
        poses, tail = propagate(self.batches, self.keyframes, self.corrected)
        drift = [
            float(np.linalg.norm((self.corrected[k] @ np.linalg.inv(self.keyframes[k].pose))[:3, 3]))
            for k in range(len(self.keyframes))
        ]
        stats = {
            "max_keyframe_correction_m": max(drift) if drift else 0.0,
            "optimisations": self.optimisations,
        }
        return AlignResult(list(self.corrected), poses, tail, self.keyframes, list(self.loops), self.candidates, stats)


def _information(a: Keyframe, b: Keyframe, transformation: np.ndarray, cfg: AlignConfig) -> np.ndarray:
    info = np.asarray(
        o3d.pipelines.registration.get_information_matrix_from_point_clouds(
            a.cloud, b.cloud, cfg.icp_fine_m, transformation
        )
    )
    if not np.isfinite(info).all() or np.trace(info) <= 0:
        info = np.eye(6)
    return info
