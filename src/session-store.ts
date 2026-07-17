import {
  POINT_FORMAT,
  POINT_STRIDE_BYTES,
  type CreateSessionMessage,
  type PointBatchHeaderMessage,
  type Pose,
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
  pointPayloads: Array<{
    header: PointBatchHeaderMessage;
    payload: Buffer;
    pose: Pose;
  }>;
}

export interface AcceptedBatch {
  session: SessionRecord;
  header: PointBatchHeaderMessage;
  payload: Buffer;
  pose: PoseUpdateMessage;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly recentBatchLimit: number;

  constructor(options?: { recentBatchLimit?: number }) {
    this.recentBatchLimit = options?.recentBatchLimit ?? 16;
  }

  createSession(message: CreateSessionMessage): SessionRecord {
    if (message.protocol_version !== 1) {
      throw new Error(`Unsupported protocol version ${message.protocol_version}`);
    }
    if (message.units !== 'meters') {
      throw new Error(`Unsupported units ${message.units}`);
    }
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
      pointPayloads: [],
    };

    this.sessions.set(session.sessionId, session);
    return session;
  }

  resumeSession(message: ResumeSessionMessage): SessionRecord {
    if (message.protocol_version !== 1) {
      throw new Error(`Unsupported protocol version ${message.protocol_version}`);
    }
    const session = this.requireSession(message.session_id);
    if (session.publisherId !== message.publisher_id) {
      throw new Error(`Publisher mismatch for session ${message.session_id}`);
    }
    session.closed = false;
    session.lastSeenAt = new Date().toISOString();
    return session;
  }

  closeSession(sessionId: string, publisherId: string, sequence: number): SessionRecord {
    const session = this.requireOwnedSession(sessionId, publisherId);
    this.assertNextSequence(session, sequence);
    session.closed = true;
    session.lastSequence = sequence;
    session.lastSeenAt = new Date().toISOString();
    return session;
  }

  applyPoseUpdate(message: PoseUpdateMessage): SessionRecord {
    const session = this.requireOwnedSession(message.session_id, message.publisher_id);
    this.assertNextSequence(session, message.sequence);
    validatePose(message);
    session.poses.set(message.sequence, message);
    session.lastPoseSequence = message.sequence;
    session.lastSequence = message.sequence;
    session.lastSeenAt = message.timestamp;
    return session;
  }

  acceptPointBatch(header: PointBatchHeaderMessage, payload: Buffer): AcceptedBatch {
    const session = this.requireOwnedSession(header.session_id, header.publisher_id);
    this.assertNextSequence(session, header.sequence);
    if (header.point_format !== POINT_FORMAT) {
      throw new Error(`Unsupported point format ${header.point_format}`);
    }
    if (header.stride_bytes !== POINT_STRIDE_BYTES) {
      throw new Error(`Unsupported stride ${header.stride_bytes}`);
    }
    if (!Number.isInteger(header.point_count) || header.point_count < 0) {
      throw new Error(`Invalid point_count ${header.point_count}`);
    }
    const expectedBytes = header.point_count * header.stride_bytes;
    if (payload.byteLength !== expectedBytes) {
      throw new Error(
        `Binary payload length mismatch: expected ${expectedBytes}, received ${payload.byteLength}`,
      );
    }
    const pose = session.poses.get(header.pose_sequence);
    if (!pose) {
      throw new Error(`Unknown pose_sequence ${header.pose_sequence}`);
    }

    session.pointPayloads.push({ header, payload, pose: pose.pose });
    if (session.pointPayloads.length > this.recentBatchLimit) {
      session.pointPayloads.shift();
    }
    session.pointBatches += 1;
    session.totalPoints += header.point_count;
    session.lastSequence = header.sequence;
    session.lastSeenAt = header.timestamp;

    return { session, header, payload, pose };
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

  getPointPayloads(
    sessionId: string,
  ): Array<{ header: PointBatchHeaderMessage; payload: Buffer; pose: Pose }> {
    return this.requireSession(sessionId).pointPayloads;
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
}

function validatePose(message: PoseUpdateMessage): void {
  const values = [...message.pose.translation_m, ...message.pose.rotation_xyzw];
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error('Pose contains non-finite values');
    }
  }
}
