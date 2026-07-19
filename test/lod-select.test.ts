import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFrustum,
  levelForVoxel,
  nearestDistanceToAabb,
  selectChunkLevel,
  type Aabb,
  type LodLadder,
  type ViewCamera,
} from '../src/lod-select.js';

const ladder: LodLadder = { fuseVoxelMeters: 0.04, numLevels: 6 };
// Level -> voxel edge for this ladder: 0:1.28 1:0.64 2:0.32 3:0.16 4:0.08 5:0.04

test('levelForVoxel maps a desired voxel size to the coarsest non-gapping level', () => {
  assert.equal(levelForVoxel(0.04, ladder), 5); // finest
  assert.equal(levelForVoxel(0.08, ladder), 4);
  assert.equal(levelForVoxel(0.16, ladder), 3);
  assert.equal(levelForVoxel(0.64, ladder), 1);
  assert.equal(levelForVoxel(1.28, ladder), 0); // coarsest
  assert.equal(levelForVoxel(10, ladder), 0); // very far — clamps to coarsest
  assert.equal(levelForVoxel(0.001, ladder), 5); // very close — clamps to finest
  assert.equal(levelForVoxel(0, ladder), 5); // degenerate guard
  assert.equal(levelForVoxel(-1, ladder), 5);
});

test('nearestDistanceToAabb is 0 inside and the gap outside', () => {
  const box: Aabb = { min: [1, -1, -1], max: [2, 1, 1] };
  assert.equal(nearestDistanceToAabb([1.5, 0, 0], box), 0);
  assert.equal(nearestDistanceToAabb([0, 0, 0], box), 1); // 1 m short in x
  assert.ok(Math.abs(nearestDistanceToAabb([4, 0, 0], box) - 2) < 1e-9); // 2 m past in x
});

function cameraLookingX(overrides: Partial<ViewCamera> = {}): ViewCamera {
  return {
    position: [0, 0, 0],
    forward: [1, 0, 0],
    up: [0, 0, 1],
    fovYRad: Math.PI / 3, // 60 deg
    viewportPx: [1000, 1000],
    nearM: 0.1,
    farM: 100,
    ...overrides,
  };
}

const boxAt = (distance: number, half = 0.1): Aabb => ({
  min: [distance - half, -half, -half],
  max: [distance + half, half, half],
});

test('selectChunkLevel picks finer levels closer and is monotonic non-increasing with distance', () => {
  const frustum = buildFrustum(cameraLookingX());

  const near = selectChunkLevel(boxAt(1), frustum, ladder);
  const far = selectChunkLevel(boxAt(90), frustum, ladder);
  assert.equal(near, 5, 'a chunk right in front should load at the finest level');
  assert.notEqual(far, null);
  assert.ok((far as number) < (near as number), 'farther chunk must be coarser');

  // Non-increasing across a sweep of distances.
  let previous = 6;
  for (const distance of [1, 10, 30, 50, 70, 90]) {
    const level = selectChunkLevel(boxAt(distance), frustum, ladder);
    assert.notEqual(level, null);
    assert.ok((level as number) <= previous, `level should not rise with distance at ${distance} m`);
    previous = level as number;
  }
});

test('selectChunkLevel culls chunks behind, beyond far, and outside the FOV', () => {
  const frustum = buildFrustum(cameraLookingX());
  assert.equal(selectChunkLevel(boxAt(-5), frustum, ladder), null, 'behind the camera');
  assert.equal(selectChunkLevel(boxAt(150), frustum, ladder), null, 'beyond the far plane');
  // Far off to the side (camera looks +X; this box is 50 m along +Y at x=1).
  const sideBox: Aabb = { min: [0.9, 49.9, -0.1], max: [1.1, 50.1, 0.1] };
  assert.equal(selectChunkLevel(sideBox, frustum, ladder), null, 'outside the side plane');
});

test('smaller viewport (voxels project smaller) drives coarser level selection', () => {
  // Same geometry, 100 px tall viewport -> a distant chunk resolves to a coarse level.
  const frustum = buildFrustum(cameraLookingX({ viewportPx: [100, 100] }));
  const level = selectChunkLevel(boxAt(50), frustum, ladder);
  assert.notEqual(level, null);
  assert.ok((level as number) <= 2, 'a small viewport should select a coarse level at 50 m');
});

test('buildFrustum tolerates forward parallel to up without producing NaNs', () => {
  const frustum = buildFrustum(cameraLookingX({ forward: [0, 0, 1], up: [0, 0, 1] }));
  const ahead: Aabb = { min: [-0.1, -0.1, 4.9], max: [0.1, 0.1, 5.1] };
  const level = selectChunkLevel(ahead, frustum, ladder);
  assert.notEqual(level, null);
  assert.ok(Number.isFinite(level as number));
});
