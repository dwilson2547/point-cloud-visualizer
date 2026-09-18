// Minimal Apache Iggy client over its HTTP API (docs/pubsub.md). HTTP rather than the
// TCP SDK because the published Node SDK predates the 0.8 server and the HTTP API is
// versioned with the server itself. Shapes below were probed against apache/iggy:0.8.0.
//
// Payloads travel base64-encoded, so this transport costs ~33 % more bytes than the
// binary protocol; fine for a consumer that polls a few times a second.
export interface IggyMessage {
  offset: number;
  timestamp: number;
  payload: Buffer;
}

export interface IggyTopic {
  id: number;
  name: string;
  messagesCount: number;
}

export interface IggyHttpOptions {
  url: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
}

export class IggyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = 'IggyHttpError';
  }
}

const PARTITION_0 = Buffer.from([0, 0, 0, 0]).toString('base64');

export class IggyHttpClient {
  private token: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: IggyHttpOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get url(): string {
    return this.options.url.replace(/\/+$/, '');
  }

  async login(): Promise<void> {
    const response = await this.fetchImpl(`${this.url}/users/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.options.username, password: this.options.password }),
    });
    if (!response.ok) {
      throw new IggyHttpError(response.status, await response.text(), `Iggy login failed (${response.status})`);
    }
    const body = (await response.json()) as { access_token?: { token?: string } };
    if (!body.access_token?.token) {
      throw new Error('Iggy login response carried no access token');
    }
    this.token = body.access_token.token;
  }

  async ping(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.url}/ping`);
      return response.ok;
    } catch {
      return false;
    }
  }

  // Create-if-missing. Iggy answers a create of an existing name with an error, so a
  // failed create is followed by a lookup before giving up.
  async ensureStream(name: string): Promise<void> {
    const created = await this.request('POST', '/streams', { name }, [400, 409]);
    if (created.status >= 400) {
      await this.request('GET', `/streams/${encodeURIComponent(name)}`);
    }
  }

  async ensureTopic(stream: string, topic: string): Promise<void> {
    const created = await this.request(
      'POST',
      `/streams/${encodeURIComponent(stream)}/topics`,
      { name: topic, partitions_count: 1, compression_algorithm: 'none', message_expiry: 0, max_topic_size: 0 },
      [400, 409],
    );
    if (created.status >= 400) {
      await this.request('GET', `/streams/${encodeURIComponent(stream)}/topics/${encodeURIComponent(topic)}`);
    }
  }

  async listTopics(stream: string): Promise<IggyTopic[]> {
    const response = await this.request('GET', `/streams/${encodeURIComponent(stream)}/topics`, undefined, [404]);
    if (response.status === 404) {
      return [];
    }
    const body = (await response.json()) as Array<{ id: number; name: string; messages_count: number }>;
    return body.map((t) => ({ id: t.id, name: t.name, messagesCount: t.messages_count }));
  }

  // Append messages to partition 0 of a topic, in order.
  async send(stream: string, topic: string, payloads: Buffer[]): Promise<void> {
    if (payloads.length === 0) {
      return;
    }
    await this.request(
      'POST',
      `/streams/${encodeURIComponent(stream)}/topics/${encodeURIComponent(topic)}/messages`,
      {
        partitioning: { kind: 'partition_id', value: PARTITION_0 },
        messages: payloads.map((payload) => ({ payload: payload.toString('base64') })),
      },
    );
  }

  // Messages from `offset` onward (inclusive), at most `count`. Empty past the end.
  async poll(stream: string, topic: string, consumer: string, offset: number, count: number): Promise<IggyMessage[]> {
    const query = new URLSearchParams({
      consumer_id: consumer,
      partition_id: '0',
      kind: 'offset',
      value: String(offset),
      count: String(count),
      auto_commit: 'false',
    });
    const response = await this.request(
      'GET',
      `/streams/${encodeURIComponent(stream)}/topics/${encodeURIComponent(topic)}/messages?${query}`,
    );
    const body = (await response.json()) as {
      messages: Array<{ header: { offset: number; timestamp: number }; payload: string }>;
    };
    return body.messages.map((m) => ({
      offset: Number(m.header.offset),
      timestamp: Number(m.header.timestamp),
      payload: Buffer.from(m.payload, 'base64'),
    }));
  }

  async getOffset(stream: string, topic: string, consumer: string): Promise<number | null> {
    const query = new URLSearchParams({ consumer_id: consumer, partition_id: '0' });
    const response = await this.request(
      'GET',
      `/streams/${encodeURIComponent(stream)}/topics/${encodeURIComponent(topic)}/consumer-offsets?${query}`,
      undefined,
      [404],
    );
    if (response.status === 404) {
      return null;
    }
    const body = (await response.json()) as { stored_offset: number };
    return Number(body.stored_offset);
  }

  async putOffset(stream: string, topic: string, consumer: string, offset: number): Promise<void> {
    await this.request(
      'PUT',
      `/streams/${encodeURIComponent(stream)}/topics/${encodeURIComponent(topic)}/consumer-offsets`,
      { consumer_id: consumer, partition_id: 0, offset },
    );
  }

  // Authenticated request; re-logs in once on 401 (tokens expire after an hour).
  private async request(
    method: string,
    path: string,
    body?: unknown,
    tolerated: number[] = [],
    retried = false,
  ): Promise<Response> {
    if (!this.token) {
      await this.login();
    }
    const response = await this.fetchImpl(`${this.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401 && !retried) {
      this.token = null;
      return this.request(method, path, body, tolerated, true);
    }
    if (!response.ok && !tolerated.includes(response.status)) {
      throw new IggyHttpError(response.status, await response.text(), `Iggy ${method} ${path} failed (${response.status})`);
    }
    return response;
  }
}
