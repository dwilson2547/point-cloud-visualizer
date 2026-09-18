import numpy as np

from pcv_align.graph import AlignConfig, align, find_loop_candidates, select_keyframes
from pcv_align.synthetic import Scenario, make_batches


def position_error(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(a[:3, 3] - b[:3, 3]))


def test_loop_closure_reduces_end_of_loop_drift() -> None:
    batches, truth = make_batches(Scenario())
    cfg = AlignConfig(loop_min_gap=15)
    result = align(batches, cfg)

    assert len(result.keyframes) > 20
    assert result.candidates > 0
    assert len(result.loops) >= 1, "the return to the start must be detected"

    last = batches[-1]
    drifted = position_error(last.pose, truth[-1])
    corrected = position_error(result.poses[last.pose_sequence], truth[-1])
    assert drifted > 0.5, f"scenario should drift noticeably, got {drifted:.2f} m"
    assert corrected < drifted * 0.3, f"drift {drifted:.2f} m only reduced to {corrected:.2f} m"

    # Every batch gets a corrected pose, and the tail maps the last odometry pose onto it.
    assert set(result.poses) == {b.pose_sequence for b in batches}
    tail_applied = result.tail @ last.pose
    assert np.allclose(tail_applied, result.poses[last.pose_sequence], atol=1e-9)

    corrections = result.to_corrections("demo")
    assert corrections["metadata"]["loops_accepted"] == len(result.loops)
    assert corrections["poses"][0]["pose_sequence"] == 1


def test_no_candidates_leaves_poses_unchanged() -> None:
    batches, _ = make_batches(Scenario())
    cfg = AlignConfig(loop_radius_m=0.01, loop_min_gap=1000)
    keyframes = select_keyframes(batches, cfg)
    assert find_loop_candidates(keyframes, cfg) == []
    result = align(batches, cfg)
    assert result.loops == []
    for batch in batches:
        assert np.allclose(result.poses[batch.pose_sequence], batch.pose)
    assert np.allclose(result.tail, np.eye(4))
