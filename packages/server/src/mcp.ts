// MetricMind MCP analytics: see how the tools of your MCP server are used, how fast they answer and why they fail.
//
// Single file with no imports, so it can be vendored as is:
//   curl -o metricmind-mcp.ts https://in.metricmind.si/sdk/mcp.ts
//
// Usage with the official TypeScript SDK (`McpServer` or the low-level `Server`):
//
//   import { createMcpAnalytics } from "./metricmind-mcp";
//
//   const analytics = createMcpAnalytics({ release: "1.4.0", environment: "production" }); // key from METRICMIND_API_KEY
//   analytics.observe(server);           // before server.connect(transport)
//   await server.connect(transport);
//   // on shutdown: await analytics.close();
//
// Servers created per request (stateless HTTP) share one `analytics` and call `observe` on each new server. On
// serverless platforms, hand `analytics.flush()` to the platform's waitUntil after each request.
//
// ── What is sent (the contract of ingest's POST /v1/mcp) ─────────────────────────────────────────────────────────────
// Body `{ events: [...] }`, 1 to 100 events, at most 128 KB, `Authorization: Bearer mmk_…` (an organization API key
// with the "Send events" scope). Ingest answers 202 `{ accepted, dropped }`; 401 for a bad key, 400 for a malformed
// batch (the whole batch is refused), 413 when too large, 503 with Retry-After when storage is down. One event per
// finished `tools/call`:
//   ts             number   when the call arrived, epoch ms; ingest drops events older than 7 days or 1 h ahead
//   tool           string   the tool's name (1..120 chars, required)
//   duration_ms    number   request in to response out (0..3 600 000, required)
//   ok             boolean  false when the call failed (required)
//   output_chars   integer  size of the result in characters, never the result itself (0..4e9)
//   error          string   the failure's message, ≤300 chars (stored only when ok is false)
//   error_code     string   a short category for grouping failures, ≤64 chars (see ErrorCategory below)
//   server         string   the server's name, ≤120 chars
//   server_version string   the server's release, ≤40 chars (the dashboard's "Releases")
//   environment    string   e.g. production / staging, ≤40 chars
//   site           string   the MetricMind site ID the server belongs to, ≤64 chars
//   client         string   the MCP client's name from its `initialize` request, ≤80 chars
//   client_version string   its version, ≤40 chars
//   session        string   the transport's session ID when it has one, ≤128 chars
// Tool arguments and tool results never leave the process. Strings are cut to their limit here, so one long value
// can't make ingest refuse the whole batch.
//
// ── How it works ──────────────────────────────────────────────────────────────────────────────────────────────────
// `observe` taps the JSON-RPC messages on each transport the server connects to: a `tools/call` request starts a
// timer, the response with the same id stops it. Nothing in the SDK is replaced, so tool handlers, schemas and
// errors behave exactly as before. Events are queued and posted in the background in batches; a failed post is
// retried a few times and then dropped. Nothing here throws into your server, and network failures are silent.

/** A JSON-RPC message as it crosses the transport. Only the fields read here are typed. */
interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown };
}

/** The parts of the SDK's `Transport` this file touches. */
interface TappableTransport {
  start(): Promise<void>;
  send(message: RpcMessage, options?: unknown): Promise<void>;
  onmessage?: (message: RpcMessage, extra?: unknown) => void;
  onclose?: () => void;
  sessionId?: string;
}

/** The parts of the SDK's low-level `Server` this file touches. */
interface ConnectableServer {
  connect(transport: TappableTransport): Promise<void>;
  readonly transport?: TappableTransport;
  getClientVersion?(): { name?: string; version?: string } | undefined;
}

/** Anything with a `connect(transport)`: an `McpServer` (its `.server` is used) or a low-level `Server`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ObservableServer = { connect(transport: any): Promise<void> };

/**
 * Categories for failed calls, so the dashboard can group them. `classifyError` may return its own codes too.
 *
 * - `unknown_tool`: the client asked for a tool that doesn't exist or is disabled
 * - `invalid_input`: arguments didn't match the tool's input schema (JSON-RPC -32602)
 * - `invalid_output`: the tool's structured result didn't match its output schema
 * - `unknown_method`: JSON-RPC -32601
 * - `malformed_request`: JSON-RPC -32700 / -32600
 * - `internal`: JSON-RPC -32603
 * - `timeout`: the work timed out (JSON-RPC -32001, or a message that says so)
 * - `cancelled`: the client cancelled the call before it finished
 * - `disconnected`: the connection closed (JSON-RPC -32000)
 * - `not_found`: something the tool looked up doesn't exist (JSON-RPC -32002, or a message that says so)
 * - `rate_limited`, `denied`, `unreachable`: read from the message (429 / quota, 401 / 403 / permission, network)
 * - `needs_user_action`: the server asked the user to open a URL (JSON-RPC -32042)
 * - `tool_failed`: the tool reported a failure that fits none of the above
 * - `rpc_<code>`: any other JSON-RPC error code
 */
export type ErrorCategory =
  | "unknown_tool" | "invalid_input" | "invalid_output" | "unknown_method" | "malformed_request" | "internal"
  | "timeout" | "cancelled" | "disconnected" | "not_found" | "rate_limited" | "denied" | "unreachable"
  | "needs_user_action" | "tool_failed" | `rpc_${number}`;

/** A failed call, as handed to `classifyError`. */
export interface ToolFailure {
  tool: string;
  /** The message, without the SDK's "MCP error <code>:" prefix. */
  message: string;
  /** The JSON-RPC error code, when the failure carried one (in the response, or in the SDK's message prefix). */
  rpcCode?: number;
  /** `result`: the tool answered with `isError: true`. `rpc`: a JSON-RPC error response. `cancelled`: the client gave up. */
  kind: "result" | "rpc" | "cancelled";
  /** What this file would report. */
  category: ErrorCategory;
}

export interface McpAnalyticsOptions {
  /**
   * An organization API key (`mmk_…`) with the "Send events" scope. Defaults to the METRICMIND_API_KEY environment
   * variable. Without a key, nothing is recorded or sent.
   */
  apiKey?: string;
  /** The server's name. Defaults to the name your server announces when a client initializes. */
  serverName?: string;
  /** The server's release, e.g. a semver or a commit. Defaults to the version your server announces. */
  release?: string;
  /** e.g. "production" or "staging". */
  environment?: string;
  /** The MetricMind site this server belongs to, if any. */
  siteId?: string;
  /** Send the failure's message with each failed call (default true). With false only the category is sent. */
  sendErrorText?: boolean;
  /** Pick your own category for a failure; return undefined to keep the built-in one. */
  classifyError?: (failure: ToolFailure) => string | undefined;
  /** Tools never to record, e.g. health checks. */
  ignoreTools?: string[];
  /** Default "https://in.metricmind.si". */
  ingestHost?: string;
  /** Events per request, 1 to 100 (default 50). A full batch is sent right away. */
  batchSize?: number;
  /** How long a partial batch waits before it is sent (default 5000 ms). */
  flushEveryMs?: number;
  /** For tests and other runtimes. */
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>;
  /** Millisecond clock used for durations (default `performance.now`). For tests. */
  clock?: () => number;
}

export interface McpAnalytics {
  /** Start recording tool calls on this server. Call it before `connect`; returns the server so it can be chained. */
  observe<S extends ObservableServer>(server: S): S;
  /** Send everything queued now. Never rejects. */
  flush(): Promise<void>;
  /** Stop recording and send what is left. Call it on shutdown. Never rejects. */
  close(): Promise<void>;
  /** Events waiting to be sent. */
  readonly queued: number;
}

/** One event on the wire; field names are ingest's. */
interface WireEvent {
  ts: number;
  server: string;
  server_version: string;
  environment: string;
  site: string;
  tool: string;
  client: string;
  client_version: string;
  session: string;
  duration_ms: number;
  output_chars: number;
  ok: boolean;
  error: string;
  error_code: string;
}

const LIMIT = { server: 120, server_version: 40, environment: 40, site: 64, tool: 120, client: 80, client_version: 40, session: 128, error: 300, error_code: 64 } as const;
const MAX_DURATION_MS = 3_600_000;
const MAX_OUTPUT_CHARS = 4_000_000_000;
/** Beyond this many unsent events, the oldest go first: a long outage must not grow memory without bound. */
const MAX_QUEUED = 5_000;
/** Attempts per batch before it is dropped. */
const MAX_ATTEMPTS = 3;
const POST_TIMEOUT_MS = 10_000;

const BY_RPC_CODE: Record<number, ErrorCategory> = {
  [-32700]: "malformed_request",
  [-32600]: "malformed_request",
  [-32601]: "unknown_method",
  [-32602]: "invalid_input",
  [-32603]: "internal",
  [-32000]: "disconnected",
  [-32001]: "timeout",
  [-32002]: "not_found",
  [-32042]: "needs_user_action",
};

/** Message patterns, checked in order, for failures that carry no telling code. */
const BY_MESSAGE: [RegExp, ErrorCategory][] = [
  [/\btimed?[\s-]?out\b|\btimeout\b|ETIMEDOUT|deadline exceeded/i, "timeout"],
  [/rate[\s-]?limit|too many requests|\b429\b|quota/i, "rate_limited"],
  [/unauthori[sz]ed|forbidden|permission|access denied|\b40[13]\b/i, "denied"],
  [/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network error/i, "unreachable"],
  [/not found|no such|does not exist|\b404\b|ENOENT/i, "not_found"],
];

/** The built-in category for a failure. Exported so you can build on it in `classifyError`. */
export function categorize(failure: Pick<ToolFailure, "message" | "rpcCode" | "kind">): ErrorCategory {
  if (failure.kind === "cancelled") return "cancelled";
  const { message, rpcCode } = failure;
  if (/^Tool \S.* (not found|disabled)$/.test(message)) return "unknown_tool";
  if (/^Output validation error/i.test(message)) return "invalid_output";
  if (/^Input validation error|^Invalid arguments for tool/i.test(message)) return "invalid_input";
  // A specific code says more than the wording; the generic internal error (-32603) lets the message decide.
  if (rpcCode !== undefined && rpcCode !== -32603 && BY_RPC_CODE[rpcCode]) return BY_RPC_CODE[rpcCode];
  for (const [pattern, category] of BY_MESSAGE) if (pattern.test(message)) return category;
  if (rpcCode !== undefined) return BY_RPC_CODE[rpcCode] ?? `rpc_${rpcCode}`;
  return failure.kind === "rpc" ? "internal" : "tool_failed";
}

/** Characters of a tool result a model would read: its text, or the structured content when there is no text. */
export function resultSize(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const r = result as { content?: unknown; structuredContent?: unknown };
  let chars = 0;
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; text?: unknown; resource?: { text?: unknown } };
      if (b.type === "text" && typeof b.text === "string") chars += b.text.length;
      else if (b.type === "resource" && typeof b.resource?.text === "string") chars += b.resource.text.length;
    }
  }
  if (chars === 0 && r.structuredContent !== undefined) {
    try {
      chars = JSON.stringify(r.structuredContent)?.length ?? 0;
    } catch {
      chars = 0;
    }
  }
  return Math.min(chars, MAX_OUTPUT_CHARS);
}

const clip = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
const idKey = (id: unknown) => `${typeof id}:${String(id)}`;
const SDK_PREFIX = /^MCP error (-?\d+):\s*/;

/** The message of a failed result: its first text block. */
function failureText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") return String((block as { text?: unknown }).text ?? "");
  return "";
}

/** Split the SDK's "MCP error -32602: …" prefix off a message. */
function splitSdkPrefix(message: string): { message: string; rpcCode?: number } {
  const match = SDK_PREFIX.exec(message);
  return match ? { message: message.slice(match[0].length), rpcCode: Number(match[1]) } : { message };
}

interface Inflight {
  tool: string;
  ts: number;
  started: number;
  session: string;
}

/** METRICMIND_API_KEY from the environment, on runtimes that have one. */
function keyFromEnvironment(): string {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.METRICMIND_API_KEY ?? "";
  } catch {
    return "";
  }
}

export function createMcpAnalytics(options: McpAnalyticsOptions = {}): McpAnalytics {
  const key = options.apiKey ?? keyFromEnvironment();
  const apiKey = typeof key === "string" ? key.trim() : "";
  const enabled = apiKey.length > 0;
  const url = (options.ingestHost ?? "https://in.metricmind.si").replace(/\/+$/, "") + "/v1/mcp";
  const batchSize = Math.max(1, Math.min(100, Math.floor(options.batchSize ?? 50)));
  const flushEveryMs = Math.max(0, options.flushEveryMs ?? 5_000);
  const clock = options.clock ?? (() => (globalThis.performance ? globalThis.performance.now() : Date.now()));
  const ignored = new Set(options.ignoreTools ?? []);
  const sendErrorText = options.sendErrorText !== false;
  const post = options.fetch ?? ((u, init) => globalThis.fetch(u, init));

  const queue: WireEvent[] = [];
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> = Promise.resolve();
  let closed = false;
  let warnedKey = false;
  /** What servers announce in their `initialize` answer, used when the options leave name or release out. */
  let announced: { name: string; version: string } = { name: "", version: "" };
  const tappedTransports = new WeakSet<object>();
  const patchedServers = new WeakSet<object>();

  if (!enabled) console.warn("[metricmind] MCP analytics is off: no apiKey given and METRICMIND_API_KEY is not set.");

  function schedule() {
    if (timer || closed || queue.length === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, flushEveryMs);
    (timer as { unref?: () => void }).unref?.();
  }

  function enqueue(event: WireEvent) {
    if (!enabled || closed) return;
    queue.push(event);
    if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
    if (queue.length >= batchSize) void flush();
    else schedule();
  }

  /** Posts one batch. True when it is done with (accepted, or refused for good); false to try again later. */
  async function deliver(batch: WireEvent[]): Promise<boolean> {
    let status = 0;
    try {
      const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(POST_TIMEOUT_MS) : undefined;
      const res = await post(url, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ events: batch }), signal });
      status = res.status;
    } catch {
      status = 0; // offline, DNS, timeout: try again later
    }
    if (status === 401 && !warnedKey) {
      warnedKey = true;
      console.warn("[metricmind] MCP analytics: the API key was refused. Use an organization key with the \"Send events\" scope.");
    }
    return !(status === 0 || status === 429 || status >= 500);
  }

  async function drain() {
    while (queue.length > 0) {
      const batch = queue.slice(0, batchSize);
      const done = await deliver(batch);
      if (done || ++attempts >= MAX_ATTEMPTS) {
        // Remove exactly what was sent; events recorded meanwhile were appended after it.
        queue.splice(0, batch.length);
        attempts = 0;
        continue;
      }
      break; // keep the batch at the front for the next timer
    }
    schedule();
  }

  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    sending = sending.then(drain).catch(() => {});
    return sending;
  }

  function record(server: ConnectableServer, client: { name: string; version: string }, call: Inflight, outcome: { ok: true; size: number } | { ok: false; failure: Omit<ToolFailure, "category"> }) {
    let errorCode = "";
    let error = "";
    if (!outcome.ok) {
      const failure: ToolFailure = { ...outcome.failure, category: categorize(outcome.failure) };
      let custom: string | undefined;
      try {
        custom = options.classifyError?.(failure);
      } catch {
        custom = undefined;
      }
      errorCode = typeof custom === "string" && custom.trim() ? custom.trim() : failure.category;
      error = sendErrorText ? failure.message : "";
    }
    const known = client.name ? client : (() => {
      try {
        const v = server.getClientVersion?.();
        return { name: v?.name ?? "", version: v?.version ?? "" };
      } catch {
        return { name: "", version: "" };
      }
    })();
    enqueue({
      ts: call.ts,
      server: clip(options.serverName ?? announced.name, LIMIT.server),
      server_version: clip(options.release ?? announced.version, LIMIT.server_version),
      environment: clip(options.environment ?? "", LIMIT.environment),
      site: clip(options.siteId ?? "", LIMIT.site),
      tool: clip(call.tool, LIMIT.tool),
      client: clip(known.name, LIMIT.client),
      client_version: clip(known.version, LIMIT.client_version),
      session: clip(call.session, LIMIT.session),
      duration_ms: Math.max(0, Math.min(MAX_DURATION_MS, Math.round(clock() - call.started))),
      output_chars: outcome.ok ? Math.round(outcome.size) : 0,
      ok: outcome.ok,
      error: clip(error, LIMIT.error),
      error_code: clip(errorCode, LIMIT.error_code),
    });
  }

  /** Watch one transport's traffic. `live` when the server is already connected to it. */
  function tap(transport: TappableTransport, server: ConnectableServer, live: boolean) {
    if (tappedTransports.has(transport)) return;
    tappedTransports.add(transport);
    const inflight = new Map<string, Inflight>();
    let client = { name: "", version: "" };
    let initializeId: string | undefined;

    const inbound = (message: RpcMessage) => {
      if (closed || !message || typeof message !== "object") return;
      const params = message.params ?? {};
      if (message.method === "initialize") {
        const info = (params.clientInfo ?? {}) as { name?: unknown; version?: unknown };
        client = { name: typeof info.name === "string" ? info.name : "", version: typeof info.version === "string" ? info.version : "" };
        if (message.id !== undefined) initializeId = idKey(message.id);
      } else if (message.method === "tools/call" && message.id !== undefined) {
        const tool = typeof params.name === "string" ? params.name : "";
        if (!tool || ignored.has(tool)) return;
        inflight.set(idKey(message.id), { tool, ts: Date.now(), started: clock(), session: typeof transport.sessionId === "string" ? transport.sessionId : "" });
      } else if (message.method === "notifications/cancelled") {
        const key = idKey(params.requestId);
        const call = inflight.get(key);
        if (!call) return;
        inflight.delete(key);
        record(server, client, call, { ok: false, failure: { tool: call.tool, message: typeof params.reason === "string" ? params.reason : "", kind: "cancelled" } });
      }
    };

    const outbound = (message: RpcMessage) => {
      if (!message || typeof message !== "object" || message.method !== undefined || message.id === undefined) return;
      const key = idKey(message.id);
      if (key === initializeId) {
        initializeId = undefined;
        const info = (message.result?.serverInfo ?? {}) as { name?: unknown; version?: unknown };
        if (typeof info.name === "string") announced = { name: info.name, version: typeof info.version === "string" ? info.version : "" };
        return;
      }
      const call = inflight.get(key);
      if (!call) return;
      inflight.delete(key);
      if (message.error) {
        const code = typeof message.error.code === "number" ? message.error.code : undefined;
        const text = splitSdkPrefix(typeof message.error.message === "string" ? message.error.message : "");
        record(server, client, call, { ok: false, failure: { tool: call.tool, message: text.message, rpcCode: code ?? text.rpcCode, kind: "rpc" } });
      } else if (message.result && message.result.isError === true) {
        const text = splitSdkPrefix(failureText(message.result));
        record(server, client, call, { ok: false, failure: { tool: call.tool, message: text.message, rpcCode: text.rpcCode, kind: "result" } });
      } else {
        record(server, client, call, { ok: true, size: resultSize(message.result) });
      }
    };

    const send = transport.send;
    transport.send = function (this: TappableTransport, message: RpcMessage, sendOptions?: unknown) {
      try {
        outbound(message);
      } catch {
        // never let analytics break a response
      }
      return send.call(this, message, sendOptions);
    };

    const listen = () => {
      const handler = transport.onmessage;
      transport.onmessage = (message, extra) => {
        try {
          inbound(message);
        } catch {
          // never let analytics break a request
        }
        handler?.(message, extra);
      };
      const onclose = transport.onclose;
      transport.onclose = () => {
        inflight.clear();
        onclose?.();
      };
    };

    if (live) {
      listen();
    } else {
      // The SDK sets onmessage/onclose in connect() and then calls start(): wrap them at that point.
      const start = transport.start;
      transport.start = function (this: TappableTransport) {
        try {
          listen();
        } catch {
          // keep starting the transport regardless
        }
        return start.call(this);
      };
    }
  }

  function observe<S extends ObservableServer>(target: S): S {
    try {
      if (!enabled || closed || !target || typeof target !== "object") return target;
      const inner = (target as { server?: unknown }).server;
      // An McpServer delegates to its low-level Server; patch that one so both connect paths are covered.
      const server = (inner && typeof (inner as ConnectableServer).connect === "function" ? inner : target) as ConnectableServer;
      if (patchedServers.has(server)) return target;
      patchedServers.add(server);
      if (server.transport) tap(server.transport, server, true);
      const connect = server.connect;
      server.connect = function (this: ConnectableServer, transport: TappableTransport) {
        try {
          if (transport && typeof transport.send === "function" && typeof transport.start === "function") tap(transport, server, false);
        } catch {
          // connect without analytics rather than not at all
        }
        return connect.call(this, transport);
      };
    } catch {
      // never break the host server
    }
    return target;
  }

  async function close() {
    if (closed) return sending;
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    sending = sending.then(drain).catch(() => {});
    return sending;
  }

  return {
    observe,
    flush,
    close,
    get queued() {
      return queue.length;
    },
  };
}

/** Shorthand for one long-lived server (stdio): `const analytics = observeMcp(server, { release: "1.0.0" })`. */
export function observeMcp(server: ObservableServer, options: McpAnalyticsOptions = {}): McpAnalytics {
  const analytics = createMcpAnalytics(options);
  analytics.observe(server);
  return analytics;
}
