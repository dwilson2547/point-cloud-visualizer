// View-driven LOD selection and frustum/range culling. Pure geometry, no three.js or
// store dependency, so it is cheap to unit-test and to call per chunk on each viewer
// view update. The server (2b-3) builds one frustum per `viewer_view` and calls
// selectChunkLevel against each chunk's stored AABB.

export type Vec3 = [number, number, number];

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

// A viewer camera in the session world frame. `forward`/`up` need not be normalized or
// orthogonal — they are cleaned up internally.
export interface ViewCamera {
  position: Vec3;
  forward: Vec3;
  up: Vec3;
  fovYRad: number;
  viewportPx: [number, number]; // width, height
  nearM: number;
  farM: number;
}

// The LOD ladder shape (matches ChunkStore.fuseVoxelMeters / numLevels).
export interface LodLadder {
  fuseVoxelMeters: number;
  numLevels: number;
}

interface Plane {
  n: Vec3; // inward normal — a point X is inside this plane when n·X + d >= 0
  d: number;
}

// Precomputed view volume: 6 inward-facing planes plus the scalars level selection
// needs, so a chunk test is a handful of dot products.
export interface Frustum {
  planes: Plane[];
  position: Vec3;
  tanHalfFovY: number;
  viewportH: number;
  nearM: number;
  farM: number;
}

// Default target on-screen voxel size (px). Kept near the viewer's fixed point size so
// a chunk's chosen level has point spacing ~= a pixel: no holes, little oversampling.
export const DEFAULT_TARGET_PX = 1.5;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

// Plane through point `p` spanned by rays `a` and `b`, with its normal flipped so that
// `interior` lies on the inside. Flipping by a known-interior direction makes the result
// independent of the winding of a/b.
function planeThrough(p: Vec3, a: Vec3, b: Vec3, interior: Vec3): Plane {
  let n = cross(a, b);
  if (dot(n, interior) < 0) {
    n = [-n[0], -n[1], -n[2]];
  }
  return { n, d: -dot(n, p) };
}

export function buildFrustum(camera: ViewCamera): Frustum {
  const forward = normalize(camera.forward);
  let right = cross(forward, camera.up);
  if (Math.hypot(right[0], right[1], right[2]) < 1e-9) {
    // forward and up are parallel; fall back to an arbitrary perpendicular axis.
    right = cross(forward, [0, 0, 1]);
    if (Math.hypot(right[0], right[1], right[2]) < 1e-9) {
      right = cross(forward, [0, 1, 0]);
    }
  }
  right = normalize(right);
  const up = normalize(cross(right, forward));

  const aspect = camera.viewportPx[1] > 0 ? camera.viewportPx[0] / camera.viewportPx[1] : 1;
  const tanY = Math.tan(camera.fovYRad / 2);
  const tanX = tanY * aspect;

  // Corner rays at unit forward distance.
  const topLeft = add(add(forward, scale(up, tanY)), scale(right, -tanX));
  const topRight = add(add(forward, scale(up, tanY)), scale(right, tanX));
  const botLeft = add(add(forward, scale(up, -tanY)), scale(right, -tanX));
  const botRight = add(add(forward, scale(up, -tanY)), scale(right, tanX));

  const p = camera.position;
  const nearNormal = forward;
  const planes: Plane[] = [
    // near / far
    { n: nearNormal, d: -dot(nearNormal, add(p, scale(forward, camera.nearM))) },
    { n: scale(forward, -1), d: -dot(scale(forward, -1), add(p, scale(forward, camera.farM))) },
    // sides — all pass through the eye; forward is a known-interior direction.
    planeThrough(p, botLeft, topLeft, forward), // left
    planeThrough(p, topRight, botRight, forward), // right
    planeThrough(p, topLeft, topRight, forward), // top
    planeThrough(p, botRight, botLeft, forward), // bottom
  ];

  return {
    planes,
    position: p,
    tanHalfFovY: tanY,
    viewportH: camera.viewportPx[1],
    nearM: camera.nearM,
    farM: camera.farM,
  };
}

// Conservative AABB-in-frustum test: false only when the box is wholly outside some
// plane. Uses the box's positive vertex (farthest along each plane normal), so it never
// culls a visible box (may keep some just-outside ones — fine for a bandwidth cull).
export function frustumContainsAabb(frustum: Frustum, aabb: Aabb): boolean {
  for (const plane of frustum.planes) {
    const px = plane.n[0] >= 0 ? aabb.max[0] : aabb.min[0];
    const py = plane.n[1] >= 0 ? aabb.max[1] : aabb.min[1];
    const pz = plane.n[2] >= 0 ? aabb.max[2] : aabb.min[2];
    if (plane.n[0] * px + plane.n[1] * py + plane.n[2] * pz + plane.d < 0) {
      return false;
    }
  }
  return true;
}

// Shortest distance from a point to an AABB (0 when inside).
export function nearestDistanceToAabb(point: Vec3, aabb: Aabb): number {
  const dx = Math.max(aabb.min[0] - point[0], 0, point[0] - aabb.max[0]);
  const dy = Math.max(aabb.min[1] - point[1], 0, point[1] - aabb.max[1]);
  const dz = Math.max(aabb.min[2] - point[2], 0, point[2] - aabb.max[2]);
  return Math.hypot(dx, dy, dz);
}

// The LOD level whose voxel edge is the coarsest that still renders at or below the
// desired on-screen size — i.e. the fewest points that avoid visible gaps. Clamped to
// [0, finest].
export function levelForVoxel(desiredVoxelMeters: number, ladder: LodLadder): number {
  const finest = ladder.numLevels - 1;
  const ratio = desiredVoxelMeters / ladder.fuseVoxelMeters;
  if (!(ratio > 0)) {
    return finest;
  }
  const level = finest - Math.floor(Math.log2(ratio));
  return level < 0 ? 0 : level > finest ? finest : level;
}

// Choose the LOD level for a chunk given a prebuilt frustum, or null if the chunk is
// culled (outside the frustum or beyond the far distance). Level rises (finer) as the
// chunk gets closer / fills more of the screen.
export function selectChunkLevel(
  aabb: Aabb,
  frustum: Frustum,
  ladder: LodLadder,
  targetPx: number = DEFAULT_TARGET_PX,
): number | null {
  if (!frustumContainsAabb(frustum, aabb)) {
    return null;
  }
  const distance = nearestDistanceToAabb(frustum.position, aabb);
  if (distance > frustum.farM) {
    return null;
  }
  const effective = Math.max(distance, frustum.nearM);
  const desiredVoxel = (targetPx * 2 * effective * frustum.tanHalfFovY) / frustum.viewportH;
  return levelForVoxel(desiredVoxel, ladder);
}
