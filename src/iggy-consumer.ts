// Pub/sub inlet: consumes point batches from an Apache Iggy stream (docs/pubsub.md).
//
// Layout: one stream (default `pcv`), one topic per session named by session id, one
// partition so order is preserved. A message is either a batch-log record (the same
// framed bytes `src/batch-log.ts` writes: magic, header JSON with sequence, pose and
// format, raw payload) or a JSON control message (`create_session`, `close_session`,
// the same shapes the WebSocket protocol uses). The record is self-contained, so a
// topic doubles as a second copy of the session log.
//
// Delivery is at-least-once: the consumer offset is committed after a page has been
// stored durably, and redelivered batches are dropped by the session's sequence check.
// The consumer is transport only; the server supplies the two callbacks.
import { LOG_MAGIC, type LogRecord, type LogRecordHeader } from './batch-log.js';
import type { IggyHttpClient } from './iggy-http.js';
import zlib from 'node:zlib';

const FRAME_BYTES = 16;

export interface ConsumerHandlers {
  onControl: (sessionId: string, message: Record<string, unknown>) => void;
  onBatch: (sessionId: string, record: LogRecord) => void;
  log?: (message: string) => void;
}

export interface IggyConsumerOptions {
  stream: string;
  consumer: string; // consumer id / name whose offsets Iggy stores
  pollMs?: number; // idle poll interval
  pageSize?: number; // messages per poll
  discoverEveryMs?: number; // how often to look for new topics (sessions)
}

interface TopicCursor {
  next: number; // next offset to read
}

export class IggyConsumer {
  private readonly cursors = new Map<string, TopicCursor>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastDiscovery = 0;
  private failures = 0;

  constructor(
    private readonly client: IggyHttpClient,
    private readonly options: IggyConsumerOptions,
    private readonly handlers: ConsumerHandlers,
  ) {}

  get topics(): string[] {
    return [...this.cursors.keys()];
  }

  async start(): Promise<void> {
    this.running = true;
    await this.client.ensureStream(this.options.stream);
    await this.discover();
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  // One pass over every known topic; returns how many messages were consumed.
  async tick(): Promise<number> {
    const now = Date.now();
    if (now - this.lastDiscovery >= (this.options.discoverEveryMs ?? 2_000)) {
      await this.discover();
    }
    let consumed = 0;
    for (const [topic, cursor] of this.cursors) {
      const page = await this.client.poll(
        this.options.stream,
        topic,
        this.options.consumer,
        cursor.next,
        this.options.pageSize ?? 32,
      );
      if (page.length === 0) {
        continue;
      }
      for (const message of page) {
        this.dispatch(topic, message.payload);
        cursor.next = message.offset + 1;
      }
      await this.client.putOffset(this.options.stream, topic, this.options.consumer, cursor.next - 1);
      consumed += page.length;
    }
    return consumed;
  }

  private async discover(): Promise<void> {
    this.lastDiscovery = Date.now();
    for (const topic of await this.client.listTopics(this.options.stream)) {
      if (this.cursors.has(topic.name)) {
        continue;
      }
      const stored = await this.client.getOffset(this.options.stream, topic.name, this.options.consumer);
      this.cursors.set(topic.name, { next: stored === null ? 0 : stored + 1 });
      this.handlers.log?.(`iggy: following topic ${topic.name} from offset ${stored === null ? 0 : stored + 1}`);
    }
  }

  private dispatch(topic: string, payload: Buffer): void {
    const parsed = parseMessage(payload);
    if (parsed.kind === 'batch') {
      this.handlers.onBatch(topic, parsed.record);
    } else if (parsed.kind === 'control') {
      this.handlers.onControl(topic, parsed.message);
    } else {
      this.handlers.log?.(`iggy: ${topic}: ${parsed.reason}; message skipped`);
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(async () => {
      let consumed = 0;
      try {
        consumed = await this.tick();
        this.failures = 0;
      } catch (error) {
        this.failures += 1;
        this.handlers.log?.(`iggy: poll failed (${(error as Error).message}); retrying`);
      }
      const idle = this.options.pollMs ?? 100;
      const backoff = Math.min(10_000, idle * 2 ** Math.min(this.failures, 6));
      this.schedule(this.failures > 0 ? backoff : consumed > 0 ? 0 : idle);
    }, delayMs);
  }
}

export type ParsedMessage =
  | { kind: 'batch'; record: LogRecord }
  | { kind: 'control'; message: Record<string, unknown> }
  | { kind: 'invalid'; reason: string };

// A message is a batch-log record when it starts with the log magic; otherwise it is
// expected to be a JSON control message.
export function parseMessage(payload: Buffer): ParsedMessage {
  if (payload.byteLength >= FRAME_BYTES && payload.readUInt32LE(0) === LOG_MAGIC) {
    const headerLength = payload.readUInt32LE(4);
    const payloadLength = payload.readUInt32LE(8);
    const expectedCrc = payload.readUInt32LE(12);
    if (payload.byteLength !== FRAME_BYTES + headerLength + payloadLength) {
      return { kind: 'invalid', reason: 'record length does not match its frame' };
    }
    const body = payload.subarray(FRAME_BYTES);
    if (zlib.crc32(body) !== expectedCrc) {
      return { kind: 'invalid', reason: 'record crc mismatch' };
    }
    let header: LogRecordHeader;
    try {
      header = JSON.parse(body.subarray(0, headerLength).toString('utf8')) as LogRecordHeader;
    } catch {
      return { kind: 'invalid', reason: 'record header is not JSON' };
    }
    return {
      kind: 'batch',
      record: { header, payload: body.subarray(headerLength), offset: 0, nextOffset: payload.byteLength },
    };
  }
  try {
    const message = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
    if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
      return { kind: 'invalid', reason: 'control message has no type' };
    }
    return { kind: 'control', message };
  } catch {
    return { kind: 'invalid', reason: 'neither a batch record nor JSON' };
  }
}
