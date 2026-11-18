import type { Batch, TrackerEvent } from "./types";

export interface Transport {
  send(url: string, body: string): Promise<boolean>;
  beacon(url: string, body: string): boolean;
}

export interface QueueOptions {
  endpoint: string;
  site: string;
  /** Storage-free mode: the server replaces the in-memory visitor and session IDs. */
  anonymous?: boolean;
  maxBatch?: number;
  flushMs?: number;
  maxRetries?: number;
}

// Beacons are capped around 64 KB by browsers; stay well below.
const BEACON_BYTES = 60_000;
// Undelivered events kept for a later attempt while the endpoint is unreachable.
const MAX_PENDING = 200;
const RETRY_LATER_MS = 30_000;
// A request that hasn't answered by then counts as failed (and is retried).
const REQUEST_TIMEOUT_MS = 10_000;

/** Whether a response means "done": success, or a client error that retrying can't fix. 408/425/429 and 5xx are retried. */
export function delivered(status: number): boolean {
  if (status >= 200 && status < 300) return true;
  if (status === 408 || status === 425 || status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * Buffers events and delivers them in batches: when the batch is full, after
 * flushMs, or immediately via sendBeacon when the page is going away.
 */
export class Queue {
  private buffer: TrackerEvent[] = [];
  // Batches being sent (and possibly retried); handed to the beacon if the page goes away meanwhile.
  private inFlight = new Set<TrackerEvent[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxBatch: number;
  private readonly flushMs: number;
  private readonly maxRetries: number;

  constructor(
    private readonly opts: QueueOptions,
    private readonly transport: Transport,
  ) {
    this.maxBatch = opts.maxBatch ?? 20;
    this.flushMs = opts.flushMs ?? 3000;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  get size() {
    return this.buffer.length;
  }

  push(event: TrackerEvent) {
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBatch) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), this.flushMs);
  }

  async flush(): Promise<void> {
    this.clearTimer();
    const failed: TrackerEvent[] = [];
    while (this.buffer.length) {
      const events = this.buffer.splice(0, this.maxBatch);
      if (!(await this.deliver(events))) failed.push(...events);
    }
    if (failed.length) {
      // Keep them (oldest first) for the next flush or the page-hide beacon,
      // so a short outage such as a deploy doesn't lose pageviews.
      this.buffer = [...failed, ...this.buffer].slice(-MAX_PENDING);
      this.timer ??= setTimeout(() => void this.flush(), RETRY_LATER_MS);
    }
  }

  /** Drops everything not sent yet, including batches waiting to be retried (after an opt-out). */
  clear() {
    this.clearTimer();
    this.buffer = [];
    this.inFlight.clear();
  }

  /** Synchronous best-effort delivery for pagehide; never awaits. */
  flushBeacon() {
    this.clearTimer();
    let chunk: TrackerEvent[] = [];
    const send = () => {
      if (!chunk.length) return;
      const body = this.body(chunk);
      if (!this.transport.beacon(this.opts.endpoint, body)) {
        void this.transport.send(this.opts.endpoint, body);
      }
      chunk = [];
    };
    // Batches still being retried go too, with the same event IDs (ingest de-duplicates if both arrive).
    const pending = [...this.inFlight].flat();
    this.inFlight.clear();
    for (const event of [...pending, ...this.buffer.splice(0)]) {
      chunk.push(event);
      if (this.body(chunk).length > BEACON_BYTES) {
        chunk.pop();
        send();
        chunk.push(event);
      }
    }
    send();
  }

  private async deliver(events: TrackerEvent[]): Promise<boolean> {
    const body = this.body(events);
    this.inFlight.add(events);
    try {
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (await this.transport.send(this.opts.endpoint, body)) return true;
        // Handed to the page-close beacon or dropped by an opt-out: nothing left to do.
        if (!this.inFlight.has(events)) return true;
        if (attempt < this.maxRetries) await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.5)));
        if (!this.inFlight.has(events)) return true;
      }
      return false;
    } finally {
      this.inFlight.delete(events);
    }
  }

  private body(events: TrackerEvent[]): string {
    const batch: Batch = { site: this.opts.site, events, ...(this.opts.anonymous ? { anonymous: true } : {}) };
    return JSON.stringify(batch);
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

export const browserTransport: Transport = {
  async send(url, body) {
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const timer = abort && setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      // text/plain keeps this a "simple" CORS request with no preflight.
      const res = await fetch(url, {
        method: "POST",
        body,
        keepalive: body.length < BEACON_BYTES,
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        signal: abort?.signal,
      });
      return delivered(res.status);
    } catch {
      return false; // network error or timeout: retried
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
  beacon(url, body) {
    try {
      return navigator.sendBeacon?.(url, new Blob([body], { type: "text/plain;charset=UTF-8" })) ?? false;
    } catch {
      return false;
    }
  },
};
