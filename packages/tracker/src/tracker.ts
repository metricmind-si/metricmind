import { readOverrides, setOverride, withOverrides } from "./flag-override";
import { onCLS, onFCP, onINP, onLCP, type Metric } from "web-vitals";
import { isCrawler, isLikelyBot } from "./bot";
import { CLICKS_EVENT, clickCounter, heatCounter, watchClicks } from "./clicks";
import { currentSession, clearIdentity, setUserId, touchSession, userId, uuid, visitorId } from "./identity";
import { browserTransport, Queue } from "./queue";
import { watchForms } from "./forms";
import { redactEvent, redactPath, redactReferrer, type Redaction } from "./redact";
import { feedbackText, SEARCH_EVENT, searchResults, searchTerm } from "./search";
import { SURVEY_EVENT, SURVEY_KEY, TAB_ID, type PublicSurvey, type SurveyBridge, type SurveyProps } from "./survey-state";
import type { Batch, TrackerEvent } from "./types";

export interface TrackerConfig {
  site: string;
  endpoint: string;
  vitals?: boolean;
  errors?: boolean;
  /** The site routes with the URL's hash (#/listing/3): each route counts as a page (default false). */
  hash?: boolean;
  /** Track clicks on links to other sites (default true). */
  outbound?: boolean;
  /** Count clicks on buttons and links per page, by label (default true). */
  clicks?: boolean;
  /** Add a coarse click grid and stable element keys to those counts, for the heatmap (opt-in; needs clicks). */
  heatmap?: boolean;
  /** Show the site's live surveys (default true). Never in storage-free mode or with a privacy signal. */
  surveys?: boolean;
  /** Track pages even when the visitor looks like a bot (for testing). */
  allowBots?: boolean;
  /** Auto-track tel:, mailto:, WhatsApp and similar links as a "contact" event (channel only). */
  contacts?: boolean;
  /** URL parameter of the site's search box ("off" disables site search terms). */
  search?: string;
  /** Track on localhost and private hosts (default false, like a dev build). */
  allowLocal?: boolean;
  /** Which feature flags apply (data-environment); empty serves flags without an environment. */
  environment?: string;
  /** Treat the browser's Global Privacy Control or Do Not Track signal as an opt-out (default false). */
  respectGpc?: boolean;
  /**
   * "none": store nothing in the browser. IDs live in memory for the page and
   * the server counts visitors with a daily-rotating hash instead (no consent
   * needed under the ePrivacy storage rule). Only an explicit opt-out is stored.
   */
  storage?: "none";
  /** The page's own redaction of paths and text (`window.mmRedact`, see redact.ts). */
  redact?: Redaction;
}

/** The browser asks not to be tracked: Global Privacy Control, or the older Do Not Track. */
export function privacySignal(nav: { globalPrivacyControl?: unknown; doNotTrack?: unknown }): boolean {
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1" || nav.doNotTrack === "yes";
}

type Props = NonNullable<TrackerEvent["props"]>;

const OPT_OUT_KEY = "mm_optout";
const EXPOSED_KEY = "mm_fx";
// This site had no live survey: not asked again for an hour, in this tab.
const NO_SURVEY_KEY = "mm_sn";

export interface FlagResult {
  enabled: boolean;
  variant: string;
  /** The JSON set on the flag or variant, when there is one. */
  payload?: unknown;
}
const OFF: FlagResult = { enabled: false, variant: "off" };
const applied = (flags: Record<string, FlagResult>, store: Parameters<typeof readOverrides>[0]) => withOverrides(flags, readOverrides(store));

export class Tracker implements SurveyBridge {
  private readonly queue: Queue;
  disabled: boolean;
  currentPath = "";
  /** What is recorded for the current page: its path through the page's redaction, or null when the page is left out. */
  private sentPath: string | null = null;
  /** Events sent on this page so far, for surveys that wait for one. */
  readonly fired = new Set<string>();
  onFired?: (name: string) => void;
  private engagedMs = 0;
  private visibleSince = 0;
  private exitSent = false;
  private readonly clicks = clickCounter();
  private readonly heat = heatCounter();
  // Reports forms started but not sent; called when the page is left (not when the tab is only hidden).
  private endForms: () => void = () => {};
  /** Deepest point of the current page seen so far, in percent. */
  /** The lowest point seen on this page in pixels; a percent is worked out on leaving, when lazy content has loaded. */
  private maxScrollBottom = 0;
  /** start() has been called (a later optIn may start measuring) and measuring has begun. */
  private booted = false;
  private running = false;
  private flagsPromise: Promise<Record<string, FlagResult>> | null = null;
  private statusChecked = false;
  /** A crawler that runs JavaScript: each page is reported once as a crawler read and nothing else is measured. */
  private readonly crawler: boolean;

  constructor(private readonly config: TrackerConfig) {
    this.queue = new Queue({ endpoint: config.endpoint, site: config.site, anonymous: config.storage === "none" }, browserTransport);
    this.disabled =
      optedOut() ||
      Boolean(config.respectGpc && privacySignal(navigator as Navigator & { globalPrivacyControl?: boolean })) ||
      (!config.allowBots && isLikelyBot(navigator, window as object)) ||
      (!config.allowLocal && isLocalHost(location.hostname));
    this.crawler = !config.allowBots && isCrawler(navigator.userAgent || "") && !optedOut() && (config.allowLocal || !isLocalHost(location.hostname));
  }

  start() {
    this.booted = true;
    if (this.crawler) return this.reportCrawl();
    if (this.disabled || this.running) return;
    // A page prerendered by the browser (speculation rules) counts only once the visitor opens it.
    if ((document as Document & { prerendering?: boolean }).prerendering) {
      document.addEventListener("prerenderingchange", () => this.start(), { once: true });
      return;
    }
    // Same for a tab opened in the background: it's a visit once it's looked at.
    if (document.visibilityState === "hidden") {
      const shown = () => {
        if (document.visibilityState === "hidden") return;
        document.removeEventListener("visibilitychange", shown);
        this.start();
      };
      document.addEventListener("visibilitychange", shown);
      return;
    }
    this.running = true;
    this.pageview();
    this.watchNavigation();
    this.watchVisibility();
    this.watchScroll();
    if (this.config.vitals !== false) this.watchVitals();
    if (this.config.errors !== false) this.watchErrors();
    watchClicks((name, props) => this.track(name, props), { outbound: this.config.outbound !== false, contacts: this.config.contacts !== false, count: this.config.clicks === false ? undefined : (el) => this.clicks.record(el), heat: this.config.clicks === false || this.config.heatmap !== true ? undefined : (e, el) => this.heat.record(e, el) });
    this.endForms = watchForms((name, props) => this.track(name, props));
  }

  /** A custom event; `revenue` records a sale with it (`order_id` keeps a reloaded thank-you page from counting twice). */
  track(name: string, props?: Props, options?: { revenue?: { amount: number; currency: string; order_id?: string | number } }) {
    if (this.disabled || !name) return;
    this.emit({ type: "event", name: String(name).slice(0, 120), props, ...saleOf(options?.revenue) });
  }

  /** What a visitor tells you (a feedback form, "was this helpful?"), with an optional 1–5 rating. */
  feedback(message: string, rating?: number) {
    const text = feedbackText(message);
    if (this.disabled || !text) return;
    const props: Props = { message: text };
    if (typeof rating === "number" && rating >= 1 && rating <= 5) props.rating = Math.round(rating);
    this.emit({ type: "event", name: "$feedback", props });
  }

  /**
   * Links this browser to the site's own user ID (e.g. after login). Traits
   * such as email, name or plan are sent once as an `$identify` event; only
   * pass what your privacy policy covers.
   */
  identify(id: string, traits?: Props) {
    if (this.disabled || !id) return;
    const user = String(id).slice(0, 128);
    const changed = userId(this.store("local")) !== user;
    setUserId(this.store("local"), user);
    if (changed) this.flagsPromise = null;
    if (changed || traits) this.emit({ type: "event", name: "$identify", props: traits });
  }

  /** Forgets the user (call on logout): new anonymous visitor and session. */
  reset() {
    clearIdentity(this.store("local"), this.store("session"));
    this.store("local")?.removeItem(SURVEY_KEY);
    this.flagsPromise = null;
  }

  /**
   * IDs to put in checkout metadata (mm_visitor, mm_session, mm_user) so
   * payments from Stripe or Paddle webhooks are attributed to this visit.
   */
  ids(): { visitor: string; session: string; user?: string } {
    return { visitor: visitorId(this.store("local")), session: touchSession(this.store("local")), user: userId(this.store("local")) };
  }

  /** All flags for this visitor, fetched once per page (and again after identify/reset). */
  flags(): Promise<Record<string, FlagResult>> {
    const local = this.store("local");
    // Works where nothing is measured too (localhost), which is where a flag gets tested.
    if (this.disabled) return Promise.resolve(applied({}, local));
    if (!this.flagsPromise) {
      // A first-party proxy's data-api can be a path on the site itself.
      const url = new URL(this.config.endpoint.replace(/\/v1\/batch$/, "/v1/flags"), location.href);
      url.searchParams.set("site", this.config.site);
      // Storage-free: the server derives the visitor from the request, like for page views.
      if (this.config.storage === "none") url.searchParams.set("anonymous", "1");
      else url.searchParams.set("visitor", visitorId(this.store("local")));
      const user = userId(this.store("local"));
      if (user) url.searchParams.set("user", user);
      url.searchParams.set("path", this.pathFor(location.pathname) ?? "/");
      url.searchParams.set("payloads", "1");
      if (this.config.environment) url.searchParams.set("env", this.config.environment);
      this.flagsPromise = fetch(url, { credentials: "omit" })
        .then((r) => (r.ok ? r.json() : { flags: {} }))
        .then((b: { flags?: Record<string, FlagResult> }) => b.flags ?? {})
        .catch(() => ({}));
    }
    return this.flagsPromise.then((all) => applied(all, local));
  }

  /**
   * One flag's value; off when unknown or unreachable. Records an exposure
   * (`$flag`) once per session so the dashboard can compare variants.
   */
  async flag(key: string): Promise<FlagResult> {
    const all = await this.flags();
    if (!(key in all)) return OFF;
    // An override is someone testing, not a visitor in the experiment.
    if (!(key in readOverrides(this.store("local")))) this.expose(key, all[key].variant);
    return all[key];
  }

  /** Forces a flag in this browser only, for testing: a variant key, "on" or "off"; null clears it. No exposure is sent. */
  flagOverride(key: string, variant: string | null) {
    setOverride(this.store("local"), key, variant);
  }

  private expose(key: string, variant: string) {
    const store = this.store("session");
    const marker = `${key}=${variant}`;
    let seen: string[] = [];
    try {
      seen = JSON.parse(store?.getItem(EXPOSED_KEY) ?? "[]");
    } catch {}
    if (seen.includes(marker)) return;
    try {
      store?.setItem(EXPOSED_KEY, JSON.stringify([...seen, marker].slice(-50)));
    } catch {}
    this.emit({ type: "event", name: "$flag", props: { flag: key, variant } });
  }

  /** Stops measurement now (queued events are dropped) and in future visits; deletes the stored IDs. */
  optOut() {
    try {
      localStorage.setItem(OPT_OUT_KEY, "1");
    } catch {}
    this.disabled = true;
    this.queue.clear();
    clearIdentity(this.store("local"), this.store("session"));
    this.store("local")?.removeItem(SURVEY_KEY);
    document.getElementById("mm-survey")?.remove();
    document.getElementById(TAB_ID)?.remove();
  }

  /** Resumes measurement (from the next page view unless the page is otherwise excluded). */
  optIn() {
    try {
      localStorage.removeItem(OPT_OUT_KEY);
    } catch {}
    this.disabled = (!this.config.allowBots && isLikelyBot(navigator, window as object)) || (!this.config.allowLocal && isLocalHost(location.hostname));
    // Consent given after the page loaded: measuring starts now, not at the next reload.
    if (this.booted && !this.disabled) this.start();
  }

  /** The site's live surveys for this page. survey.js, with everything else about showing them, loads only when one is due. */
  private checkSurveys() {
    // Storage-free pages can't remember a dismissal; a privacy signal means no prompts, whatever the site chose.
    if (this.disabled || this.config.surveys === false || this.config.storage === "none" || privacySignal(navigator as Navigator & { globalPrivacyControl?: boolean })) return;
    const tab = this.store("session");
    if (Date.now() - Number(tab?.getItem(NO_SURVEY_KEY) ?? 0) < 36e5) return;
    const api = this.config.endpoint.replace(/\/v1\/batch$/, "");
    const path = this.currentPath;
    const sent = this.sentPath;
    if (sent === null) return;
    fetch(`${api}/v1/surveys?${new URLSearchParams({ site: this.config.site, visitor: visitorId(this.store("local")), path: sent })}`, { credentials: "omit" })
      .then((r) => r.json())
      .then((b: { surveys: PublicSurvey[]; none?: boolean }) => {
        if (b.none) tab?.setItem(NO_SURVEY_KEY, String(Date.now()));
        // Answered or dismissed for good: no need for the widget. survey.js works out the rest.
        const seen = this.store("local")?.getItem(SURVEY_KEY) ?? "";
        const due = b.surveys.filter((s) => s.repeat || s.tab !== undefined || !seen.includes(s.id));
        if (path !== this.currentPath) return;
        // A feedback tab stays only on pages it targets.
        if (!due.length) return void document.getElementById(TAB_ID)?.remove();
        const show = () => window.mmSurveyUI?.(due, this);
        if (window.mmSurveyUI) return show();
        const el = document.createElement("script");
        el.src = `${api}/v1/survey.js`;
        el.onload = show;
        document.head.appendChild(el);
      })
      .catch(() => {});
  }

  /** survey.js sends what the visitor answers through this. */
  surveyAnswer(props: SurveyProps) {
    this.emit({ type: "event", name: SURVEY_EVENT, props });
  }

  /** One `search` event per new term (and page), so refining a search on /search counts again. */
  private lastSearch = "";
  private searchEvent(path: string) {
    const term = searchTerm(location.search, this.config.search);
    const key = term ? `${path}\n${term}` : "";
    if (key && key !== this.lastSearch && term) this.sendSearch(term, key);
    this.lastSearch = key;
  }

  /**
   * Sends the search with its result count when the page marks it (data-mm-results), waiting up to
   * 2.5 s for results to render; without a count after that, or when the page is left first.
   */
  private sendSearch(term: string, key: string) {
    let sent = false;
    const send = (results: number | null) => {
      if (sent) return;
      sent = true;
      removeEventListener("pagehide", onHide);
      this.track(SEARCH_EVENT, results === null ? { term } : { term, results });
    };
    const onHide = () => send(searchResults(document));
    const check = (last: boolean) => {
      if (sent || this.lastSearch !== key) return send(null);
      const n = searchResults(document);
      if (n !== null || last) send(n);
    };
    // Only the page's own marker is trusted at once: a results line read from text may still be the previous search's.
    const now = searchResults(document, false);
    if (now !== null) return send(now);
    addEventListener("pagehide", onHide);
    setTimeout(() => check(false), 400);
    setTimeout(() => check(false), 1200);
    setTimeout(() => check(true), 2500);
  }

  private pageview() {
    // Pathname only: query strings split pages and can carry personal data.
    // UTM tags are read from the query separately below.
    const path = this.config.hash ? hashPath(location.pathname, location.hash) : location.pathname;
    if (path !== this.currentPath) {
      // The new route may already be rendered, so the old page's depth is not re-measured.
      if (this.currentPath) {
        this.endForms();
        this.exit(false);
      }
      this.currentPath = path;
      this.sentPath = this.pathFor(path);
      this.maxScrollBottom = 0;
      // Once the page has rendered: short pages are fully seen without scrolling.
      setTimeout(() => this.currentPath === path && this.measureScroll(), 1000);
      this.engagedMs = 0;
      this.visibleSince = document.visibilityState === "visible" ? Date.now() : 0;
      this.exitSent = false;
      this.fired.clear();
      this.emit({
        type: "pageview",
        // A page that redacts its paths would give them away in its titles.
        title: this.config.redact?.path ? undefined : document.title,
        referrer: redactReferrer(this.config.redact, document.referrer, location.origin),
        utm: utmParams(location.search),
      });
      // A page the server answered with 404 (Navigation Timing responseStatus; first page load only).
      if (!this.statusChecked) {
        this.statusChecked = true;
        if (navigationStatus() === 404) this.track(NOT_FOUND_EVENT);
      }
      // Once the page has had its turn: nothing of this should compete with it loading.
      setTimeout(() => this.currentPath === path && this.checkSurveys(), 1000);
    }
    // After the pageview, so the search belongs to the page it happened on.
    this.searchEvent(path);
  }

  /**
   * Engaged (visible) time since the last exit for this page. A page can emit
   * several exits (tab hidden, then shown, then closed); summing them gives
   * the total engaged time without double counting.
   */
  private exit(measure = true) {
    if (this.exitSent) return;
    this.pauseEngagement();
    if (measure) this.measureScroll();
    const counted = this.clicks.take();
    const placed = this.heat.take();
    if (counted || placed) this.emit({ type: "event", name: CLICKS_EVENT, props: { ...counted, ...placed } });
    this.emit({ type: "exit", value: this.engagedMs, props: { scroll: scrollPercent(0, this.maxScrollBottom, document.documentElement.scrollHeight) } });
    this.engagedMs = 0;
    this.exitSent = true;
  }

  private readonly memory = { local: memoryStore(), session: memoryStore() };
  /** Browser storage, or a per-page memory store in storage-free mode. */
  store(kind: "local" | "session"): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
    return this.config.storage === "none" ? this.memory[kind] : safeStorage(kind);
  }

  /** Ingest records it in crawler_hits when it knows the crawler (by user agent) and drops it otherwise. */
  private reportCrawl() {
    const path = this.pathFor(location.pathname);
    if (path === null) return;
    const event: TrackerEvent = { id: uuid(), type: "pageview", ts: Date.now(), visitor: "crawler", session: "crawler", path };
    const batch: Batch = { site: this.config.site, events: [event], crawler: true };
    // fetch, not sendBeacon: crawler renderers may skip beacons.
    void browserTransport.send(this.config.endpoint, JSON.stringify(batch));
  }

  /** A path as recorded: through the page's redaction (null = the page is left out). */
  private pathFor(raw: string): string | null {
    return redactPath(this.config.redact, raw);
  }

  private emit(raw: Omit<TrackerEvent, "id" | "ts" | "visitor" | "session" | "path">) {
    // One gate for every event type (page views, exits, vitals, errors), so an opt-out takes effect at once.
    if (this.disabled) return;
    const path = this.currentPath ? this.sentPath : this.pathFor(location.pathname);
    if (path === null) return;
    const partial = redactEvent(this.config.redact, raw);
    this.queue.push({
      id: uuid(),
      ts: Date.now(),
      visitor: visitorId(this.store("local")),
      session: partial.type === "exit" || partial.type === "vital" ? currentSession(this.store("local")) : touchSession(this.store("local")),
      user: userId(this.store("local")),
      path,
      lang: navigator.language,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      viewport: `${innerWidth}x${innerHeight}`,
      ...partial,
    });
    if (partial.type === "event" && partial.name) {
      this.fired.add(partial.name);
      this.onFired?.(partial.name);
    }
  }

  private watchNavigation() {
    const onChange = () => setTimeout(() => this.pageview(), 0);
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const result = original.apply(this, args);
        onChange();
        return result;
      };
    }
    addEventListener("popstate", onChange);
    if (this.config.hash) addEventListener("hashchange", onChange);
  }

  private watchVisibility() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.exit();
        this.queue.flushBeacon();
      } else {
        // Coming back to the tab: keep counting for the same page.
        this.exitSent = false;
        this.visibleSince = Date.now();
      }
    });
    addEventListener("pagehide", () => {
      this.endForms();
      this.exit();
      this.queue.flushBeacon();
    });
    // Back/forward to a page kept in the browser's cache: the visitor is on it again, so it's a new view.
    addEventListener("pageshow", (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      this.currentPath = "";
      this.pageview();
    });
  }

  private measureScroll() {
    this.maxScrollBottom = Math.max(this.maxScrollBottom, scrollY + innerHeight);
  }

  private watchScroll() {
    let pending = false;
    addEventListener(
      "scroll",
      () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          this.measureScroll();
        });
      },
      { passive: true },
    );
  }

  private pauseEngagement() {
    if (this.visibleSince) this.engagedMs += Date.now() - this.visibleSince;
    this.visibleSince = 0;
  }

  private watchVitals() {
    const report = (m: Metric) => this.emit({ type: "vital", name: m.name, value: round(m.value) });
    onLCP(report);
    onINP(report);
    onCLS(report);
    onFCP(report);
    // TTFB straight from navigation timing: web-vitals' onTTFB waits for the
    // load event, which never fires while any request on the page hangs.
    const ttfb = ttfbFrom(performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined);
    if (ttfb !== null) this.emit({ type: "vital", name: "TTFB", value: round(ttfb) });
  }

  private watchErrors() {
    let sent = 0;
    const report = (message: string, stack?: string, file?: string) => {
      if (isNoiseError(message, stack, file)) return;
      if (sent++ >= 20) return; // a looping error shouldn't flood the queue
      this.emit({ type: "error", error: { message: message.slice(0, 500), stack: stack?.slice(0, 4000) } });
    };
    addEventListener("error", (e: ErrorEvent) => report(e.message || "Script error", e.error?.stack, e.filename));
    addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      report(reason instanceof Error ? reason.message : String(reason), reason?.stack);
    });
  }
}

/** Time to first byte from the navigation entry, minus prerender activation; null when unavailable. */
export function ttfbFrom(nav?: Pick<PerformanceNavigationTiming, "responseStart" | "activationStart">): number | null {
  if (!nav || !(nav.responseStart > 0)) return null;
  return Math.max(0, nav.responseStart - (nav.activationStart || 0));
}

/** How far down the page the bottom of the viewport is, 0–100. */
/** The sale to send, or nothing when it isn't one: a positive amount in a three-letter currency. */
export function saleOf(revenue?: { amount: number; currency: string; order_id?: string | number }): { revenue?: TrackerEvent["revenue"] } {
  if (!revenue) return {};
  const amount = Number(revenue.amount);
  const currency = String(revenue.currency ?? "").toUpperCase();
  if (!(amount > 0) || !Number.isFinite(amount) || !/^[A-Z]{3}$/.test(currency)) return {};
  const order = revenue.order_id === undefined || revenue.order_id === null ? "" : String(revenue.order_id).slice(0, 128);
  return { revenue: { amount, currency, ...(order && { order_id: order }) } };
}

export function scrollPercent(scrollTop: number, viewport: number, documentHeight: number): number {
  if (!(documentHeight > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round(((scrollTop + viewport) / documentHeight) * 100)));
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

// Ad click IDs and the network each points to; only the network is sent, never the ID.
// fbclid is added to every link leaving Facebook, ads or not, so it maps to "facebook".
const AD_CLICKS: [string, string][] = [["gclid", "google_ads"], ["gbraid", "google_ads"], ["wbraid", "google_ads"], ["msclkid", "microsoft_ads"], ["ttclid", "tiktok_ads"], ["twclid", "x_ads"], ["li_fat_id", "linkedin_ads"], ["fbclid", "facebook"]];

export function utmParams(search: string): TrackerEvent["utm"] {
  const q = new URLSearchParams(search);
  const utm = {
    source: q.get("utm_source") ?? q.get("ref") ?? undefined,
    medium: q.get("utm_medium") ?? undefined,
    campaign: q.get("utm_campaign") ?? undefined,
    term: q.get("utm_term") ?? undefined,
    content: q.get("utm_content") ?? undefined,
    click: AD_CLICKS.find(([param]) => q.get(param))?.[1],
  };
  return Object.values(utm).some(Boolean) ? JSON.parse(JSON.stringify(utm)) : undefined;
}

/** The page of a hash-routed app: "#/listing/3" and "#!/listing/3" are routes (query dropped), "#reviews" is only an anchor. */
export function hashPath(pathname: string, hash: string): string {
  const route = hash.match(/^#!?(\/[^?]*)/)?.[1];
  return route ? `${pathname.replace(/\/$/, "")}${route}` : pathname;
}

export function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^\[?::1\]?$|^0\.0\.0\.0$/.test(host)
  );
}

function optedOut(): boolean {
  try {
    return localStorage.getItem(OPT_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

export const NOT_FOUND_EVENT = "$404";

/** The HTTP status of the page load, when the browser reports it (Chrome 109+, Firefox 120+); 0 otherwise. */
export function navigationStatus(entries: unknown[] = typeof performance === "object" ? performance.getEntriesByType("navigation") : []): number {
  const status = (entries[0] as { responseStatus?: number } | undefined)?.responseStatus;
  return typeof status === "number" ? status : 0;
}

function memoryStore(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

function safeStorage(kind: "local" | "session"): Storage | undefined {
  try {
    return kind === "local" ? localStorage : sessionStorage;
  } catch {
    return undefined;
  }
}

const EXTENSION = /\b(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\//;

/**
 * Errors that say nothing about the site: browser extensions' own code, cross-origin "Script error." with no
 * details, and ResizeObserver loop warnings browsers report as errors. They would trigger false error alerts.
 */
export function isNoiseError(message: string, stack?: string, file?: string): boolean {
  if (EXTENSION.test(file ?? "") || EXTENSION.test(stack ?? "")) return true;
  if (/^(?:Uncaught )?Script error\.?$/i.test(message.trim()) && !stack) return true;
  return /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i.test(message);
}
