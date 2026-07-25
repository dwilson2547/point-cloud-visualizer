import test from 'node:test';
import assert from 'node:assert/strict';

import { POINT_FORMAT, POINT_STRIDE_BYTES } from '../src/protocol.js';
import { SessionStore } from '../src/session-store.js';

test('creates a session, accepts pose updates, and accepts a point batch', () => {
  const store = new SessionStore();

  store.createSession({
    type: 'create_session',
    protocol_version: 1,
    session_id: 'session-a',
    publisher_id: 'publisher-a',
    started_at: '2026-07-10T00:00:00Z',
    frame_id: 'map',
    units: 'meters',
  });

  store.applyPoseUpdate({
    type: 'pose_update',
    session_id: 'session-a',
    publisher_id: 'publisher-a',
    sequence: 1,
    timestamp: '2026-07-10T00:00:01Z',
    pose: {
      translation_m: [1, 2, 3],
      rotation_xyzw: [0, 0, 0, 1],
    },
  });

  const payload = Buffer.alloc(POINT_STRIDE_BYTES * 2);
  const accepted = store.acceptPointBatch(
    {
      type: 'point_batch_header',
      session_id: 'session-a',
      publisher_id: 'publisher-a',
      sequence: 2,
      timestamp: '2026-07-10T00:00:02Z',
      pose_sequence: 1,
      point_count: 2,
      point_format: POINT_FORMAT,
      encoding: 'binary_le',
      compression: 'none',
      stride_bytes: POINT_STRIDE_BYTES,
    },
    payload,
  );

  assert.equal(accepted.session.totalPoints, 2);
  assert.equal(accepted.session.pointBatches, 1);

  const state = store.getSessionState('session-a');
  assert.equal(state.total_points, 2);
  assert.equal(state.point_batches, 1);
  assert.equal(state.last_sequence, 2);
  assert.equal(state.last_pose_sequence, 1);
});

test('rejects out-of-order sequence numbers', () => {
  const store = new SessionStore();

  store.createSession({
    type: 'create_session',
    protocol_version: 1,
    session_id: 'session-b',
    publisher_id: 'publisher-b',
    started_at: '2026-07-10T00:00:00Z',
    frame_id: 'map',
    units: 'meters',
  });

  assert.throws(
    () =>
      store.applyPoseUpdate({
        type: 'pose_update',
        session_id: 'session-b',
        publisher_id: 'publisher-b',
        sequence: 2,
        timestamp: '2026-07-10T00:00:01Z',
        pose: {
          translation_m: [0, 0, 0],
          rotation_xyzw: [0, 0, 0, 1],
        },
      }),
    /Expected sequence 1, received 2/,
  );
});

test('restores persisted sessions and requires a fresh pose after resume', () => {
  const store = new SessionStore();
  store.restoreSessions([
    {
      sessionId: 'restored-session',
      publisherId: 'restored-publisher',
      startedAt: '2026-07-10T00:00:00Z',
      lastSeenAt: '2026-07-10T00:00:02Z',
      frameId: 'map',
      units: 'meters',
      closed: false,
      lastSequence: 2,
      lastPoseSequence: 1,
      totalPoints: 10,
      pointBatches: 1,
    },
  ]);

  const session = store.resumeSession({
    type: 'resume_session',
    protocol_version: 1,
    session_id: 'restored-session',
    publisher_id: 'restored-publisher',
    last_client_sequence: 2,
  });
  assert.equal(session.lastSequence, 2);
  assert.equal(session.poses.size, 0);

  store.applyPoseUpdate({
    type: 'pose_update',
    session_id: 'restored-session',
    publisher_id: 'restored-publisher',
    sequence: 3,
    timestamp: '2026-07-10T00:00:03Z',
    pose: {
      translation_m: [0, 0, 0],
      rotation_xyzw: [0, 0, 0, 1],
    },
  });
  assert.equal(session.poses.size, 1);
});

test('bounds retained poses and rejects invalid point coordinates without advancing sequence', () => {
  const store = new SessionStore({ maxRetainedPoses: 2 });
  const session = store.createSession({
    type: 'create_session',
    protocol_version: 1,
    session_id: 'bounded-session',
    publisher_id: 'bounded-publisher',
    started_at: '2026-07-10T00:00:00Z',
    frame_id: 'map',
    units: 'meters',
  });

  for (let sequence = 1; sequence <= 3; sequence += 1) {
    store.applyPoseUpdate({
      type: 'pose_update',
      session_id: session.sessionId,
      publisher_id: session.publisherId,
      sequence,
      timestamp: `2026-07-10T00:00:0${sequence}Z`,
      pose: {
        translation_m: [sequence, 0, 0],
        rotation_xyzw: [0, 0, 0, 1],
      },
    });
  }
  assert.equal(session.poses.size, 2);
  assert.equal(session.poses.has(1), false);

  const payload = Buffer.alloc(POINT_STRIDE_BYTES);
  payload.writeFloatLE(Number.NaN, 0);
  assert.throws(
    () =>
      store.preparePointBatch(
        {
          type: 'point_batch_header',
          session_id: session.sessionId,
          publisher_id: session.publisherId,
          sequence: 4,
          timestamp: '2026-07-10T00:00:04Z',
          pose_sequence: 3,
          point_count: 1,
          point_format: POINT_FORMAT,
          encoding: 'binary_le',
          compression: 'none',
          stride_bytes: POINT_STRIDE_BYTES,
        },
        payload,
      ),
    /non-finite coordinates/,
  );
  assert.equal(session.lastSequence, 3);
});
