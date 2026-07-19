export const PROTOCOL_VERSION = 1;
export const POINT_FORMAT = 'xyz_rgb_i_v1';
export const POINT_STRIDE_BYTES = 18;
export const VIEWER_ROLE = 'viewer';
export const INGEST_ROLE = 'ingest';

export type ConnectionRole = typeof VIEWER_ROLE | typeof INGEST_ROLE;

export interface SessionMetadata {
  project_id?: string;
  site_id?: string;
  room_id?: string;
}

export interface Pose {
  translation_m: [number, number, number];
  rotation_xyzw: [number, number, number, number];
}

export interface CreateSessionMessage {
  type: 'create_session';
  protocol_version: number;
  session_id: string;
  publisher_id: string;
  started_at: string;
  frame_id: string;
  units: string;
  metadata?: SessionMetadata;
}

export interface ResumeSessionMessage {
  type: 'resume_session';
  protocol_version: number;
  session_id: string;
  publisher_id: string;
  last_client_sequence: number;
}

export interface PoseUpdateMessage {
  type: 'pose_update';
  session_id: string;
  publisher_id: string;
  sequence: number;
  timestamp: string;
  pose: Pose;
}

export interface PointBatchHeaderMessage {
  type: 'point_batch_header';
  session_id: string;
  publisher_id: string;
  sequence: number;
  timestamp: string;
  pose_sequence: number;
  point_count: number;
  point_format: string;
  encoding: 'binary_le';
  compression: 'none';
  stride_bytes: number;
  bounds_local?: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

export interface CloseSessionMessage {
  type: 'close_session';
  session_id: string;
  publisher_id: string;
  sequence: number;
}

export interface ViewerJoinMessage {
  type: 'viewer_join';
  session_id: string;
}

// Sent by an LOD-mode viewer (throttled, on camera settle) so the server can pick a
// per-chunk detail level and cull chunks outside the view. Camera is in the session
// world frame; forward/up need not be normalized or orthogonal.
export interface ViewerViewMessage {
  type: 'viewer_view';
  session_id: string;
  position: [number, number, number];
  forward: [number, number, number];
  up: [number, number, number];
  fov_y_rad: number;
  viewport_px: [number, number]; // width, height
  near_m: number;
  far_m: number;
}

export type ClientControlMessage =
  | CreateSessionMessage
  | ResumeSessionMessage
  | PoseUpdateMessage
  | PointBatchHeaderMessage
  | CloseSessionMessage
  | ViewerJoinMessage
  | ViewerViewMessage;

export interface SessionAckMessage {
  type: 'session_ack';
  session_id: string;
  accepted: boolean;
  server_sequence: number;
  resume_from_sequence: number;
  viewer_endpoint: string;
}

export interface PointBatchAckMessage {
  type: 'point_batch_ack';
  session_id: string;
  sequence: number;
  accepted_points: number;
  rejected_points: number;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
  session_id?: string;
  retryable: boolean;
}

export interface ViewerSessionStateMessage {
  type: 'viewer_session_state';
  session_id: string;
  point_batches: number;
  total_points: number;
  last_sequence: number;
  last_pose_sequence: number | null;
}

export interface ChunkUpdateMessage {
  type: 'chunk_update';
  session_id: string;
  sequence: number;
  pose_sequence: number;
  point_count: number;
  point_format: string;
  stride_bytes: number;
  timestamp: string;
  // World transform for this batch's local-frame points. Viewers apply this to
  // place points in the session world frame (the disk chunk store applies the
  // same transform on the persistence path).
  pose: Pose;
}

// Sent to a viewer on join, once per source chunk, to bootstrap the accumulated
// world cloud from disk. Points are already world-frame (no pose — unlike the live
// chunk_update deltas, which carry local-frame points plus a pose to transform by).
export interface ChunkBootstrapMessage {
  type: 'chunk_bootstrap';
  session_id: string;
  point_count: number;
  point_format: string;
  stride_bytes: number;
}

// Sent to an LOD-mode viewer to (re)place a chunk's points at a chosen detail level.
// Carries chunk_key + level (unlike the anonymous chunk_bootstrap) so the viewer keys a
// GPU buffer per chunk and swaps it on refine/coarsen. Binary payload (world-frame
// points) follows, like the other chunk messages.
export interface ChunkLodMessage {
  type: 'chunk_lod';
  session_id: string;
  chunk_key: string;
  level: number;
  point_count: number;
  point_format: string;
  stride_bytes: number;
}

// Tells an LOD-mode viewer a chunk has left the view; the viewer frees its buffer.
export interface ChunkDropMessage {
  type: 'chunk_drop';
  session_id: string;
  chunk_key: string;
}

export type ServerMessage =
  | SessionAckMessage
  | PointBatchAckMessage
  | ErrorMessage
  | ViewerSessionStateMessage
  | ChunkUpdateMessage
  | ChunkBootstrapMessage
  | ChunkLodMessage
  | ChunkDropMessage;

export function parseClientMessage(input: string): ClientControlMessage {
  const parsed = JSON.parse(input) as { type?: string };
  if (!parsed.type) {
    throw new Error('Missing message type');
  }
  return parsed as ClientControlMessage;
}

export function makeError(
  code: string,
  message: string,
  retryable: boolean,
  sessionId?: string,
): ErrorMessage {
  return {
    type: 'error',
    code,
    message,
    session_id: sessionId,
    retryable,
  };
}
