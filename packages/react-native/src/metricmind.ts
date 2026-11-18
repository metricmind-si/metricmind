// MetricMind for React Native: screens, sessions, custom events, users, errors,
// crashes and JS-thread performance, cookieless. One file, no dependencies besides react-native.
// Vendor it:  curl -o metricmind.ts https://in.metricmind.si/sdk/react-native.ts
//
//   import { MetricMind } from "./metricmind";
//   import AsyncStorage from "@react-native-async-storage/async-storage";
//   MetricMind.init({ site: "YOUR_SITE_ID", appVersion: "2.4.1", build: "41", storage: AsyncStorage });
//   MetricMind.trackNavigation(navigationRef); // React Navigation: one screen view per route
//
// Campaigns: links that open the app with utm_source / utm_medium / utm_campaign
// (deep links, universal and app links) start a session credited to that campaign.
// Read automatically through Linking; turn off with deepLinks: false and call
// MetricMind.openURL(url) yourself.
//
// Consent: MetricMind.init({ ..., enabled: false }) records nothing until MetricMind.optIn().
//
// Errors: uncaught errors and crashes, unhandled promise rejections (Hermes, release builds) and
// errors thrown while rendering are reported on their own. An error your own error boundary or
// try/catch swallows isn't: pass it to MetricMind.captureError(error).
//
// Performance, measured on the JavaScript thread (no native module): JS start time, screen load,
// slow and frozen JS frames during the first 10 s of a screen, and stalls of 2 s or more.
// Turn off with performance: false.
//
// Privacy: a random install ID kept in the app's own storage (no advertising
// ID, no device fingerprint). The IP address is used for the country and never
// stored. mm.optOut() stops measurement and deletes the IDs.
import { AppState, Dimensions, Linking, Platform } from "react-native";

type Props = Record<string, string | number | boolean | null>;

/** AsyncStorage-compatible key/value storage. Without it IDs and unsent events live in memory only. */
export interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface MetricMindOptions {
  /** Site ID from MetricMind (Settings → Tracking). */
  site: string;
  /** The app's release, e.g. "2.4.1" (DeviceInfo.getVersion() or expo-application's nativeApplicationVersion). */
  appVersion: string;
  /** Build number, e.g. "41". Shown as "2.4.1 (41)". */
  build?: string;
  /** Which feature flags apply; empty serves flags without an environment. */
  environment?: string;
  storage?: Storage;
  /** Report uncaught JavaScript errors and crashes (default true). */
  errors?: boolean;
  endpoint?: string;
  /** false: record and store nothing until optIn() (e.g. after consent); the choice is remembered. Default true. */
  enabled?: boolean;
  /** Credit sessions to the utm_* campaign of links that open the app (default true). */
  deepLinks?: boolean;
  /** How often queued events are sent while the app is open (default 10 s). */
  flushIntervalMs?: number;
  /**
   * JS start time, screen load time, JS-thread frames and stalls (default true). All measured on the
   * JavaScript thread: native start-up before the bundle runs, UI-thread frames and ANRs are out of reach.
   */
  performance?: boolean;
}

/**
 * What the SDK reads from the JavaScript runtime. Every part is optional: a missing API turns
 * one measurement off and nothing else.
 */
export interface Runtime {
  performance?: { now?: () => number; rnStartupTiming?: { startTime?: number | null; endTime?: number | null; executeJavaScriptBundleEntryPointStart?: number | null } };
  nativePerformanceNow?: () => number;
  requestAnimationFrame?: (cb: () => void) => unknown;
  /** Set by Metro at the top of the bundle: nativePerformanceNow() when the runtime has it, else Date.now(). */
  __BUNDLE_START_TIME__?: number;
  __DEV__?: boolean;
  HermesInternal?: { enablePromiseRejectionTracker?: (options: { allRejections: boolean; onUnhandled: (id: number, reason: unknown) => void; onHandled: (id: number) => void }) => void };
  ErrorUtils?: ErrorUtilsLike;
  console?: { error: (...args: unknown[]) => void };
}
type ErrorHandler = ((error: unknown, fatal?: boolean) => void) & { mm?: boolean };
type ErrorUtilsLike = { getGlobalHandler(): ErrorHandler; setGlobalHandler(h: ErrorHandler): void };

/** The part of fetch the SDK uses (React Native's global fetch fits). */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface FlagResult {
  enabled: boolean;
  variant: string;
}

export type Campaign = { source?: string; medium?: string; campaign?: string };

/** The utm_* campaign of a link (ref= counts as the source, like on the website), or null. */
export function campaignFrom(url: string): Campaign | null {
  const query = String(url).split("#")[0].split("?")[1];
  if (!query) return null;
  const q: Record<string, string> = {};
  for (const pair of query.split("&")) {
    const [k, v = ""] = pair.split("=");
    try {
      q[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " ")).trim().slice(0, 200);
    } catch {
      // malformed escape: skip the pair
    }
  }
  const c: Campaign = {};
  if (q.utm_source || q.ref) c.source = q.utm_source || q.ref;
  if (q.utm_medium) c.medium = q.utm_medium;
  if (q.utm_campaign) c.campaign = q.utm_campaign;
  return c.source || c.medium || c.campaign ? c : null;
}

/** A feedback message ready to send: at most 500 characters, emails and phone numbers replaced. */
export function feedbackText(raw: string): string | null {
  const text = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[phone]")
    .slice(0, 500);
  return text || null;
}

interface WireEvent {
  id: string;
  type: "pageview" | "event" | "exit" | "error" | "vital";
  ts: number;
  visitor: string;
  session: string;
  user?: string;
  path: string;
  title?: string;
  name?: string;
  value?: number;
  props?: Props;
  error?: { message: string; stack?: string };
  utm?: Campaign;
  /** The release that recorded it (kept on the device, not sent per event). */
  _app?: ReturnType<typeof appContext>;
  /** Starts a new session (back from the background after 30 s or more); kept on the device. */
  _new?: boolean;
  lang?: string;
  tz?: string;
  viewport?: string;
}

const DEFAULT_ENDPOINT = "https://in.metricmind.si/v1/batch";
const SESSION_IDLE_MS = 30 * 60 * 1000;
/** Back after this long in the background (or relaunched after it): a new session, as in the store consoles. */
const BACKGROUND_SESSION_MS = 30 * 1000;
const MAX_BATCH = 20;
const MAX_QUEUE = 500;
// An install ID lasts 13 months from the day it was made, never extended by use (CNIL's recommendation for audience
// measurement; 393 days is the shortest 13 calendar months can be). IDs from before this rule carry no date and count
// from the day it shipped: as new they'd be extended, expired at once every user would look new.
export const VISITOR_LIFETIME_MS = 393 * 86_400_000;
export const VISITOR_LEGACY_ISSUED = 1_793_577_600_000; // 2026-11-02 UTC

const KEYS = { visitor: "mm_visitor", visitorAt: "mm_visitor_at", session: "mm_session", user: "mm_user", queue: "mm_queue", optOut: "mm_optout", optIn: "mm_optin", exposed: "mm_exposed", crash: "mm_crash" } as const;

/** Start-up and screen timings longer than this aren't a start or a load (the app was left, or two clocks disagree). */
const TIMING_MAX_MS = 60_000;
/** Frames are counted for this long after a screen opens or the app comes back: a frame loop that never stops would keep the JS thread awake. */
const FRAME_WINDOW_MS = 10_000;
/** A JS frame slower than this missed a refresh at 60 Hz; over 700 ms is frozen (the other SDKs' rule). */
const SLOW_FRAME_MS = 25;
const FROZEN_FRAME_MS = 700;
/** The JS thread is checked twice a second; a check that comes 2 s late or more is a stall. Longer than a minute is a suspended app. */
const BEAT_MS = 500;
const STALL_MS = 2000;
const STALL_MAX_MS = 60_000;
/** A navigation that takes longer than this to show its screen wasn't that screen's navigation. */
const NAV_MAX_MS = 10_000;
/** An error thrown while rendering is a crash if the app is gone this soon after it. */
const CRASH_SETTLE_MS = 1500;
/** A crash waits this long at most for its report to reach the disk before the app is allowed to close. */
const CRASH_SAVE_MS = 1000;
const OFF: FlagResult = { enabled: false, variant: "off" };

/** RFC 4122 v4, from crypto when available (Hermes has no crypto by default). */
export function uuid(random: () => number = Math.random): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Milliseconds since the JavaScript bundle started running, or null when the runtime doesn't say.
 * Metro stamps the bundle (__BUNDLE_START_TIME__) with the same clock it can be compared against;
 * performance.rnStartupTiming is the fallback, used only when its own numbers agree with our clock.
 * Not a cold start: the process launch and native start-up before the bundle runs aren't visible from JS.
 */
export function jsStartElapsed(rt: Runtime, mono: number, wall: number): number | null {
  try {
    let ms: number | null = null;
    const bundle = rt.__BUNDLE_START_TIME__;
    if (typeof bundle === "number" && bundle > 0) {
      // Date.now() is past 1e12; a monotonic clock counts from boot.
      ms = bundle > 1e11 ? wall - bundle : (typeof rt.nativePerformanceNow === "function" ? rt.nativePerformanceNow() : mono) - bundle;
    } else {
      const t = rt.performance?.rnStartupTiming;
      const from = t?.startTime ?? t?.executeJavaScriptBundleEntryPointStart;
      const end = t?.endTime;
      if (typeof from === "number" && (typeof end !== "number" || (end >= from && end <= mono))) ms = mono - from;
    }
    return ms !== null && ms > 0 && ms < TIMING_MAX_MS ? ms : null;
  } catch {
    return null;
  }
}

/** The message and stack to send for anything thrown or rejected. Objects that aren't errors are never serialised. */
function errorParts(error: unknown): { message: string; stack?: string } {
  const e = error as { name?: unknown; message?: unknown; stack?: unknown; componentStack?: unknown } | null;
  if (e && typeof e === "object") {
    const name = typeof e.name === "string" && e.name ? e.name : error instanceof Error ? "Error" : "";
    const text = typeof e.message === "string" ? e.message : "";
    const message = name && text ? `${name}: ${text}` : name || text || "Non-error value thrown";
    const stack = `${typeof e.stack === "string" ? e.stack : ""}${typeof e.componentStack === "string" && e.componentStack ? `\nComponent stack:${e.componentStack}` : ""}`;
    return { message: message.slice(0, 500), ...(stack ? { stack: stack.slice(0, 4000) } : {}) };
  }
  return { message: `Error: ${String(error)}`.slice(0, 500) };
}

/** "Checkout" → "/Checkout"; nested routes keep their slashes. Spaces become dashes. */
export function screenPath(name: string): string {
  const clean = String(name).trim().replace(/\s+/g, "-").replace(/^\/+/, "").slice(0, 200);
  return `/${clean || "unknown"}`;
}

/** A search term worth recording, or null: emails and phone numbers are never sent. */
export function searchTermFor(raw: string): string | null {
  const term = String(raw ?? "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 100);
  if (!term || /@/.test(term) || /\d[\d\s().-]{6,}\d/.test(term)) return null;
  return term;
}

/** Platform details sent once per batch. Android reports the release ("14"), not the API level. */
export function appContext(opts: Pick<MetricMindOptions, "appVersion" | "build">) {
  const ios = Platform.OS === "ios";
  const consts = (Platform as unknown as { constants?: { Release?: string } }).constants;
  const osVersion = ios ? String(Platform.Version) : String(consts?.Release ?? Platform.Version);
  const { width, height } = Dimensions.get("screen");
  const tablet = ios ? Boolean((Platform as unknown as { isPad?: boolean }).isPad) : Math.min(width, height) >= 600;
  return {
    platform: ios ? ("ios" as const) : ("android" as const),
    version: String(opts.appVersion).slice(0, 32),
    ...(opts.build ? { build: String(opts.build).slice(0, 32) } : {}),
    os_version: osVersion.replace(/[^\w.]/g, "").slice(0, 32) || "0",
    device: tablet ? ("tablet" as const) : ("phone" as const),
  };
}

export class Tracker {
  private queue: WireEvent[] = [];
  private pending: WireEvent[] = []; // tracked before storage loaded
  private ready = false;
  private disabled = false;
  private visitor = "";
  private visitorAt = 0;
  private session = { id: "", last: 0 };
  private user: string | undefined;
  private exposed = new Set<string>();
  private screen: { path: string; title: string; since: number; engaged: number; openedAt: number; ready?: boolean } | null = null;
  private campaign: Campaign | null = null;
  private backgroundAt: number | null = null;
  private flushing = false;
  private flagsPromise: Promise<Record<string, FlagResult>> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly rt: Runtime;
  // Frames on the JS thread, for the current screen (sent with its exit).
  private frameGen = 0;
  private frameUntil = 0;
  private frameLast = 0;
  private frames = 0;
  private slow = 0;
  private frozen = 0;
  /** When the screen being opened started loading (monotonic), until its first frame. */
  private loadFrom: number | null = null;
  private loadNav = false;
  private navAt: number | null = null;
  /** The JS start time was sent, or can't be trusted any more (the app left the foreground first). */
  private started = false;
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private beatAt: number | null = null;
  private beatPaused = false;
  /** Changes whenever the app leaves or returns to the foreground. */
  private life = 0;
  private saved: Promise<unknown> = Promise.resolve();
  /** Errors already reported by one automatic path (global handler, render errors, rejections). */
  private auto = new WeakSet<object>();
  private settling: { error: unknown; event: WireEvent; timer: ReturnType<typeof setTimeout> } | null = null;
  readonly loaded: Promise<void>;

  constructor(
    private readonly opts: MetricMindOptions,
    private readonly env: { fetch: FetchLike; now: () => number; storage?: Storage; campaignWaitMs?: number; runtime?: Runtime } = { fetch: (url, init) => fetch(url, init), now: () => Date.now(), storage: opts.storage },
  ) {
    this.rt = env.runtime ?? (globalThis as unknown as Runtime);
    this.loaded = this.load();
  }

  private async load() {
    const s = this.env.storage;
    try {
      // enabled: false waits for consent: nothing is stored or sent until optIn(), which is remembered.
      this.disabled = (await s?.getItem(KEYS.optOut)) === "1" || (this.opts.enabled === false && (await s?.getItem(KEYS.optIn)) !== "1");
      const now = this.env.now();
      const stored = await s?.getItem(KEYS.visitor);
      const at = Number(await s?.getItem(KEYS.visitorAt));
      this.visitor = stored || uuid();
      // No date, a broken one or one from the future: never a reason to keep an ID longer.
      this.visitorAt = !stored ? now : at > 0 && at <= now ? at : VISITOR_LEGACY_ISSUED;
      const saved = JSON.parse((await s?.getItem(KEYS.session)) || "null") as { id: string; last: number } | null;
      if (saved?.id) {
        this.session = saved;
        // A launch is a return from the background: the first event decides, whether or not it came before loading.
        const first = this.pending[0];
        if (first) first._new ||= first.ts - saved.last >= BACKGROUND_SESSION_MS;
        else this.backgroundAt ??= saved.last;
      }
      this.user = (await s?.getItem(KEYS.user)) || undefined;
      this.exposed = new Set(JSON.parse((await s?.getItem(KEYS.exposed)) || "[]") as string[]);
      // Events a previous run couldn't send (offline, killed before flushing).
      const old = JSON.parse((await s?.getItem(KEYS.queue)) || "[]") as WireEvent[];
      if (Array.isArray(old)) this.queue.push(...old.slice(-MAX_QUEUE));
      // A render error the last run didn't survive (see renderError): that run's crash.
      const crash = JSON.parse((await s?.getItem(KEYS.crash)) || "null") as WireEvent | null;
      if (crash?.id) {
        await s?.removeItem(KEYS.crash);
        if (!this.disabled) this.queue.push({ ...crash, session: crash.session || uuid() });
      }
      if (!this.expireVisitor(now) && !this.disabled) await this.saveVisitor(); // never stored without consent / after opt-out
    } catch {
      this.visitor ||= uuid();
      this.visitorAt ||= this.env.now();
    }
    this.ready = true;
    if (!this.disabled) for (const e of this.pending.splice(0)) this.enqueue(e);
    else this.pending = [];
  }

  /** Session ID, rotated after 30 idle minutes (same rule as the website tracker). */
  /** Decided when the event happens (pending events are enqueued later): back after 30 s or more starts a session. */
  private markSession(e: WireEvent) {
    if (this.backgroundAt === null) return;
    if (e.ts - this.backgroundAt >= BACKGROUND_SESSION_MS) e._new = true;
    this.backgroundAt = null;
  }

  private touchSession(at: number) {
    if (!this.session.id || at - this.session.last > SESSION_IDLE_MS) this.session = { id: uuid(), last: at };
    else this.session.last = at;
    void this.env.storage?.setItem(KEYS.session, JSON.stringify(this.session)).catch(() => {});
    return this.session.id;
  }

  private emit(partial: Omit<WireEvent, "id" | "ts" | "visitor" | "session" | "path"> & { path?: string }) {
    const event = this.build(partial);
    if (event) this.push(event);
  }

  private push(event: WireEvent) {
    if (this.disabled) return;
    this.markSession(event);
    if (!this.ready) {
      this.pending.push(event);
      return;
    }
    this.enqueue(event);
  }

  private build(partial: Omit<WireEvent, "id" | "ts" | "visitor" | "session" | "path"> & { path?: string }): WireEvent | null {
    if (this.disabled) return null;
    const ts = this.env.now();
    const { width, height } = Dimensions.get("window");
    const intl = Intl.DateTimeFormat().resolvedOptions();
    const event: WireEvent = {
      id: uuid(),
      ts,
      visitor: this.visitor,
      session: "",
      path: this.screen?.path ?? "/",
      lang: intl.locale?.slice(0, 35),
      tz: intl.timeZone?.slice(0, 64),
      viewport: `${Math.round(width)}x${Math.round(height)}`,
      ...partial,
    };
    if (this.user) event.user = this.user;
    return event;
  }

  private saveVisitor() {
    const s = this.env.storage;
    return Promise.all([s?.setItem(KEYS.visitor, this.visitor), s?.setItem(KEYS.visitorAt, String(this.visitorAt))]);
  }

  /** A new install ID once the old one is 13 months old; it starts a new session, or one session would have two IDs. */
  private expireVisitor(now: number) {
    if (now - this.visitorAt < VISITOR_LIFETIME_MS) return false;
    this.visitor = uuid();
    this.visitorAt = now;
    this.session = { id: "", last: 0 };
    this.flagsPromise = null;
    if (!this.disabled) void this.saveVisitor().catch(() => {});
    return true;
  }

  private enqueue(e: WireEvent) {
    this.expireVisitor(this.env.now());
    e.visitor = this.visitor;
    e._app ??= appContext(this.opts);
    if (e.utm || e._new) this.session = { id: "", last: 0 }; // a campaign visit, or a return after 30 s, is a new session
    e.session = this.touchSession(e.ts);
    if (this.user && !e.user) e.user = this.user;
    this.queue.push(e);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    this.persist();
    if (this.queue.length >= MAX_BATCH) void this.flush();
  }

  private persist() {
    try {
      this.saved = Promise.resolve(this.env.storage?.setItem(KEYS.queue, JSON.stringify(this.queue))).catch(() => {});
    } catch {
      // a storage that throws instead of rejecting
    }
  }

  /** Sends queued events; failed batches stay queued (and on disk) for the next try. */
  async flush(): Promise<void> {
    await this.loaded;
    if (this.flushing || this.disabled || !this.queue.length) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        // One release per batch: a crash saved before an update is sent with the version that crashed.
        const batchApp = this.queue[0]._app ?? appContext(this.opts);
        const key = JSON.stringify(batchApp);
        let n = 0;
        while (n < Math.min(MAX_BATCH, this.queue.length) && JSON.stringify(this.queue[n]._app ?? batchApp) === key) n++;
        const batch = this.queue.slice(0, n);
        const res = await this.env
          .fetch(this.opts.endpoint ?? DEFAULT_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ site: this.opts.site, app: batchApp, events: batch.map(({ _app, _new, ...e }) => e) }),
          })
          .catch(() => null);
        // Network errors and 5xx: keep for later. 4xx (bad site, refused): drop, retrying won't help.
        if (!res || res.status >= 500 || res.status === 429) break;
        this.queue.splice(0, batch.length);
        this.persist();
      }
    } finally {
      this.flushing = false;
    }
  }

  /** One screen view. Ends the previous screen with its engaged time. */
  trackScreen(name: string, props?: Props) {
    const path = screenPath(name);
    if (this.screen?.path === path) return;
    this.endScreen();
    this.screen = { path, title: String(name).slice(0, 512), since: this.env.now(), engaged: 0, openedAt: this.env.now() };
    const utm = this.campaign;
    this.campaign = null;
    this.emit({ type: "pageview", path, title: this.screen.title, ...(props ? { props } : {}), ...(utm ? { utm } : {}) });
    // Load time: from the navigation that led here when we were told about it, else from this call, to the next frame.
    const at = this.mono();
    const nav = this.navAt;
    this.navAt = null;
    this.loadNav = at !== null && nav !== null && at - nav >= 0 && at - nav < NAV_MAX_MS;
    this.loadFrom = this.loadNav ? nav : at;
    this.watchFrames();
  }

  /**
   * A navigation began (trackNavigation reports it by itself): the next screen's load time counts from here,
   * so it covers rendering the screen and not only what follows screen().
   */
  navigationStart() {
    this.navAt = this.mono();
  }

  /** The monotonic clock (performance.now), or null when it's missing or performance is off: then nothing is timed. */
  private mono(): number | null {
    if (this.opts.performance === false) return null;
    try {
      const t = this.rt.performance?.now?.();
      return typeof t === "number" && Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }

  /**
   * Counts frames on the JS thread for the current screen, for 10 s: requestAnimationFrame runs once per
   * display refresh when the JS thread is free, so a late one is a frame JavaScript couldn't produce.
   * These are not UI-thread frames: native animations and scrolling can stay smooth meanwhile, and a
   * janky UI thread doesn't show here. The first frame also ends the screen's load time.
   */
  private watchFrames() {
    const gen = ++this.frameGen; // a loop already running stops at its next frame
    this.frameLast = 0;
    const raf = this.rt.requestAnimationFrame;
    const at = this.mono();
    if (at === null || typeof raf !== "function") {
      this.loadFrom = null;
      return;
    }
    this.frameUntil = at + FRAME_WINDOW_MS;
    const tick = () => {
      if (gen !== this.frameGen) return;
      try {
        const now = this.mono();
        const s = this.screen;
        if (now === null || !s || !s.since) return;
        if (this.frameLast) {
          const took = now - this.frameLast;
          this.frames++;
          if (took > SLOW_FRAME_MS) this.slow++;
          if (took > FROZEN_FRAME_MS) this.frozen++;
        }
        this.frameLast = now;
        if (this.loadFrom !== null) this.firstFrame(now, s.path);
        if (now < this.frameUntil) raf(tick);
      } catch {
        // measuring never breaks the app
      }
    };
    try {
      raf(tick);
    } catch {
      this.loadFrom = null;
    }
  }

  private firstFrame(now: number, path: string) {
    const ms = now - (this.loadFrom ?? now);
    this.loadFrom = null;
    if (ms >= 0 && ms < TIMING_MAX_MS) this.emit({ type: "vital", name: "SCREEN_LOAD", value: Math.round(ms), path, props: { js: true, nav: this.loadNav } });
    if (this.started) return;
    this.started = true;
    // The first screen's first frame ends the start. APP_JS_START, not APP_START: it counts from the bundle, not the process.
    const start = jsStartElapsed(this.rt, now, this.env.now());
    if (start !== null) this.emit({ type: "vital", name: "APP_JS_START", value: Math.round(start), path });
  }

  /**
   * Called twice a second in the foreground. A call that comes 2 s late or more means the JS thread was
   * blocked that long: touches handled in JavaScript got no answer. Reported as a hang, marked js: it is
   * not an ANR or an iOS hang (those are the UI thread, which JavaScript can't watch).
   */
  beat() {
    try {
      const now = this.mono();
      const last = this.beatAt;
      this.beatAt = now;
      if (now === null || last === null || !this.screen?.since) return;
      const late = now - last - BEAT_MS;
      if (late < STALL_MS || late > STALL_MAX_MS) return;
      // A suspended app wakes up late too, and the event that says it was in the background may be queued
      // right behind this timer: report only if the app is still in the foreground one check later.
      const life = this.life;
      const path = this.screen.path;
      setTimeout(() => {
        const state = (AppState as { currentState?: string | null }).currentState;
        if (life !== this.life || !this.screen?.since || (state && state !== "active")) return;
        this.emit({ type: "error", path, error: { message: "JavaScript thread blocked for 2 s or more" }, props: { fatal: false, kind: "hang", js: true, duration_ms: Math.round(late) } });
      }, BEAT_MS);
    } catch {
      // measuring never breaks the app
    }
  }

  private startBeat() {
    if (this.beatTimer || this.rt.__DEV__ || this.mono() === null) return; // a paused debugger looks like a stall
    this.beatAt = null;
    this.beatTimer = setInterval(() => this.beat(), BEAT_MS);
  }

  private stopBeat() {
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.beatTimer = null;
    this.beatAt = null;
  }

  /**
   * A link opened the app. With utm_* parameters it starts a new session credited
   * to that campaign, whose entry is the screen the link opens. If no screen follows
   * within a second (a link to the screen already shown), the current one is counted again.
   */
  openURL(url: string) {
    const c = campaignFrom(url);
    if (!c) return;
    this.campaign = c;
    if (!this.screen) return;
    setTimeout(() => {
      if (this.campaign !== c || !this.screen) return; // the link's screen already took it
      const { title } = this.screen;
      this.endScreen();
      this.screen = null;
      this.trackScreen(title);
    }, this.env.campaignWaitMs ?? 1000);
  }

  private endScreen() {
    if (!this.screen || (!this.screen.since && !this.screen.engaged)) return; // already closed (inactive, then background)
    const engaged = this.screen.engaged + (this.screen.since ? this.env.now() - this.screen.since : 0);
    const frames = this.frames > 0 ? { frames: this.frames, slow: this.slow, frozen: this.frozen, js: true } : null;
    this.frames = this.slow = this.frozen = 0;
    this.emit({ type: "exit", path: this.screen.path, value: Math.min(engaged, 86_400_000), ...(frames ? { props: frames } : {}) });
    this.screen.engaged = 0;
    this.screen.since = 0;
  }

  /** App went to the background: close the screen's engaged time and send what's queued. */
  background() {
    this.life++;
    this.frameGen++; // stop counting frames
    this.loadFrom = null;
    this.started = true; // left before the first frame: no start time
    this.beatAt = null;
    if (this.beatTimer) {
      this.stopBeat(); // nothing runs in the background
      this.beatPaused = true;
    }
    this.settle(); // still alive: the render error wasn't a crash
    this.endScreen();
    this.backgroundAt ??= this.env.now();
    void this.flush();
  }

  /** Back in the foreground: the current screen keeps counting (a new session after 30 idle minutes). */
  foreground() {
    const at = this.env.now();
    this.life++;
    this.beatAt = null;
    if (this.beatPaused) {
      this.beatPaused = false;
      this.startBeat();
    }
    if (this.backgroundAt !== null && at - this.backgroundAt >= BACKGROUND_SESSION_MS && this.screen) {
      // Back after 30 s or more: a new session, whose entry is the screen the app returns to.
      this.screen.since = at;
      this.screen.engaged = 0;
      this.emit({ type: "pageview", path: this.screen.path, title: this.screen.title });
      this.watchFrames();
      return;
    }
    if (!this.screen) return; // launching: the first event decides whether it's a new session
    this.backgroundAt = null;
    if (!this.screen.since) {
      this.screen.since = at; // still counting: keep the time
      this.watchFrames();
    }
  }

  /** Time to full display: call when the current screen's content has loaded (once per screen view). */
  screenReady() {
    const s = this.screen;
    if (!s || s.ready) return;
    const ms = this.env.now() - s.openedAt;
    if (ms < 0 || ms >= 60_000) return;
    s.ready = true;
    this.emit({ type: "vital", name: "SCREEN_READY", value: Math.round(ms), path: s.path });
  }

  track(name: string, props?: Props) {
    if (!name) return;
    this.emit({ type: "event", name: String(name).slice(0, 120), ...(props ? { props } : {}) });
  }

  /** What a user tells you (your feedback form), with an optional 1–5 rating; linked to the session and release. */
  feedback(message: string, rating?: number) {
    const text = feedbackText(message);
    if (!text) return;
    this.track("$feedback", typeof rating === "number" && rating >= 1 && rating <= 5 ? { message: text, rating: Math.round(rating) } : { message: text });
  }

  /**
   * Contact actions (call, WhatsApp, email, chat): counted like the website's automatic contact clicks.
   * Props say what was contacted, e.g. { category: "cars" }, so contacts break down by it; never the number or address.
   */
  contact(channel: string, props?: Props) {
    this.track("contact", { ...props, channel: String(channel).toLowerCase().slice(0, 40) });
  }

  /**
   * What the user searched for in the app. Emails and phone numbers are never sent.
   * Pass { results: n } once results are known, so searches that find nothing stand out.
   */
  search(term: string, props?: Props & { results?: number }) {
    const t = searchTermFor(term);
    if (!t) return;
    const results = props?.results;
    const rest = { ...props };
    delete rest.results;
    this.track("search", { ...rest, term: t, ...(typeof results === "number" && results >= 0 ? { results: Math.round(results) } : {}) });
  }

  /** Links this install to your user ID (after login). Traits are sent once; only pass what your privacy policy covers. */
  identify(id: string, traits?: Props) {
    if (!id) return;
    const user = String(id).slice(0, 128);
    const changed = user !== this.user;
    this.user = user;
    void this.env.storage?.setItem(KEYS.user, user).catch(() => {});
    if (changed) this.flagsPromise = null;
    if (changed || traits) this.emit({ type: "event", name: "$identify", ...(traits ? { props: traits } : {}) });
  }

  /** Forgets the user (call on logout): new anonymous install ID and session. */
  reset() {
    this.user = undefined;
    this.visitor = uuid();
    this.visitorAt = this.env.now();
    this.session = { id: "", last: 0 };
    this.flagsPromise = null;
    const s = this.env.storage;
    void Promise.all([s?.removeItem(KEYS.user), this.disabled ? undefined : this.saveVisitor(), s?.removeItem(KEYS.session)]).catch(() => {});
  }

  /** An error you caught, or (fatal) a crash. */
  captureError(error: unknown, opts: { fatal?: boolean } = {}) {
    this.emit({ type: "error", error: errorParts(error), props: { fatal: Boolean(opts.fatal) } });
  }

  /** True the first time one of the automatic paths sees this error (a handler that calls the one before it shows it twice). */
  private first(error: unknown): boolean {
    if (!error || typeof error !== "object") return true;
    if (this.auto.has(error)) return false;
    this.auto.add(error);
    return true;
  }

  /**
   * An uncaught error from React Native's global handler (fatal: the app is about to close).
   * Resolves once the report is on disk, or after a second: a crash waits for that before the app closes.
   */
  uncaught(error: unknown, fatal?: boolean): Promise<void> {
    const s = this.settling;
    if (s && s.error === error) {
      // Older React shows a render error to the console first, then throws it here: this is the real verdict.
      clearTimeout(s.timer);
      this.settling = null;
      this.dropCrashMarker();
    } else if (!this.first(error)) return Promise.resolve();
    this.captureError(error, { fatal });
    void this.flush();
    const onDisk = this.loaded.then(() => this.saved).catch(() => {});
    return Promise.race([onDisk, new Promise<void>((done) => setTimeout(done, CRASH_SAVE_MS))]).then(() => {});
  }

  /** A promise rejected with nothing to catch it: an error the app went on after. */
  rejection(reason: unknown) {
    if (!this.first(reason)) return;
    this.emit({ type: "error", error: errorParts(reason), props: { fatal: false, promise: true } });
  }

  /**
   * An error thrown while rendering. Since React 19 these skip the global handler: React Native logs them
   * with console.error whether an error boundary caught them (the app goes on) or not (the app closes), and
   * nothing says which. So the report is first kept aside as a crash; if the app is still running 1.5 s
   * later it's sent as an ordinary error, and if it isn't, the next launch sends the crash.
   */
  renderError(error: unknown) {
    if (!this.first(error)) return;
    this.settle();
    const event = this.build({ type: "error", error: errorParts(error), props: { fatal: true, render: true } });
    if (!event) return;
    event._app = appContext(this.opts);
    event.session = this.session.id;
    try {
      void Promise.resolve(this.env.storage?.setItem(KEYS.crash, JSON.stringify(event))).catch(() => {});
    } catch {
      // a storage that throws instead of rejecting
    }
    this.settling = { error, event, timer: setTimeout(() => this.settle(), CRASH_SETTLE_MS) };
  }

  /** The app outlived a render error: it was caught by an error boundary, so it's sent as an error, not a crash. */
  private settle() {
    const s = this.settling;
    if (!s) return;
    clearTimeout(s.timer);
    this.settling = null;
    this.dropCrashMarker();
    s.event.session = "";
    s.event.props = { fatal: false, render: true };
    this.push(s.event);
  }

  private dropCrashMarker() {
    try {
      void Promise.resolve(this.env.storage?.removeItem(KEYS.crash)).catch(() => {});
    } catch {
      // a storage that throws instead of rejecting
    }
  }

  optOut() {
    this.disabled = true;
    this.queue = [];
    this.pending = [];
    if (this.settling) clearTimeout(this.settling.timer);
    this.settling = null;
    const s = this.env.storage;
    void Promise.all([s?.setItem(KEYS.optOut, "1"), s?.removeItem(KEYS.optIn), s?.removeItem(KEYS.queue), s?.removeItem(KEYS.crash), s?.removeItem(KEYS.visitor), s?.removeItem(KEYS.visitorAt), s?.removeItem(KEYS.session), s?.removeItem(KEYS.user)]).catch(() => {});
  }

  /** Starts (or resumes) measurement, e.g. after the user consents. Remembered across launches. */
  async optIn() {
    await this.loaded;
    this.disabled = false;
    if (!this.visitor) {
      this.visitor = uuid();
      this.visitorAt = this.env.now();
    }
    const s = this.env.storage;
    await Promise.all([s?.removeItem(KEYS.optOut), s?.setItem(KEYS.optIn, "1"), this.saveVisitor()]).catch(() => {});
  }

  /** Whether events are being recorded (false before consent with enabled: false, or after optOut). */
  get isEnabled() {
    return !this.disabled;
  }

  /** All feature flags for this install, evaluated by MetricMind's servers. */
  async flags(): Promise<Record<string, FlagResult>> {
    await this.loaded;
    if (this.disabled) return {};
    if (!this.flagsPromise) {
      const q = new URLSearchParams({ site: this.opts.site, visitor: this.visitor, path: this.screen?.path ?? "/", platform: appContext(this.opts).platform });
      if (this.user) q.set("user", this.user);
      if (this.opts.environment) q.set("env", this.opts.environment);
      const base = (this.opts.endpoint ?? DEFAULT_ENDPOINT).replace(/\/v1\/batch$/, "/v1/flags");
      this.flagsPromise = this.env
        .fetch(`${base}?${q}`)
        .then((r) => (r.ok ? r.json() : { flags: {} }))
        .then((b) => (b as { flags?: Record<string, FlagResult> }).flags ?? {})
        .catch(() => ({}));
    }
    return this.flagsPromise;
  }

  /** One flag; off when unknown or unreachable. Records an exposure once so the dashboard can compare variants. */
  async flag(key: string): Promise<FlagResult> {
    const all = await this.flags();
    if (!(key in all)) return OFF;
    const marker = `${key}=${all[key].variant}`;
    if (!this.exposed.has(marker)) {
      this.exposed.add(marker);
      void this.env.storage?.setItem(KEYS.exposed, JSON.stringify([...this.exposed].slice(-50))).catch(() => {});
      this.track("$flag", { flag: key, variant: all[key].variant });
    }
    return all[key];
  }

  /** IDs for checkout metadata (mm_visitor, mm_session, mm_user), so Stripe/Paddle revenue is attributed. */
  ids() {
    return { visitor: this.visitor, session: this.session.id, ...(this.user ? { user: this.user } : {}) };
  }

  startTimer() {
    this.timer ??= setInterval(() => void this.flush(), this.opts.flushIntervalMs ?? 10_000);
    this.startBeat();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopBeat();
    this.beatPaused = false;
    this.frameGen++;
  }
}

type NavigationRef = { getCurrentRoute(): { name: string } | undefined; addListener(event: "state", cb: () => void): () => void };

let instance: Tracker | null = null;

/**
 * Reports uncaught errors, render errors and unhandled promise rejections. Each part stands alone and
 * none can throw into the app. Exported for tests; MetricMind.init calls it.
 */
export function watchErrors(t: Tracker, rt: Runtime): void {
  // 1. The global handler: errors thrown in event handlers, timers and native callbacks.
  try {
    const utils = rt.ErrorUtils;
    if (utils && typeof utils.setGlobalHandler === "function") {
      const set = utils.setGlobalHandler.bind(utils);
      let chaining = 0;
      const wrap = (next: ErrorHandler | undefined): ErrorHandler => {
        const handler: ErrorHandler = (error, fatal) => {
          let onDisk: Promise<void> | null = null;
          if (!chaining) {
            try {
              onDisk = t.uncaught(error, fatal);
            } catch {
              // reporting never replaces the app's own handling
            }
          }
          const pass = () => {
            chaining++;
            try {
              next?.(error, fatal);
            } finally {
              chaining--;
            }
          };
          // React Native's handler closes the app on a fatal error: give the report a moment to reach the disk first.
          if (fatal && onDisk && !rt.__DEV__) void onDisk.then(pass, pass);
          else pass();
        };
        handler.mm = true;
        return handler;
      };
      set(wrap(utils.getGlobalHandler?.()));
      // A library that sets its handler after this one (a crash reporter, Expo's error recovery) and doesn't
      // call the one before it would cut reporting off: whatever is set later still gets ours in front.
      utils.setGlobalHandler = (h) => set(typeof h === "function" && !h.mm ? wrap(h) : h);
    }
  } catch {
    // no global handler: the other paths still work
  }
  // 2. Errors thrown while rendering: React Native logs them with console.error, marked isComponentError.
  try {
    const c = rt.console;
    const original = c?.error;
    if (c && typeof original === "function") {
      c.error = function (this: unknown, ...args: unknown[]) {
        try {
          const e = args[0] as { isComponentError?: unknown } | null;
          if (e && typeof e === "object" && e.isComponentError === true) t.renderError(e);
        } catch {
          // logging goes on
        }
        return original.apply(this, args);
      };
    }
  } catch {
    // console can't be wrapped here
  }
  // 3. Unhandled promise rejections. React Native only tracks them in development (where it shows them
  // itself, so that's left alone); in a release build nothing does, and they vanish. Hermes only.
  try {
    const hermes = rt.HermesInternal;
    if (!rt.__DEV__ && typeof hermes?.enablePromiseRejectionTracker === "function") {
      hermes.enablePromiseRejectionTracker({ allRejections: true, onUnhandled: (_id, reason) => t.rejection(reason), onHandled: () => {} });
    }
  } catch {
    // not Hermes, or a version without the tracker
  }
}

/** The SDK: call init() once at startup, then use the other methods anywhere. */
export const MetricMind = {
  init(opts: MetricMindOptions): Tracker {
    if (instance) return instance;
    const t = new Tracker(opts);
    instance = t;
    t.startTimer();
    AppState.addEventListener("change", (state) => (state === "active" ? t.foreground() : t.background()));
    if (opts.errors !== false) watchErrors(t, globalThis as unknown as Runtime);
    if (opts.deepLinks !== false && Linking) {
      void Linking.getInitialURL().then((url) => url && t.openURL(url)).catch(() => {});
      Linking.addEventListener("url", ({ url }) => t.openURL(url));
    }
    return t;
  },
  /** React Navigation: a screen view for every route change. Returns an unsubscribe function. */
  trackNavigation(ref: NavigationRef): () => void {
    const report = () => {
      const route = ref.getCurrentRoute();
      if (route) instance?.trackScreen(route.name);
    };
    report();
    // The action that starts a navigation, so the next screen's load time includes rendering it.
    // Typed loosely: not every React Navigation version declares this event.
    let offAction: (() => void) | undefined;
    try {
      const loose = ref as unknown as { addListener(event: string, cb: (e?: { data?: { noop?: boolean; action?: { type?: string } } }) => void): () => void };
      offAction = loose.addListener("__unsafe_action__", (e) => {
        if (!e?.data?.noop && e?.data?.action?.type !== "SET_PARAMS") instance?.navigationStart();
      });
    } catch {
      // load times then count from the screen view
    }
    const offState = ref.addListener("state", report);
    return () => {
      offState();
      try {
        offAction?.();
      } catch {
        // already removed
      }
    };
  },
  screen: (name: string, props?: Props) => instance?.trackScreen(name, props),
  /** A link opened the app (only needed with deepLinks: false): utm_* parameters credit the session to that campaign. */
  openURL: (url: string) => instance?.openURL(url),
  track: (name: string, props?: Props) => instance?.track(name, props),
  /**
   * Call when a navigation begins, if you call screen() yourself (trackNavigation does this for you):
   * the next screen's load time then includes rendering it. With expo-router:
   * useNavigationContainerRef().addListener("__unsafe_action__", () => MetricMind.navigationStart()).
   */
  navigationStart: () => instance?.navigationStart(),
  /** Call when the current screen's content has loaded (its data is on screen): records time to full display. */
  screenReady: () => instance?.screenReady(),
  contact: (channel: string, props?: Props) => instance?.contact(channel, props),
  /** What a user tells you (your feedback form), with an optional 1–5 rating. Emails and phone numbers are removed. */
  feedback: (message: string, rating?: number) => instance?.feedback(message, rating),
  search: (term: string, props?: Props & { results?: number }) => instance?.search(term, props),
  identify: (id: string, traits?: Props) => instance?.identify(id, traits),
  reset: () => instance?.reset(),
  captureError: (error: unknown, opts?: { fatal?: boolean }) => instance?.captureError(error, opts),
  flag: (key: string): Promise<FlagResult> => instance?.flag(key) ?? Promise.resolve(OFF),
  ids: () => instance?.ids(),
  optOut: () => instance?.optOut(),
  optIn: () => instance?.optIn(),
  flush: () => instance?.flush() ?? Promise.resolve(),
};
