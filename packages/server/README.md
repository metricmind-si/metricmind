# @metricmind/server

Server-side helpers for MetricMind. No dependencies; Node 18+, Bun, Deno and edge runtimes.

```sh
npm install @metricmind/server
```

## Server events

```ts
import { createTracker } from "@metricmind/server/events";

const mm = createTracker({ site: "YOUR_SITE_ID", key: process.env.METRICMIND_SERVER_KEY! });
mm.track("invoice_paid", { user: customer.id, props: { plan: "pro" } });
await mm.flush(); // before a serverless function returns
```

Pass the browser's IDs (`mm.ids()`) as `visitor` and `session` to join an event to the visit.

## MCP tool-call analytics

For MCP servers built with the official TypeScript SDK (`@modelcontextprotocol/sdk`, an optional peer; this package
imports nothing from it).

```ts
import { createMcpAnalytics } from "@metricmind/server/mcp";

const analytics = createMcpAnalytics({ release: "1.4.0", environment: "production" }); // key from METRICMIND_API_KEY
analytics.observe(server);          // McpServer or low-level Server, before server.connect(transport)
await server.connect(transport);
// on shutdown: await analytics.close();   serverless: waitUntil(analytics.flush())
```

One long-lived server (stdio): `const analytics = observeMcp(server, { release: "1.0.0" })`.

It watches the JSON-RPC messages on the server's transport and sends one event per finished `tools/call`: tool name,
duration, success, result size in characters, the failure's message (truncated; `sendErrorText: false` sends only
its category) and category, server name and release, environment, client name and version, and the MCP session.
Tool arguments and results never leave your process. Without an API key nothing is recorded.

## AI crawler reads

Crawlers don't run JavaScript, so the browser script never sees them. Call this from middleware:

```ts
import { trackCrawler } from "@metricmind/server/crawlers";

void trackCrawler(request, { site: "YOUR_SITE_ID", key: process.env.METRICMIND_SERVER_KEY! });
// where the response exists (e.g. a Worker): ctx.waitUntil(trackCrawler(request, opts, { status: response.status }))
```

Only requests whose user agent looks like a crawler are reported: path, user agent, time, the status if you pass
it, and the crawler's IP address, which MetricMind uses to check the crawler really comes from the company it names.

Keep the server key on the server. MIT licensed.
