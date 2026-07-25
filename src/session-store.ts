import {
  POINT_FORMAT,
  POINT_STRIDE_BYTES,
  type CreateSessionMessage,
  type PointBatchHeaderMessage,
  type PoseUpdateMessage,
  type ResumeSessionMessage,
  type SessionMetadata,
  type ViewerSessionStateMessage,
} from './protocol.js';

export interface SessionRecord {
  sessionId: string;
  publisherId: string;
  startedAt: string;
  lastSeenAt: string;
  frameId: string;
  units: string;
  metadata?: SessionMetadata;
  closed: boolean;
  lastSequence: number;
  lastPoseSequence: number | null;
  totalPoints: number;
  pointBatches: number;
  poses: Map<number, PoseUpdateMessage>;
}

export interface SessionSnapshot {
  sessionId: string;
  publisherId: string;
  startedAt: string;
  lastSeenAt: string;
  frameId: string;
  units: string;
  metadata?: SessionMetadata;
  closed: boolean;
  lastSequence: number;
  lastPoseSequence: number | null;
  totalPoints: number;
  pointBatches: number;
}

export interface AcceptedBatch {
  session: SessionRecord;
  header: PointBatchHeaderMessage;
  payload: Buffer;
  pose: PoseUpdateMessage;
}

export interface SessionStoreOptions {
  maxPointsPerBatch?: number;
  maxRetainedPoses?: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly maxPointsPerBatch: number;
  private readonly maxRetainedPoses: number;

  constructor(options: SessionStoreOptions = {}) {
    this.maxPointsPerBatch = options.maxPointsPerBatch ?? 1_000_000;
    this.maxRetainedPoses = options.maxRetainedPoses ?? 64;
  }

  restoreSessions(snapshots: SessionSnapshot[]): void {
    for (const snapshot of snapshots) {
      validateIdentifier(snapshot.sessionId, 'session_id');
      validateIdentifier(snapshot.publisherId, 'publisher_id');
      this.sessions.set(snapshot.sessionId, {
        ...snapshot,
        // Poses are deliberately not restored. A resumed publisher must establish a
        // fresh pose before sending more points.
        poses: new Map(),
      });
    }
  }

  createSession(message: CreateSessionMessage): SessionRecord {
    if (message.protocol_version !== 1) {
      throw new Error(`Unsupported protocol version ${message.protocol_version}`);
    }
    if (message.units !== 'meters') {
      throw new Error(`Unsupported units ${message.units}`);
    }
    validateIdentifier(message.session_id, 'session_id');
    validateIdentifier(message.publisher_id, 'publisher_id');
    validateText(message.frame_id, 'frame_id', 128);
    validateTimestamp(message.started_at, 'started_at');
    if (this.sessions.has(message.session_id)) {
      throw new Error(`Session ${message.session_id} already exists`);
    }

    const now = new Date().toISOString();
    const session: SessionRecord = {
      sessionId: message.session_id,
      publisherId: message.publisher_id,
      startedAt: message.started_at,
      lastSeenAt: now,
      frameId: message.frame_id,
      units: message.units,
      metadata: message.metadata,
      closed: false,
      lastSequence: 0,
      lastPoseSequence: null,
      totalPoints: 0,
      pointBatches: 0,
      poses: new Map(),
    };

    this.sessions.set(session.sessionId, session);
    return session;
  }

  resumeSession(message: ResumeSessionMessage): SessionRecord {
    if (message.protocol_version !== 1) {
      throw new Error(`Unsupported protocol version ${message.protocol_version}`);
    }
    validateIdentifier(message.session_id, 'session_id');
    validateIdentifier(message.publisher_id, 'publisher_id');
    if (!Number.isInteger(message.last_client_sequence) || message.last_client_sequence < 0) {
      throw new Error(`Invalid last_client_sequence ${message.last_client_sequence}`);
    }
    const session = this.requireSession(message.session_id);
    if (session.publisherId !== message.publisher_id) {
      throw new Error(`Publisher mismatch for session ${message.session_id}`);
    }
    if (message.last_client_sequence > session.lastSequence) {
      throw new Error(
        `Client sequence ${message.last_client_sequence} is ahead of server sequence ${session.lastSequence}`,
      );
    }
    session.closed = false;
    session.poses.clear();
    session.lastSeenAt = new Date().toISOString();
    return session;
  }

  closeSession(sessionId: string, publisherId: string, sequence: number): SessionRecord {
    const session = this.requireOwnedSession(sessionId, publisherId);
    this.assertOpen(session);
    this.assertNextSequence(session, sequence);
    session.closed = true;
    session.lastSequence = sequence;
    session.lastSeenAt = new Date().toISOString();
    return session;
  }

  applyPoseUpdate(message: PoseUpdateMessage): SessionRecord {
    const session = this.requireOwnedSession(message.session_id, message.publisher_id);
    this.assertOpen(session);
    this.assertNextSequence(session, message.sequence);
    validatePose(message);
    validateTimestamp(message.timestamp, 'timestamp');
    session.poses.set(message.sequence, message);
    while (session.poses.size > this.maxRetainedPoses) {
      const oldest = session.poses.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      session.poses.delete(oldest);
    }
    session.lastPoseSequence = message.sequence;
    session.lastSequence = message.sequence;
    session.lastSeenAt = message.timestamp;
    return session;
  }

  preparePointBatch(header: PointBatchHeaderMessage, payload: Buffer): AcceptedBatch {
    const session = this.requireOwnedSession(header.session_id, header.publisher_id);
    this.assertOpen(session);
    this.assertNextSequence(session, header.sequence);
    if (header.point_format !== POINT_FORMAT) {
      throw new Error(`Unsupported point format ${header.point_format}`);
    }
    if (header.stride_bytes !== POINT_STRIDE_BYTES) {
      throw new Error(`Unsupported stride ${header.stride_bytes}`);
    }
    if (
      !Number.isInteger(header.point_count) ||
      header.point_count < 0 ||
      header.point_count > this.maxPointsPerBatch
    ) {
      throw new Error(`Invalid point_count ${header.point_count}`);
    }
    validateTimestamp(header.timestamp, 'timestamp');
    if (!Number.isInteger(header.pose_sequence) || header.pose_sequence <= 0) {
      throw new Error(`Invalid pose_sequence ${header.pose_sequence}`);
    }
    const expectedBytes = header.point_count * header.stride_bytes;
    if (payload.byteLength !== expectedBytes) {
      throw new Error(
        `Binary payload length mismatch: expected ${expectedBytes}, received ${payload.byteLength}`,
      );
    }
    const pose = session.poses.get(header.pose_sequence);
    if (!pose) {
      throw new Error(
        `Unknown pose_sequence ${header.pose_sequence}; send a fresh pose after resuming a session`,
      );
    }
    validatePointPayload(payload);

    return { session, header, payload, pose };
  }

  commitPointBatch(accepted: AcceptedBatch): SessionRecord {
    const { session, header } = accepted;
    this.assertNextSequence(session, header.sequence);
    session.pointBatches += 1;
    session.totalPoints += header.point_count;
    session.lastSequence = header.sequence;
    session.lastSeenAt = header.timestamp;
    return session;
  }

  acceptPointBatch(header: PointBatchHeaderMessage, payload: Buffer): AcceptedBatch {
    const accepted = this.preparePointBatch(header, payload);
    this.commitPointBatch(accepted);
    return accepted;
  }

  getSessionState(sessionId: string): ViewerSessionStateMessage {
    const session = this.requireSession(sessionId);
    return {
      type: 'viewer_session_state',
      session_id: session.sessionId,
      point_batches: session.pointBatches,
      total_points: session.totalPoints,
      last_sequence: session.lastSequence,
      last_pose_sequence: session.lastPoseSequence,
    };
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return session;
  }

  private requireOwnedSession(sessionId: string, publisherId: string): SessionRecord {
    const session = this.requireSession(sessionId);
    if (session.publisherId !== publisherId) {
      throw new Error(`Publisher mismatch for session ${sessionId}`);
    }
    return session;
  }

  private assertNextSequence(session: SessionRecord, incomingSequence: number): void {
    if (!Number.isInteger(incomingSequence) || incomingSequence <= 0) {
      throw new Error(`Invalid sequence ${incomingSequence}`);
    }
    const expected = session.lastSequence + 1;
    if (incomingSequence !== expected) {
      throw new Error(`Expected sequence ${expected}, received ${incomingSequence}`);
    }
  }

  private assertOpen(session: SessionRecord): void {
    if (session.closed) {
      throw new Error(`Session ${session.sessionId} is closed; resume it before publishing`);
    }
  }
}

function validatePose(message: PoseUpdateMessage): void {
  if (
    !isFiniteTuple(message.pose?.translation_m, 3) ||
    !isFiniteTuple(message.pose?.rotation_xyzw, 4)
  ) {
    throw new Error('Pose requires finite translation_m[3] and rotation_xyzw[4]');
  }
  const values = [...message.pose.translation_m, ...message.pose.rotation_xyzw];
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error('Pose contains non-finite values');
    }
  }
  const rotation = message.pose.rotation_xyzw;
  const norm = Math.hypot(...rotation);
  if (norm < 1e-9 || Math.abs(norm - 1) > 0.05) {
    throw new Error(`Pose quaternion must be normalized; received norm ${norm}`);
  }
  message.pose.rotation_xyzw = rotation.map((value) => value / norm) as [number, number, number, number];
}

function validatePointPayload(payload: Buffer): void {
  for (let offset = 0; offset < payload.byteLength; offset += POINT_STRIDE_BYTES) {
    if (
      !Number.isFinite(payload.readFloatLE(offset)) ||
      !Number.isFinite(payload.readFloatLE(offset + 4)) ||
      !Number.isFinite(payload.readFloatLE(offset + 8))
    ) {
      throw new Error(`Point at index ${offset / POINT_STRIDE_BYTES} contains non-finite coordinates`);
    }
  }
}

function validateIdentifier(value: string, name: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(
      `${name} must be 1-128 characters using letters, numbers, dot, underscore, or hyphen`,
    );
  }
}

function validateText(value: string, name: string, maxLength: number): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string no longer than ${maxLength} characters`);
  }
}

function validateTimestamp(value: string, name: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a valid timestamp`);
  }
}

function isFiniteTuple(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => Number.isFinite(entry))
  );
}
