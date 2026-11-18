import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { categorize, createMcpAnalytics, observeMcp, resultSize, type McpAnalyticsOptions } from "../src/mcp";

type Sent = { url: string; headers: Record<string, string>; body: { events: Record<string, unknown>[] }; raw: string };

/** A fetch that records every request and answers with the given statuses in turn (then the last one). */
function fakeFetch(statuses: (number | "offline")[] = [202]) {
  const sent: Sent[] = [];
  let i = 0;
  const fetch: NonNullable<McpAnalyticsOptions["fetch"]> = async (url, init) => {
    const status = statuses[Math.min(i++, statuses.length - 1)];
    if (status === "offline") throw new TypeError("fetch failed");
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body), raw: init.body });
    return { status };
  };
  return { fetch, sent, events: () => sent.flatMap((s) => s.body.events) };
}

/** A fake clock: every read moves 25 ms forward, so each call lasts 25 ms. */
function steppingClock() {
  let t = 1_000;
  return () => (t += 25);
}

function weatherServer() {
  const server = new McpServer({ name: "weather", version: "3.1.0" });
  server.registerTool("forecast", { inputSchema: { city: z.string() } }, async ({ city }) => ({ content: [{ type: "text", text: `Sunny in ${city}` }] }));
  server.registerTool("slow", {}, async () => {
    throw new Error("upstream timed out after 30s");
  });
  server.registerTool("broken", {}, async () => {
    throw new Error("kaboom");
  });
  server.registerTool("reports_failure", {}, async () => ({ content: [{ type: "text", text: "Rate limit reached for this account" }], isError: true }));
  server.registerTool("structured", { outputSchema: { temp: z.number() } }, async () => ({ content: [], structuredContent: { temp: 21 } }));
  server.registerTool("health", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));
  return server;
}

async function connectClient(server: McpServer, name = "claude-code", version = "2.1.0") {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name, version });
  await client.connect(clientSide);
  return client;
}

describe("createMcpAnalytics with McpServer", () => {
  test("records a successful call with its size, timing and context, and nothing of the arguments or result", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", release: "1.4.0", environment: "production", siteId: "site_a", fetch: net.fetch, clock: steppingClock(), ingestHost: "https://ingest.example/" });
    const server = analytics.observe(weatherServer());
    const client = await connectClient(server);
    const result = await client.callTool({ name: "forecast", arguments: { city: "SECRET-ARGUMENT-Ljubljana" } });
    expect(JSON.stringify(result)).toContain("Sunny in SECRET-ARGUMENT-Ljubljana");
    await analytics.flush();

    expect(net.sent).toHaveLength(1);
    expect(net.sent[0].url).toBe("https://ingest.example/v1/mcp");
    expect(net.sent[0].headers.authorization).toBe("Bearer mmk_test");
    expect(net.events()).toEqual([
      {
        ts: expect.any(Number),
        server: "weather",
        server_version: "1.4.0",
        environment: "production",
        site: "site_a",
        tool: "forecast",
        client: "claude-code",
        client_version: "2.1.0",
        session: "",
        duration_ms: 25,
        output_chars: "Sunny in SECRET-ARGUMENT-Ljubljana".length,
        ok: true,
        error: "",
        error_code: "",
      },
    ]);
    expect(Math.abs((net.events()[0].ts as number) - Date.now())).toBeLessThan(5_000);
    expect(net.sent[0].raw).not.toContain("SECRET-ARGUMENT");
    expect(net.sent[0].raw).not.toContain("Sunny");
    await analytics.close();
  });

  test("uses the release the server announces when none is configured", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", fetch: net.fetch });
    const client = await connectClient(analytics.observe(weatherServer()));
    await client.callTool({ name: "health", arguments: {} });
    await analytics.close();
    expect(net.events()[0]).toMatchObject({ server: "weather", server_version: "3.1.0" });
  });

  test("classifies failures and keeps the message", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", fetch: net.fetch });
    const client = await connectClient(analytics.observe(weatherServer()));
    await client.callTool({ name: "slow", arguments: {} });
    await client.callTool({ name: "broken", arguments: {} });
    await client.callTool({ name: "reports_failure", arguments: {} });
    await client.callTool({ name: "forecast", arguments: { city: 42 } });
    await client.callTool({ name: "no_such_tool", arguments: {} });
    await analytics.close();

    const byTool = Object.fromEntries(net.events().map((e) => [e.tool, e]));
    expect(byTool.slow).toMatchObject({ ok: false, error_code: "timeout", error: "upstream timed out after 30s", output_chars: 0 });
    expect(byTool.broken).toMatchObject({ ok: false, error_code: "tool_failed", error: "kaboom" });
    expect(byTool.reports_failure).toMatchObject({ ok: false, error_code: "rate_limited" });
    expect(byTool.forecast).toMatchObject({ ok: false, error_code: "invalid_input" });
    expect(byTool.forecast.error).toStartWith("Input validation error");
    expect(byTool.no_such_tool).toMatchObject({ ok: false, error_code: "unknown_tool", error: "Tool no_such_tool not found" });
  });

  test("classifyError overrides the category, sendErrorText false drops the message", async () => {
    const net = fakeFetch();
    const seen: unknown[] = [];
    const analytics = createMcpAnalytics({
      apiKey: "mmk_test",
      fetch: net.fetch,
      sendErrorText: false,
      classifyError: (f) => (seen.push(f), f.message === "kaboom" ? "exploded" : undefined),
    });
    const client = await connectClient(analytics.observe(weatherServer()));
    await client.callTool({ name: "broken", arguments: {} });
    await client.callTool({ name: "slow", arguments: {} });
    await analytics.close();
    expect(net.events().map((e) => [e.tool, e.error_code, e.error])).toEqual([["broken", "exploded", ""], ["slow", "timeout", ""]]);
    expect(seen[0]).toEqual({ tool: "broken", message: "kaboom", kind: "result", category: "tool_failed", rpcCode: undefined });
  });

  test("a classifier that throws falls back to the built-in category", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", fetch: net.fetch, classifyError: () => { throw new Error("bug"); } });
    const client = await connectClient(analytics.observe(weatherServer()));
    await client.callTool({ name: "broken", arguments: {} });
    await analytics.close();
    expect(net.events()[0].error_code).toBe("tool_failed");
  });

  test("measures structured results and skips ignored tools", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", fetch: net.fetch, ignoreTools: ["health"] });
    const client = await connectClient(analytics.observe(weatherServer()));
    await client.callTool({ name: "health", arguments: {} });
    await client.callTool({ name: "structured", arguments: {} });
    await analytics.close();
    expect(net.events().map((e) => [e.tool, e.output_chars, e.ok])).toEqual([["structured", JSON.stringify({ temp: 21 }).length, true]]);
  });

  test("one instance serves many per-request servers, each with its own client", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", fetch: net.fetch });
    for (const name of ["cursor", "claude-code"]) {
      const client = await connectClient(analytics.observe(weatherServer()), name, "9");
      await client.callTool({ name: "health", arguments: {} });
    }
    await analytics.close();
    expect(net.events().map((e) => e.client)).toEqual(["cursor", "claude-code"]);
    expect(net.sent).toHaveLength(1);
  });

  test("observing twice records each call once; observing an already connected server works", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", fetch: net.fetch });
    const server = weatherServer();
    const client = await connectClient(server);
    analytics.observe(server);
    analytics.observe(server);
    await client.callTool({ name: "health", arguments: {} });
    await analytics.close();
    expect(net.events().map((e) => e.tool)).toEqual(["health"]);
  });

  test("observeMcp is a shorthand", async () => {
    const net = fakeFetch();
    const server = weatherServer();
    const analytics = observeMcp(server, { apiKey: "mmk_test", fetch: net.fetch });
    const client = await connectClient(server);
    await client.callTool({ name: "health", arguments: {} });
    await analytics.close();
    expect(net.events()).toHaveLength(1);
  });
});

/** A hand-driven transport and low-level server, to send exactly the JSON-RPC messages a test needs. */
function fakeConnection() {
  const outbox: unknown[] = [];
  const transport = {
    sessionId: "sess-1",
    onmessage: undefined as undefined | ((m: unknown, extra?: unknown) => void),
    onclose: undefined as undefined | (() => void),
    async start() {},
    async send(message: unknown) {
      outbox.push(message);
    },
    async close() {
      this.onclose?.();
    },
  };
  const handled: unknown[] = [];
  const server = {
    transport: undefined as undefined | typeof transport,
    async connect(t: typeof transport) {
      this.transport = t;
      t.onmessage = (m) => void handled.push(m);
      await t.start();
    },
  };
  const receive = (m: unknown) => transport.onmessage?.(m);
  return { transport, server, outbox, handled, receive };
}

describe("createMcpAnalytics on the wire", () => {
  test("JSON-RPC errors, unknown codes and cancellations", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", fetch: net.fetch, serverName: "custom" });
    const { transport, server, handled, receive } = fakeConnection();
    analytics.observe(server);
    await server.connect(transport);
    receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "inspector", version: "0.9" } } });
    receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "a", arguments: { secret: "x" } } });
    receive({ jsonrpc: "2.0", id: "3", method: "tools/call", params: { name: "b" } });
    receive({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "c" } });
    receive({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "d" } });
    receive({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5, reason: "user pressed stop" } });
    expect(handled).toHaveLength(6); // the server still sees every message
    await transport.send({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } });
    await transport.send({ jsonrpc: "2.0", id: "3", error: { code: -32099, message: "custom failure" } });
    await transport.send({ jsonrpc: "2.0", id: 4, error: { code: -32603, message: "database connection timed out" } });
    await transport.send({ jsonrpc: "2.0", id: 5, result: { content: [] } }); // after the cancellation: not counted twice
    await analytics.close();

    expect(net.events().map((e) => [e.tool, e.error_code, e.client, e.session, e.server])).toEqual([
      ["d", "cancelled", "inspector", "sess-1", "custom"],
      ["a", "unknown_method", "inspector", "sess-1", "custom"],
      ["b", "rpc_-32099", "inspector", "sess-1", "custom"],
      ["c", "timeout", "inspector", "sess-1", "custom"],
    ]);
    expect(net.events()[0].error).toBe("user pressed stop");
  });

  test("ids of different types don't mix, other traffic is ignored, a close forgets open calls", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", fetch: net.fetch });
    const { transport, server, receive } = fakeConnection();
    analytics.observe(server);
    await server.connect(transport);
    receive({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    receive({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "x" } });
    await transport.send({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
    await transport.send({ jsonrpc: "2.0", id: "8", result: { content: [] } });
    await transport.close();
    await transport.send({ jsonrpc: "2.0", id: 8, result: { content: [] } });
    await analytics.close();
    expect(net.sent).toHaveLength(0);
  });

  test("long values are cut to ingest's limits", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", fetch: net.fetch, environment: "e".repeat(100) });
    const { transport, server, receive } = fakeConnection();
    analytics.observe(server);
    await server.connect(transport);
    receive({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "t".repeat(500) } });
    await transport.send({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "m".repeat(5_000) }] } });
    await analytics.close();
    const [e] = net.events();
    expect([(e.tool as string).length, (e.environment as string).length, (e.error as string).length]).toEqual([120, 40, 300]);
  });
});

describe("delivery", () => {
  async function recordCalls(analytics: ReturnType<typeof createMcpAnalytics>, n: number) {
    const { transport, server, receive } = fakeConnection();
    analytics.observe(server);
    await server.connect(transport);
    for (let id = 1; id <= n; id++) {
      receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name: `t${id}` } });
      await transport.send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "x" }] } });
    }
  }

  test("full batches go out at once, the rest on flush", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", fetch: net.fetch, batchSize: 2, flushEveryMs: 60_000 });
    await recordCalls(analytics, 5);
    await analytics.flush();
    expect(net.sent.map((s) => s.body.events.map((e) => e.tool))).toEqual([["t1", "t2"], ["t3", "t4"], ["t5"]]);
    expect(analytics.queued).toBe(0);
    await analytics.close();
  });

  test("a partial batch is sent by the timer", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", fetch: net.fetch, flushEveryMs: 10 });
    await recordCalls(analytics, 3);
    expect(net.sent).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(net.events()).toHaveLength(3);
    await analytics.close();
  });

  test("network failures are silent and the batch is retried", async () => {
    const net = fakeFetch(["offline", 503, 202]);
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", fetch: net.fetch, flushEveryMs: 60_000 });
    await recordCalls(analytics, 2);
    await analytics.flush(); // offline
    expect(analytics.queued).toBe(2);
    await analytics.flush(); // 503
    expect(analytics.queued).toBe(2);
    await analytics.flush(); // accepted
    expect(analytics.queued).toBe(0);
    expect(net.events().map((e) => e.tool)).toEqual(["t1", "t2", "t1", "t2"]); // the 503 attempt and the accepted one
    await analytics.close();
  });

  test("a batch that keeps failing is dropped after three attempts; a refused batch at once", async () => {
    const down = fakeFetch(["offline"]);
    const a = createMcpAnalytics({ apiKey: "mmk_test", fetch: down.fetch, flushEveryMs: 60_000 });
    await recordCalls(a, 1);
    for (let i = 0; i < 3; i++) await a.flush();
    expect(a.queued).toBe(0);
    await a.close();

    const refused = fakeFetch([400]);
    const b = createMcpAnalytics({ apiKey: "mmk_test", fetch: refused.fetch, flushEveryMs: 60_000 });
    await recordCalls(b, 1);
    await b.flush();
    expect(b.queued).toBe(0);
    await b.close();
  });

  test("a fetch that throws synchronously never reaches the host", async () => {
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", flushEveryMs: 60_000, fetch: () => { throw new Error("sync"); } });
    await recordCalls(analytics, 1);
    await expect(analytics.flush()).resolves.toBeUndefined();
    await analytics.close();
  });

  test("without an API key nothing is recorded or sent", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "", fetch: net.fetch });
    await recordCalls(analytics, 3);
    await analytics.close();
    expect(net.sent).toHaveLength(0);
  });

  test("the key defaults to METRICMIND_API_KEY", async () => {
    const before = process.env.METRICMIND_API_KEY;
    process.env.METRICMIND_API_KEY = "mmk_from_env";
    try {
      const net = fakeFetch();
      const analytics = createMcpAnalytics({ fetch: net.fetch });
      await recordCalls(analytics, 1);
      await analytics.close();
      expect(net.sent[0].headers.authorization).toBe("Bearer mmk_from_env");
    } finally {
      if (before === undefined) delete process.env.METRICMIND_API_KEY;
      else process.env.METRICMIND_API_KEY = before;
    }
  });

  test("nothing is recorded after close", async () => {
    const net = fakeFetch();
    const analytics = createMcpAnalytics({ apiKey: "mmk_test", fetch: net.fetch });
    await analytics.close();
    await recordCalls(analytics, 2);
    await analytics.flush();
    expect(net.sent).toHaveLength(0);
  });
});

describe("helpers", () => {
  test("categorize", () => {
    expect(categorize({ kind: "rpc", message: "Method not found", rpcCode: -32601 })).toBe("unknown_method");
    expect(categorize({ kind: "rpc", message: "", rpcCode: -32700 })).toBe("malformed_request");
    expect(categorize({ kind: "result", message: "Tool weather disabled", rpcCode: -32602 })).toBe("unknown_tool");
    expect(categorize({ kind: "result", message: "Output validation error: Invalid structured content for tool x" })).toBe("invalid_output");
    expect(categorize({ kind: "result", message: "403 Forbidden from api.example.com" })).toBe("denied");
    expect(categorize({ kind: "result", message: "getaddrinfo ENOTFOUND api.example.com" })).toBe("unreachable");
    expect(categorize({ kind: "result", message: "No such customer" })).toBe("not_found");
    expect(categorize({ kind: "result", message: "Something odd" })).toBe("tool_failed");
    expect(categorize({ kind: "rpc", message: "Something odd" })).toBe("internal");
    expect(categorize({ kind: "cancelled", message: "" })).toBe("cancelled");
  });

  test("resultSize counts text and embedded resources, not images", () => {
    expect(resultSize({ content: [{ type: "text", text: "abc" }, { type: "image", data: "A".repeat(1_000), mimeType: "image/png" }, { type: "resource", resource: { uri: "x://y", text: "hello" } }] })).toBe(8);
    expect(resultSize(undefined)).toBe(0);
    expect(resultSize({ content: [], structuredContent: { a: 1 } })).toBe(7);
  });
});
