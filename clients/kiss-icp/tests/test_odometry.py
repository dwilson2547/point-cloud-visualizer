import numpy as np

from kiss_icp.config import load_config
from kiss_icp.kiss_icp import KissICP


def test_kiss_icp_accepts_successive_synthetic_frames() -> None:
    rng = np.random.default_rng(42)
    frame = rng.uniform([-5.0, -5.0, -1.0], [5.0, 5.0, 3.0], size=(5_000, 3))
    timestamps = np.linspace(0.0, 1.0, frame.shape[0], endpoint=False)
    config = load_config(None)
    config.data.min_range = 0.0
    config.data.max_range = 20.0
    config.mapping.voxel_size = 0.2
    odometry = KissICP(config)

    odometry.register_frame(frame, timestamps)
    odometry.register_frame(frame - np.asarray([0.1, 0.0, 0.0]), timestamps)

    assert np.isfinite(odometry.last_pose).all()
    assert odometry.last_pose.shape == (4, 4)

