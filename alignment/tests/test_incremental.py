import numpy as np

from pcv_align.graph import AlignConfig, align
from pcv_align.incremental import IncrementalAligner
from pcv_align.log import parse_records
from pcv_align.synthetic import Scenario, make_batches
from tests.test_log import record


def position_error(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(a[:3, 3] - b[:3, 3]))


def test_incremental_feed_matches_one_shot_alignment() -> None:
    batches, truth = make_batches(Scenario())
    cfg = AlignConfig(loop_min_gap=15)
    one_shot = align(batches, cfg)

    aligner = IncrementalAligner(cfg)
    closures = []
    for start in range(0, len(batches), 7):
        closures.append(aligner.extend(batches[start : start + 7]))
    assert sum(1 for c in closures if c > 0) >= 1, "loops must close while streaming"
    assert closures[0] == 0, "nothing can close before the trajectory returns"
    assert aligner.optimisations == sum(1 for c in closures if c > 0)

    result = aligner.result()
    assert len(result.keyframes) == len(one_shot.keyframes)
    last = batches[-1]
    drifted = position_error(last.pose, truth[-1])
    corrected = position_error(result.poses[last.pose_sequence], truth[-1])
    assert corrected < drifted * 0.3
    assert position_error(result.poses[last.pose_sequence], one_shot.poses[last.pose_sequence]) < 0.05


def test_parse_records_keeps_an_incomplete_tail_for_the_next_read() -> None:
    pts = np.array([[1.0, 2.0, 3.0]])
    a, b = record(2, pts), record(4, pts)
    first = a + b[:10]
    batches, consumed = parse_records(first)
    assert [x.sequence for x in batches] == [2]
    assert consumed == len(a)
    batches, consumed = parse_records(first[consumed:] + b[10:])
    assert [x.sequence for x in batches] == [4]
    assert consumed == len(b)
