"""pcv-align: fetch a session's batch log, build the pose graph, and install corrections."""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
import urllib.error
import urllib.request

from .graph import AlignConfig, align
from .log import read_log


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pose graph + loop closure over a point-cloud-visualizer session log"
    )
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--server-url", default="http://localhost:8080")
    parser.add_argument("--log-file", help="read this log instead of fetching it from the server")
    parser.add_argument("--out", help="also write the corrections JSON here")
    parser.add_argument("--dry-run", action="store_true", help="do not install the corrections")
    cfg = AlignConfig()
    parser.add_argument("--keyframe-distance", type=float, default=cfg.keyframe_distance_m)
    parser.add_argument("--keyframe-angle", type=float, default=cfg.keyframe_angle_deg)
    parser.add_argument("--loop-radius", type=float, default=cfg.loop_radius_m)
    parser.add_argument("--loop-min-gap", type=int, default=cfg.loop_min_gap)
    parser.add_argument("--loop-max-candidates", type=int, default=cfg.loop_max_candidates)
    parser.add_argument("--icp-voxel", type=float, default=cfg.icp_voxel_m)
    parser.add_argument("--icp-coarse", type=float, default=cfg.icp_coarse_m)
    parser.add_argument("--icp-fine", type=float, default=cfg.icp_fine_m)
    parser.add_argument("--min-fitness", type=float, default=cfg.min_fitness)
    parser.add_argument("--max-rmse", type=float, default=cfg.max_rmse_m)
    parser.add_argument("--max-range", type=float, default=None)
    parser.add_argument("--refine-odometry", action="store_true")
    return parser.parse_args(argv)


def config_from_args(args: argparse.Namespace) -> AlignConfig:
    return AlignConfig(
        keyframe_distance_m=args.keyframe_distance,
        keyframe_angle_deg=args.keyframe_angle,
        loop_radius_m=args.loop_radius,
        loop_min_gap=args.loop_min_gap,
        loop_max_candidates=args.loop_max_candidates,
        icp_voxel_m=args.icp_voxel,
        icp_coarse_m=args.icp_coarse,
        icp_fine_m=args.icp_fine,
        min_fitness=args.min_fitness,
        max_rmse_m=args.max_rmse,
        refine_odometry=args.refine_odometry,
        max_range_m=args.max_range,
    )


def fetch_log(server_url: str, session_id: str) -> str:
    url = f"{server_url.rstrip('/')}/sessions/{session_id}/log"
    handle = tempfile.NamedTemporaryFile(prefix=f"pcv-{session_id}-", suffix=".log", delete=False)
    with urllib.request.urlopen(url) as response, handle:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            handle.write(chunk)
    return handle.name


def install(server_url: str, session_id: str, corrections: dict) -> dict:
    url = f"{server_url.rstrip('/')}/sessions/{session_id}/pose-corrections"
    request = urllib.request.Request(
        url,
        data=json.dumps(corrections).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read())


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    log = lambda message: print(message, file=sys.stderr)
    try:
        log_path = args.log_file or fetch_log(args.server_url, args.session_id)
    except urllib.error.HTTPError as error:
        log(f"could not fetch log: {error}")
        return 1
    batches = list(read_log(log_path, on_warning=log))
    if not batches:
        log("log holds no batches")
        return 1
    result = align(batches, config_from_args(args), log)
    corrections = result.to_corrections(args.session_id)
    log(
        f"keyframes={len(result.keyframes)} candidates={result.candidates} "
        f"loops={len(result.loops)} max_correction={result.stats['max_keyframe_correction_m']:.2f} m "
        f"in {result.stats['seconds']} s"
    )
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(corrections, handle)
        log(f"wrote {args.out}")
    if args.dry_run:
        return 0
    if not result.loops:
        log("nothing to install (no loops accepted)")
        return 0
    try:
        response = install(args.server_url, args.session_id, corrections)
    except urllib.error.HTTPError as error:
        log(f"server rejected corrections: {error.read().decode('utf-8', 'replace')}")
        return 1
    log(f"installed: rebuilt {response.get('batches')} batches into {response.get('chunks')} chunks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
