// Server-side helper for sites: reports AI crawler and search-engine reads to
// MetricMind (crawlers don't run JavaScript, so the browser script never sees
// them). Dependency-free; works in Next.js middleware/proxy, edge functions,
// Node and Bun. Exact classification happens on MetricMind's side.
//
// Version 2 (2026-11-17): sends the response status only when you pass it
// (a read without one is stored as "status unknown", never as 200), and the
// crawler's address so MetricMind can check that "GPTBot" really comes from
// OpenAI. The address is used once for that check and never stored.

export interface CrawlerOptions {
  /** Site ID (same as the script's data-site). */
  site: string;
  /** The site's secret server key (Site settings → Setup). Keep it server-side. */
  key: string;
  endpoint?: string;
}

export interface CrawlerRead {
  /**
   * The HTTP status your server answered with. Pass it when you call this after the response exists (a Worker,
   * Express's `res.on("finish")`, a route handler). Leave it out where the response doesn't exist yet (Next.js
   * proxy or middleware): the read is then recorded with an unknown status.
   */
  status?: number;
  /**
   * The crawler's IP address. By default the first of the `cf-connecting-ip`, `x-real-ip` and `x-forwarded-for`
   * headers. If your host passes a visitor's own copy of those headers through unchanged, pass the address your
   * platform gives you instead (for example Express's `req.ip` with `trust proxy` set).
   */
  ip?: string;
}

// Cheap pre-filter so ordinary visits never cause a network call.
const MAYBE_CRAWLER = /bot|crawl|spider|GPT|Claude|Perplexity|Google-Extended|Gemini|Bytespider|meta-external|DuckAssist|MistralAI|Amazonbot/i;

export function looksLikeCrawler(userAgent: string | null | undefined): boolean {
  return Boolean(userAgent && MAYBE_CRAWLER.test(userAgent));
}

/** The address the request came from, as the usual proxy headers name it ("" when none does). */
export function crawlerAddress(request: Request): string {
  const h = request.headers;
  const first = (h.get("cf-connecting-ip") || h.get("x-real-ip") || h.get("x-forwarded-for") || "").split(",")[0].trim();
  return first.length <= 45 ? first : "";
}

/**
 * Report one request if it looks like a crawler. Never throws and never
 * blocks the response: pass the returned promise to `waitUntil` where
 * available, or ignore it. The third argument is the response status (a
 * number, as before) or `{ status, ip }`.
 */
export function trackCrawler(request: Request, opts: CrawlerOptions, read: number | CrawlerRead = {}): Promise<void> {
  const ua = request.headers.get("user-agent");
  if (!looksLikeCrawler(ua)) return Promise.resolve();
  const { status, ip } = typeof read === "number" ? { status: read, ip: undefined } : read;
  const url = new URL(request.url);
  const hit = { path: url.pathname, ua, ts: Date.now(), ...(status ? { status } : {}), ip: ip || crawlerAddress(request) || undefined };
  return fetch(opts.endpoint ?? "https://in.metricmind.si/v1/crawl", {
    method: "POST",
    headers: { "content-type": "application/json", "x-mm-key": opts.key },
    body: JSON.stringify({ site: opts.site, v: 2, hits: [hit] }),
    signal: AbortSignal.timeout(3000),
  }).then(
    () => undefined,
    () => undefined,
  );
}
