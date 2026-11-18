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
