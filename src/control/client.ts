import { MagiEventView } from "../events.js";
import { ControlCapabilityDocument, CONTROL_API_VERSION } from "./protocol.js";

export interface ControlClientCredentials {
  deviceId: string;
  token: string;
  expiresAt?: string;
}

export interface HeadlessClientOptions {
  baseUrl: string;
  credentials?: ControlClientCredentials;
  apiVersion?: string;
  fetch?: typeof fetch;
}

export interface ControlEventEnvelope {
  id?: number;
  event: string;
  data: unknown;
}

export interface ControlEventStreamOptions {
  sessionId?: string;
  jobId?: string;
  afterId?: number;
  limit?: number;
  signal?: AbortSignal;
}

export class HeadlessClientError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string
  ) {
    super(message);
    this.name = "HeadlessClientError";
  }
}

/**
 * Typed client boundary for desktop and automation hosts.
 * Keep provider keys in the headless service; clients only receive a scoped
 * device credential created by the pairing endpoint.
 */
export class MagiHeadlessClient {
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private credentials?: ControlClientCredentials;

  constructor(options: HeadlessClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? CONTROL_API_VERSION;
    this.credentials = options.credentials;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  setCredentials(credentials: ControlClientCredentials | undefined): void {
    this.credentials = credentials;
  }

  getCredentials(): ControlClientCredentials | undefined {
    return this.credentials ? { ...this.credentials } : undefined;
  }

  health(): Promise<Record<string, unknown>> {
    return this.request("GET", "/health", undefined, false);
  }

  capabilities(): Promise<ControlCapabilityDocument> {
    return this.request("GET", "/capabilities", undefined, false);
  }

  async pair(name: string, ttlMs?: number): Promise<ControlClientCredentials> {
    const credentials = await this.request<ControlClientCredentials>(
      "POST",
      "/pairing",
      ttlMs === undefined ? { name } : { name, ttlMs },
      false
    );
    this.credentials = credentials;
    return credentials;
  }

  status(): Promise<Record<string, unknown>> {
    return this.request("GET", "/status");
  }

  listSessions(limit = 50): Promise<{ sessions: unknown[] }> {
    return this.request("GET", `/sessions?limit=${encodeURIComponent(String(limit))}`);
  }

  getSession(id: string): Promise<{ session: unknown }> {
    return this.request("GET", `/sessions/${encodeURIComponent(id)}`);
  }

  createSession(body: Record<string, unknown>): Promise<{ session: unknown }> {
    return this.request("POST", "/sessions", body);
  }

  sendMessage(sessionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/messages`, body);
  }

  listJobs(limit = 50): Promise<{ jobs: unknown[] }> {
    return this.request("GET", `/jobs?limit=${encodeURIComponent(String(limit))}`);
  }

  listProviders(): Promise<{
    providers: unknown[];
    aliases: Record<string, string>;
  }> {
    return this.request("GET", "/providers");
  }

  configureProvider(body: {
    providerName: string;
    protocol: "openai" | "anthropic";
    baseUrl: string;
    apiKey: string;
  }): Promise<Record<string, unknown>> {
    return this.request("POST", "/providers/discover", body);
  }

  getJob(id: string): Promise<{ job: unknown }> {
    return this.request("GET", `/jobs/${encodeURIComponent(id)}`);
  }

  startJob(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/jobs", body);
  }

  cancelJob(id: string, reason?: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/jobs/${encodeURIComponent(id)}/cancel`, { reason });
  }

  getJobInteractions(id: string): Promise<{ interactions: unknown[] }> {
    return this.request("GET", `/jobs/${encodeURIComponent(id)}/interactions`);
  }

  resolveApproval(
    jobId: string,
    toolUseId: string,
    approved: boolean,
    responder?: string
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/jobs/${encodeURIComponent(jobId)}/approvals/${encodeURIComponent(toolUseId)}`,
      { approved, responder }
    );
  }

  answerQuestion(
    jobId: string,
    toolUseId: string,
    answer: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/jobs/${encodeURIComponent(jobId)}/questions/${encodeURIComponent(toolUseId)}`,
      { answer }
    );
  }

  listEvents(options: Omit<ControlEventStreamOptions, "signal"> = {}): Promise<{
    events: MagiEventView[];
  }> {
    return this.request("GET", `/events.json${eventQuery(options)}`);
  }

  async *streamEvents(
    options: ControlEventStreamOptions = {}
  ): AsyncGenerator<ControlEventEnvelope> {
    const headers = this.authHeaders();
    if (options.afterId !== undefined) {
      headers.set("last-event-id", String(options.afterId));
    }
    const response = await this.fetchImpl(
      this.url(`/events${eventQuery({ ...options, afterId: undefined })}`),
      { headers, signal: options.signal }
    );
    if (!response.ok) {
      throw await this.errorFromResponse(response);
    }
    if (!response.body) {
      throw new HeadlessClientError(response.status, undefined, "event stream has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseFrame(frame);
          if (event) yield event;
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private url(pathname: string): string {
    return `${this.baseUrl}/${this.apiVersion}${pathname}`;
  }

  private authHeaders(): Headers {
    const headers = new Headers();
    if (this.credentials) {
      headers.set("authorization", `Bearer ${this.credentials.token}`);
      headers.set("x-magi-device-id", this.credentials.deviceId);
    }
    return headers;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    requireAuth = true
  ): Promise<T> {
    if (requireAuth && !this.credentials) {
      throw new HeadlessClientError(401, undefined, "headless client is not paired");
    }
    const headers = this.authHeaders();
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      throw await this.errorFromResponse(response);
    }
    return (await response.json()) as T;
  }

  private async errorFromResponse(response: Response): Promise<HeadlessClientError> {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {}
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : `headless service request failed with HTTP ${response.status}`;
    return new HeadlessClientError(response.status, body, message);
  }
}

function eventQuery(options: Omit<ControlEventStreamOptions, "signal">): string {
  const query = new URLSearchParams();
  if (options.sessionId) query.set("sessionId", options.sessionId);
  if (options.jobId) query.set("jobId", options.jobId);
  if (options.afterId !== undefined) query.set("after", String(options.afterId));
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function parseSseFrame(frame: string): ControlEventEnvelope | undefined {
  let id: number | undefined;
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "id" && /^\d+$/.test(value)) id = Number(value);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  const raw = data.join("\n");
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {}
  return { id, event, data: parsed };
}
