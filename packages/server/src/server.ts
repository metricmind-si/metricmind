// Server-side events for MetricMind: signups, payments, background jobs, anything your backend knows
// and the browser doesn't. No dependencies; works on Node 18+, Bun, Deno and edge runtimes.
//
//   import { createTracker } from "./metricmind-server";
//   const mm = createTracker({ site: "YOUR_SITE_ID", key: process.env.METRICMIND_SERVER_KEY! });
//   mm.track("invoice_paid", { user: customer.id, props: { plan: "pro" } });
//   await mm.flush(); // before a serverless function returns
//
// Pass the browser's IDs (mm.ids() → mm_visitor / mm_session, e.g. through checkout metadata or a
// form field) to join the event to the visit and its traffic source. With only `user`, the event is
// attached to that user. Events are batched (up to 100, every second) and retried on 429/5xx.

export interface TrackOptions {
  /** mm_visitor from mm.ids() in the browser. */
  visitor?: string;
  /** mm_session from mm.ids(). */
  session?: string;
  /** Your user ID (the one given to mm.identify). */
  user?: string;
  /** Page the event belongs to, if any (defaults to "/"). */
  path?: string;
  props?: Record<string, string | number | boolean | null>;
  /** When it happened (epoch ms), if not now. */
  ts?: number;
  /** Your own ID for the event: sending it twice stores it once. */
  id?: string;
}

export interface ServerEvent extends TrackOptions {
  name: string;
}

export interface TrackerConfig {
  site: string;
  /** The site's server key (Settings → Tracking) or an API key with the "Send events" permission. */
  key: string;
  endpoint?: string;
  flushIntervalMs?: number;
  /** Called when a batch is dropped after retries (defaults to console.warn). */
  onError?: (error: Error, events: ServerEvent[]) => void;
  fetch?: typeof fetch;
}

const MAX_BATCH = 100;
const MAX_QUEUE = 10_000;
const RETRIES = 3;

export function createTracker(config: TrackerConfig) {
  const endpoint = (config.endpoint ?? "https://in.metricmind.si").replace(/\/$/, "") + "/v1/track";
  const doFetch = config.fetch ?? fetch;
  const onError = config.onError ?? ((e: Error) => console.warn(`[metricmind] ${e.message}`));
  const auth: Record<string, string> = config.key.startsWith("mmk_") ? { authorization: `Bearer ${config.key}` } : { "x-mm-key": config.key };
  let queue: ServerEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> = Promise.resolve();

  async function send(events: ServerEvent[]) {
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let reason = "";
      try {
        const res = await doFetch(endpoint, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ site: config.site, events }), signal: AbortSignal.timeout(10_000) });
        status = res.status;
        if (res.ok) return;
        reason = (await res.text().catch(() => "")).slice(0, 200);
      } catch (e) {
        reason = (e as Error).message;
      }
      const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
      if (!retryable || attempt >= RETRIES) {
        onError(new Error(`MetricMind refused ${events.length} event(s): ${status || "network error"} ${reason}`.trim()), events);
        return;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, config.flushIntervalMs ?? 1000);
    // Don't keep a Node process alive just for analytics.
    (timer as { unref?: () => void }).unref?.();
  }

  /** Sends everything queued; resolves when delivered (or given up on). */
  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const batches: ServerEvent[][] = [];
    while (queue.length) batches.push(queue.splice(0, MAX_BATCH));
    inflight = inflight.then(() => Promise.all(batches.map(send))).then(() => undefined);
    return inflight;
  }

  return {
    track(name: string, options: TrackOptions = {}) {
      if (!options.visitor && !options.user) {
        onError(new Error(`"${name}" needs a visitor (from mm.ids()) or a user ID.`), [{ name, ...options }]);
        return;
      }
      if (queue.length >= MAX_QUEUE) queue.shift();
      queue.push({ name, ts: Date.now(), ...options });
      if (queue.length >= MAX_BATCH) void flush();
      else schedule();
    },
    flush,
  };
}
