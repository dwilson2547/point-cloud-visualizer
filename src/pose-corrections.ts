// Pose corrections: an optional per-session overlay produced by the alignment sidecar
// (pose graph + loop closure, see docs/alignment.md). The batch log keeps the poses a
// publisher sent; corrections are applied when a batch is fused, so they can be
// replaced or removed and the session rebuilt from the log at any time.
//
// `poses` corrects specific pose sequences. `tail` is a world-frame transform applied
// to every pose *after* the last corrected sequence, so batches still arriving from a
// live publisher (whose odometry continues in the old, drifted frame) land in the
// corrected frame too.
import fs from 'node:fs';
import path from 'node:path';

import type { Pose } from './protocol.js';

export interface PoseCorrections {
  session_id: string;
  generated_at: string;
  // Sorted by pose_sequence ascending.
  poses: Array<{ pose_sequence: number; pose: Pose }>;
  tail?: Pose;
  // Free-form provenance from the producer (keyframes, loops accepted, ...).
  metadata?: Record<string, unknown>;
}

export class PoseCorrectionMap {
  private readonly bySequence = new Map<number, Pose>();
  private readonly lastCorrected: number;

  constructor(readonly corrections: PoseCorrections) {
    for (const entry of corrections.poses) {
      this.bySequence.set(entry.pose_sequence, entry.pose);
    }
    this.lastCorrected = corrections.poses.length > 0
      ? corrections.poses[corrections.poses.length - 1].pose_sequence
      : -1;
  }

  // The pose to fuse a batch with: the explicit correction for its pose sequence, else
  // the tail transform composed onto the logged pose when it is past the last
  // corrected sequence, else the logged pose unchanged.
  apply(poseSequence: number, logged: Pose): Pose {
    const corrected = this.bySequence.get(poseSequence);
    if (corrected) {
      return corrected;
    }
    if (this.corrections.tail && poseSequence > this.lastCorrected) {
      return composePoses(this.corrections.tail, logged);
    }
    return logged;
  }
}

// world_T_b = a ∘ b : rotate b's translation by a, add a's translation; multiply
// quaternions (xyzw, Hamilton product).
export function composePoses(a: Pose, b: Pose): Pose {
  const [ax, ay, az, aw] = a.rotation_xyzw;
  const [bx, by, bz, bw] = b.rotation_xyzw;
  const rotation: [number, number, number, number] = [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
  const rotated = rotateVector(a.rotation_xyzw, b.translation_m);
  return {
    translation_m: [
      rotated[0] + a.translation_m[0],
      rotated[1] + a.translation_m[1],
      rotated[2] + a.translation_m[2],
    ],
    rotation_xyzw: rotation,
  };
}

export function rotateVector(
  q: [number, number, number, number],
  v: [number, number, number],
): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const [x, y, z] = v;
  const uvx = qy * z - qz * y;
  const uvy = qz * x - qx * z;
  const uvz = qx * y - qy * x;
  const uuvx = qy * uvz - qz * uvy;
  const uuvy = qz * uvx - qx * uvz;
  const uuvz = qx * uvy - qy * uvx;
  return [
    x + 2 * (qw * uvx + uuvx),
    y + 2 * (qw * uvy + uuvy),
    z + 2 * (qw * uvz + uuvz),
  ];
}

export function validatePoseCorrections(input: unknown, sessionId: string): PoseCorrections {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Pose corrections must be a JSON object');
  }
  const body = input as Partial<PoseCorrections>;
  if (body.session_id !== undefined && body.session_id !== sessionId) {
    throw new Error(`Pose corrections session_id ${body.session_id} does not match ${sessionId}`);
  }
  if (!Array.isArray(body.poses)) {
    throw new Error('Pose corrections require a poses array');
  }
  const poses = body.poses.map((entry, index) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !Number.isInteger((entry as { pose_sequence?: unknown }).pose_sequence) ||
      ((entry as { pose_sequence: number }).pose_sequence) <= 0
    ) {
      throw new Error(`poses[${index}] requires a positive integer pose_sequence`);
    }
    return {
      pose_sequence: (entry as { pose_sequence: number }).pose_sequence,
      pose: validatePose((entry as { pose?: unknown }).pose, `poses[${index}].pose`),
    };
  });
  poses.sort((a, b) => a.pose_sequence - b.pose_sequence);
  for (let i = 1; i < poses.length; i++) {
    if (poses[i].pose_sequence === poses[i - 1].pose_sequence) {
      throw new Error(`Duplicate pose_sequence ${poses[i].pose_sequence} in pose corrections`);
    }
  }
  return {
    session_id: sessionId,
    generated_at:
      typeof body.generated_at === 'string' ? body.generated_at : new Date().toISOString(),
    poses,
    tail: body.tail === undefined || body.tail === null ? undefined : validatePose(body.tail, 'tail'),
    metadata:
      typeof body.metadata === 'object' && body.metadata !== null
        ? (body.metadata as Record<string, unknown>)
        : undefined,
  };
}

function validatePose(input: unknown, name: string): Pose {
  const pose = input as Partial<Pose> | undefined;
  const translation = pose?.translation_m;
  const rotation = pose?.rotation_xyzw;
  if (
    !Array.isArray(translation) ||
    translation.length !== 3 ||
    !translation.every((value) => Number.isFinite(value)) ||
    !Array.isArray(rotation) ||
    rotation.length !== 4 ||
    !rotation.every((value) => Number.isFinite(value))
  ) {
    throw new Error(`${name} requires finite translation_m[3] and rotation_xyzw[4]`);
  }
  const norm = Math.hypot(...(rotation as number[]));
  if (norm < 1e-9 || Math.abs(norm - 1) > 0.05) {
    throw new Error(`${name} quaternion must be normalized; received norm ${norm}`);
  }
  return {
    translation_m: [translation[0], translation[1], translation[2]],
    rotation_xyzw: [
      rotation[0] / norm,
      rotation[1] / norm,
      rotation[2] / norm,
      rotation[3] / norm,
    ],
  };
}

export function poseCorrectionsPath(rootDir: string, sessionId: string): string {
  return path.join(rootDir, 'poses', `${sessionId}.json`);
}

export function loadPoseCorrections(rootDir: string, sessionId: string): PoseCorrections | null {
  let text: string;
  try {
    text = fs.readFileSync(poseCorrectionsPath(rootDir, sessionId), 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  return validatePoseCorrections(JSON.parse(text), sessionId);
}

export function savePoseCorrections(rootDir: string, corrections: PoseCorrections): void {
  const filePath = poseCorrectionsPath(rootDir, corrections.session_id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(corrections));
  fs.renameSync(temporary, filePath);
}

export function deletePoseCorrections(rootDir: string, sessionId: string): boolean {
  try {
    fs.unlinkSync(poseCorrectionsPath(rootDir, sessionId));
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
