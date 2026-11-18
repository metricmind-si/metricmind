// Wire format of POST /v1/batch, accepted by MetricMind's ingest service (closed source), which versions it.
// Changes here must stay compatible with what ingest accepts; see README "Wire format".

export type EventType = "pageview" | "event" | "exit" | "vital" | "error";

export interface TrackerEvent {
  id: string;
  type: EventType;
  ts: number; // epoch ms
  visitor: string;
  session: string;
  user?: string; // set by mm.identify()
  path: string;
  title?: string;
  referrer?: string;
  utm?: { source?: string; medium?: string; campaign?: string; term?: string; content?: string; click?: string };
  name?: string; // custom event name or vital metric
  value?: number; // vital value or engaged ms
  props?: Record<string, string | number | boolean | null>;
  error?: { message: string; stack?: string };
  /** A sale reported by the page (a thank-you page, a checkout pixel). */
  revenue?: { amount: number; currency: string; order_id?: string };
  lang?: string;
  tz?: string;
  viewport?: string;
}

export interface Batch {
  site: string;
  events: TrackerEvent[];
  /** Storage-free mode (data-storage="none"): ingest derives visitor and session from a daily-salted hash. */
  anonymous?: boolean;
  /** Sent by a crawler that runs JavaScript: recorded as a crawler read, never as a visit. */
  crawler?: boolean;
}
