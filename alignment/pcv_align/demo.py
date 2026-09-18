"""pcv-align-demo: publish the synthetic drifted loop into a live server session, so the
whole path can be seen in the viewer: drifted walls doubling up, then `pcv-align`
snapping them back."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import sys
import time

import numpy as np
from websockets.sync.client import connect

from .log import POINT_FORMAT_Q4, POINT_FORMAT_V1, Q4_DTYPE, POINT_DTYPE, encode_points, matrix_to_pose
from .synthetic import Scenario, make_batches


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Publish a synthetic drifted loop to a server")
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--server-url", default="ws://localhost:8080/ws/ingest")
    parser.add_argument("--rate", type=float, default=10.0, help="batches per second")
    parser.add_argument("--yaw-bias", type=float, default=Scenario.yaw_bias_deg_per_step)
    parser.add_argument("--scale-error", type=float, default=Scenario.scale_error)
    parser.add_argument("--fliers", type=float, default=0.0, help="fraction of one-off artefact points per batch")
    parser.add_argument(
        "--point-format", choices=[POINT_FORMAT_V1, POINT_FORMAT_Q4], default=POINT_FORMAT_Q4,
        help="wire format for point batches (v1 is 18 B/point with colour, q4 is 7 B/point)",
    )
    parser.add_argument(
        "--azimuth-steps", type=int, default=Scenario.azimuth_steps,
        help="rays per ring per spin (1800 matches a VLP-16 at 10 Hz; the default 360 is quick)",
    )
    parser.add_argument("--transport", choices=["websocket", "iggy"], default="websocket")
    parser.add_argument("--iggy-url", default="http://localhost:3000", help="Iggy HTTP API (transport iggy)")
    parser.add_argument("--iggy-user", default="iggy")
    parser.add_argument("--iggy-password", default="iggy")
    parser.add_argument("--iggy-stream", default="pcv")
    args = parser.parse_args(argv)

    scenario = Scenario(
        yaw_bias_deg_per_step=args.yaw_bias,
        scale_error=args.scale_error,
        flier_fraction=args.fliers,
        azimuth_steps=args.azimuth_steps,
    )
    batches, _ = make_batches(scenario)
    if args.transport == "iggy":
        return publish_iggy(args, batches)
    with connect(args.server_url, max_size=None) as ws:
        ws.send(
            json.dumps(
                {
                    "type": "create_session",
                    "protocol_version": 1,
                    "session_id": args.session_id,
                    "publisher_id": "pcv-align-demo",
                    "started_at": _now(),
                    "frame_id": "drifted_odom",
                    "units": "meters",
                    "metadata": {
                        "odometry": "synthetic-drift",
                        "sensor_fov": {"elevation_min_deg": -15, "elevation_max_deg": 15, "max_range_m": 100},
                    },
                }
            )
        )
        ack = json.loads(ws.recv())
        if ack.get("type") != "session_ack":
            print(f"session rejected: {ack}", file=sys.stderr)
            return 1
        print(f"publishing {len(batches)} batches; viewer: http://localhost:8080/?session_id={args.session_id}")
        for batch in batches:
            timestamp = _now()
            pose = matrix_to_pose(batch.pose)
            ws.send(
                json.dumps(
                    {
                        "type": "pose_update",
                        "session_id": args.session_id,
                        "publisher_id": "pcv-align-demo",
                        "sequence": batch.pose_sequence,
                        "timestamp": timestamp,
                        "pose": pose,
                    }
                )
            )
            payload, stride = encode_batch(batch, args.point_format)
            ws.send(
                json.dumps(
                    {
                        "type": "point_batch_header",
                        "session_id": args.session_id,
                        "publisher_id": "pcv-align-demo",
                        "sequence": batch.sequence,
                        "timestamp": timestamp,
                        "pose_sequence": batch.pose_sequence,
                        "point_count": int(batch.points.shape[0]),
                        "point_format": args.point_format,
                        "encoding": "binary_le",
                        "compression": "none",
                        "stride_bytes": stride,
                    }
                )
            )
            ws.send(payload)
            response = json.loads(ws.recv())
            if response.get("type") != "point_batch_ack":
                print(f"batch rejected: {response}", file=sys.stderr)
                return 1
            time.sleep(1.0 / args.rate)
        ws.send(
            json.dumps(
                {
                    "type": "close_session",
                    "session_id": args.session_id,
                    "publisher_id": "pcv-align-demo",
                    "sequence": batches[-1].sequence + 1,
                }
            )
        )
    print("done; now run: alignment/run.sh --session-id", args.session_id)
    return 0


def encode_batch(batch, point_format: str) -> tuple[bytes, int]:
    height = np.clip((batch.points[:, 2] + 1.5) / 3.0, 0.0, 1.0)
    if point_format == POINT_FORMAT_V1:
        wire = np.zeros(batch.points.shape[0], dtype=POINT_DTYPE)
        wire["x"], wire["y"], wire["z"] = batch.points[:, 0], batch.points[:, 1], batch.points[:, 2]
        wire["r"] = (60 + 160 * height).astype(np.uint8)
        wire["g"] = (120 + 80 * (1 - height)).astype(np.uint8)
        wire["b"] = (200 - 120 * height).astype(np.uint8)
        wire["intensity"] = 1000
        return wire.tobytes(), POINT_DTYPE.itemsize
    return encode_points(batch.points, POINT_FORMAT_Q4, (60 + 160 * height).astype(np.uint8)), Q4_DTYPE.itemsize


def publish_iggy(args, batches) -> int:
    """Publish the scenario as pub/sub messages: a create_session control message, then
    one batch-log record per spin, then close_session (docs/pubsub.md)."""
    from .iggy_http import IggyHttp
    from .log import encode_record

    client = IggyHttp(args.iggy_url, args.iggy_user, args.iggy_password)
    client.login()
    client.ensure_stream(args.iggy_stream)
    client.ensure_topic(args.iggy_stream, args.session_id)
    topic = args.session_id
    client.send(
        args.iggy_stream,
        topic,
        [
            json.dumps(
                {
                    "type": "create_session",
                    "protocol_version": 1,
                    "session_id": args.session_id,
                    "publisher_id": "pcv-align-demo",
                    "started_at": _now(),
                    "frame_id": "drifted_odom",
                    "units": "meters",
                    "metadata": {
                        "odometry": "synthetic-drift",
                        "transport": "iggy",
                        "sensor_fov": {"elevation_min_deg": -15, "elevation_max_deg": 15, "max_range_m": 100},
                    },
                }
            ).encode()
        ],
    )
    print(f"publishing {len(batches)} batches to iggy stream {args.iggy_stream} topic {topic}")
    for batch in batches:
        payload, _stride = encode_batch(batch, args.point_format)
        record = encode_record(
            {
                "sequence": batch.sequence,
                "pose_sequence": batch.pose_sequence,
                "timestamp": _now(),
                "point_count": int(batch.points.shape[0]),
                "pose": matrix_to_pose(batch.pose),
                "point_format": args.point_format,
            },
            payload,
        )
        client.send(args.iggy_stream, topic, [record])
        time.sleep(1.0 / args.rate)
    client.send(args.iggy_stream, topic, [json.dumps({"type": "close_session", "session_id": args.session_id}).encode()])
    print("done; the server's iggy consumer picks it up; viewer: http://localhost:8080/?session_id=" + args.session_id)
    return 0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    sys.exit(main())
