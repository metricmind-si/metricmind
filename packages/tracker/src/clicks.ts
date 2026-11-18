// Click-derived events: outbound links and declarative data-track elements.
// Pure helpers are exported for tests; `watchClicks` wires them to the DOM.

type Props = Record<string, string | number | boolean | null>;
export type Emit = (name: string, props?: Props) => void;

export const OUTBOUND_EVENT = "$outbound";
export const CONTACT_EVENT = "contact";

/** Absolute http(s) URL on another host than the current page, else null. */
export function outboundUrl(href: string | null, currentHost: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, `https://${currentHost}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const strip = (h: string) => h.replace(/^www\./, "");
    if (strip(url.hostname) === strip(currentHost)) return null;
    // Drop query and fragment: they can carry tokens or personal data.
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export const SHARE_EVENT = "share";
export const DOWNLOAD_EVENT = "$download";

const FILE = /\.(pdf|zip|rar|7z|gz|tgz|dmg|exe|msi|apk|ipa|docx?|xlsx?|pptx?|odt|ods|csv|txt|epub|mp3|mp4|mov|avi|wav|key|pages|numbers)$/i;

/** A link to a downloadable file (same site or not): its path without query or fragment, and the file name; else null. */
export function downloadFile(href: string | null, currentHost: string): { file: string; name: string } | null {
  if (!href) return null;
  try {
    const url = new URL(href, `https://${currentHost}`);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !FILE.test(url.pathname)) return null;
    const own = url.hostname.replace(/^www\./, "") === currentHost.replace(/^www\./, "");
    return { file: own ? url.pathname : `${url.origin}${url.pathname}`, name: decodeURIComponent(url.pathname.split("/").pop() ?? "").slice(0, 120) };
  } catch {
    return null;
  }
}

/**
 * What a link does: contact someone (phone, WhatsApp with a number, email…)
 * or share the page (WhatsApp without a number, social share URLs). Only the
 * channel is ever sent: never the number, address or chat ID.
 */
export function linkIntent(href: string | null): { event: "contact" | "share"; channel: string } | null {
  if (!href) return null;
  const h = href.trim().toLowerCase();
  if (h.startsWith("tel:")) return { event: "contact", channel: "phone" };
  if (h.startsWith("sms:")) return { event: "contact", channel: "sms" };
  if (h.startsWith("mailto:")) return { event: "contact", channel: "email" };
  if (h.startsWith("viber:")) return { event: "contact", channel: "viber" };
  if (h.startsWith("whatsapp:")) return { event: /phone=\d/.test(h) ? "contact" : "share", channel: "whatsapp" };
  try {
    const u = new URL(h);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "wa.me") return { event: /^\/\+?\d{6,}/.test(u.pathname) ? "contact" : "share", channel: "whatsapp" };
    if (host === "api.whatsapp.com" || host === "web.whatsapp.com") return { event: /\d{6,}/.test(u.searchParams.get("phone") ?? "") ? "contact" : "share", channel: "whatsapp" };
    if (host === "t.me" || host === "telegram.me") return { event: u.pathname.startsWith("/share") ? "share" : "contact", channel: "telegram" };
    if (host === "m.me") return { event: "contact", channel: "messenger" };
    if ((host === "facebook.com" || host === "m.facebook.com") && u.pathname.startsWith("/sharer")) return { event: "share", channel: "facebook" };
    if ((host === "twitter.com" || host === "x.com") && u.pathname.startsWith("/intent/")) return { event: "share", channel: "x" };
    if (host === "linkedin.com" && u.pathname.startsWith("/sharing")) return { event: "share", channel: "linkedin" };
  } catch {}
  return null;
}

/** Contact channel of a link, else null (kept for callers that only need contacts). */
export function contactChannel(href: string | null): string | null {
  const intent = linkIntent(href);
  return intent?.event === "contact" ? intent.channel : null;
}

// Labels of buttons that start a conversation with the seller or the business
// (in-app chat, call or contact form), in English, French and Arabic.
const CONTACT_LABEL = /^(contact(er|ez)?|call|appel(er|ez)|send (a )?message|envoyer un message|[ée]crire (au|à)|chat with|discuter avec|whatsapp)(\s|$)/i;
const CONTACT_LABEL_AR = ["اتصل", "تواصل", "راسل", "كلم"];

/** Whether a button's visible label is a contact action, e.g. "Contacter le vendeur". */
export function contactButton(label: string | null | undefined): boolean {
  const t = (label ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 40) return false;
  return CONTACT_LABEL.test(t) || CONTACT_LABEL_AR.some((w) => t.startsWith(w));
}

/**
 * Props from an element's other data-* attributes, e.g.
 * <button data-track="signup" data-plan="pro"> -> { plan: "pro" }.
 */
export function dataProps(el: Element): Props {
  const props: Props = {};
  for (const attr of Array.from(el.attributes)) {
    if (!attr.name.startsWith("data-") || attr.name === "data-track") continue;
    const key = attr.name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (Object.keys(props).length < 10) props[key] = attr.value.slice(0, 200);
  }
  return props;
}

export const RAGE_EVENT = "$rage";
export const DEAD_EVENT = "$dead";

/** Buttons and links that should visibly do something; contact, download and new-tab links legitimately don't. */
export function looksClickable(el: Element): boolean {
  if (!el.matches("button, a[href], [role=button], [onclick], input[type=submit], input[type=button]")) return false;
  if (el.matches("a[target=_blank], a[download], button[type=reset]") || el.closest("[data-mm-ignore]")) return false;
  return linkIntent(el.getAttribute("href")) === null;
}
/** A link clicked with Cmd/Ctrl (new tab), Shift (new window) or Alt (download) leaves this page as it is, so it isn't dead. */
export function opensOutOfPlace(el: Element, e: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): boolean {
  return el.matches("a[href]") && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
}
const RAGE_CLICKS = 3;
const RAGE_WINDOW_MS = 1000;
const RAGE_RADIUS_PX = 30;

/**
 * Counts rapid clicks on one spot: true once per burst, on the third click
 * within a second and 30 px (a button that doesn't respond, a fake link).
 */
export function rageDetector(now: () => number = Date.now) {
  let clicks: { x: number; y: number; t: number; key: string }[] = [];
  let fired = false;
  /**
   * `key` identifies the clicked element; `responded` is whether the page changed (DOM or navigation) since the
   * previous click. A page that reacts isn't ignoring the visitor (steppers, carousels, "load more"), so it resets.
   */
  return (x: number, y: number, key = "", responded = false): boolean => {
    const t = now();
    const near = responded ? [] : clicks.filter((c) => t - c.t <= RAGE_WINDOW_MS && c.key === key && Math.hypot(c.x - x, c.y - y) <= RAGE_RADIUS_PX);
    if (near.length === 0) fired = false; // a pause, a new spot or a reaction starts a new burst
    clicks = [...near, { x, y, t, key }];
    if (clicks.length >= RAGE_CLICKS && !fired) return (fired = true);
    return false;
  };
}

/** Controls that take repeated clicks by design (typing, picking, sliding), and text being selected. */
function expectsRepeatedClicks(target: Element): boolean {
  if (target.closest("input, select, textarea, option, [contenteditable], [role=slider], [role=spinbutton], [role=textbox]")) return true;
  const selection = typeof getSelection === "function" ? getSelection() : null;
  return !!selection && !selection.isCollapsed && String(selection).trim().length > 0;
}

/** When the page last changed, watched only for a few seconds after each click (cheap on idle pages). */
function changeWatcher() {
  let lastChange = 0;
  // Recent change times, to ask "did the page change between this click and the next one?".
  let times: number[] = [];
  let observer: MutationObserver | null = null;
  let stop: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    lastChange = Date.now();
    if (times[times.length - 1] !== lastChange) times = [...times.slice(-49), lastChange];
  };
  return {
    arm() {
      if (typeof MutationObserver !== "function") return;
      if (!observer) {
        observer = new MutationObserver(changed);
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        addEventListener("popstate", changed);
        // A carousel or anchor that scrolls, or a native dialog taking the focus (file picker, install prompt), is a response too.
        addEventListener("scroll", changed, { capture: true, passive: true });
        addEventListener("blur", changed);
      }
      if (stop) clearTimeout(stop);
      stop = setTimeout(() => {
        observer?.disconnect();
        observer = null;
        removeEventListener("popstate", changed);
        removeEventListener("scroll", changed, { capture: true });
        removeEventListener("blur", changed);
      }, 3000);
    },
    since: (t: number) => lastChange >= t,
    between: (from: number, to: number) => times.some((t) => t >= from && t < to),
  };
}

/**
 * What was clicked, without personal data: the label of the nearest button or
 * link (long digit runs masked, 40 characters), else the tag name.
 */
/** An outbound link's visible text (aria-label first), ≤60 chars, long digit runs and emails masked; "" when there's none. */
export function linkText(el: Element | null): string {
  const t = (el?.getAttribute("aria-label") || el?.textContent || "").replace(/\s+/g, " ").trim();
  return t.replace(/\S+@\S+\.\S+/g, "[email]").replace(/\d[\d ]{3,}\d/g, "…").slice(0, 60);
}

export function clickTarget(el: Element): string {
  const control = el.closest("button, a, [role=button], input, select, label");
  const node = control ?? el;
  const tag = node.tagName.toLowerCase();
  const label = (node.getAttribute("aria-label") || (control && tag !== "input" ? node.textContent : "") || "").replace(/\s+/g, " ").trim();
  if (!label || label.length > 40) return tag;
  return `${tag}: ${label.replace(/\S+@\S+\.\S+/g, "[email]").replace(/\d{4,}/g, "…")}`;
}

export const CLICKS_EVENT = "$clicks";
const MAX_CLICK_LABELS = 20;

/**
 * Clicks on buttons and links, added up per page and reported once when it's left: which controls people use,
 * by label only (no positions, no field values), at the cost of one event per page instead of one per click.
 */
export function clickCounter() {
  const counts = new Map<string, number>();
  return {
    record(target: Element) {
      const control = target.closest("button, a[href], [role=button], summary, input[type=submit], input[type=button]");
      if (!control || control.closest("[data-mm-ignore]")) return;
      const label = clickTarget(control);
      if (counts.has(label) || counts.size < MAX_CLICK_LABELS) counts.set(label, (counts.get(label) ?? 0) + 1);
    },
    /** What was clicked since the last call, or null when nothing was. */
    take(): Props | null {
      if (!counts.size) return null;
      const out: Props = Object.fromEntries(counts);
      counts.clear();
      return out;
    },
  };
}

// The heatmap's grid: 8 columns of the window's width and 20 rows of 5% of the page's height, the same scale as scroll depth.
const gridIndex = (ratio: number, size: number) => Math.max(0, Math.min(size - 1, Math.floor(ratio * size)));

/** Which cell of the grid a click falls in: column + row × 8. */
export function heatCell(pageX: number, pageY: number, windowWidth: number, pageHeight: number): number {
  return gridIndex(pageX / windowWidth, 8) + gridIndex(pageY / pageHeight, 20) * 8;
}

/** A name worth reporting only when it looks written by a developer: no text, generated IDs, long numbers, email or path. */
export function stableName(value: string | null | undefined): string {
  return value && value.length < 33 && /^[a-zA-Z][a-zA-Z_-]*\d{0,2}$/.test(value) ? value : "";
}

/**
 * A control as its page region, tag and stable name, never its text or value: "main button#buy",
 * "header a[signup_clicked]", "nav a". A click on plain page text has no key. At most 54 characters.
 */
export function elementKey(target: Element): string {
  const el = target.closest("a[href], button, [role=button], summary, [data-track]");
  if (!el) return "";
  const named = stableName(el.getAttribute("data-track"));
  const region = el.closest("header, nav, main, footer, aside")?.tagName ?? "";
  return `${region} ${el.tagName.slice(0, 8)}${named ? `[${named}]` : stableName(el.id) && `#${el.id}`}`.trim().toLowerCase();
}

/** Fields, password forms, and parts of the page the site left out are never part of the heatmap. */
export function heatIgnored(target: Element): boolean {
  return Boolean(expectsRepeatedClicks(target) || target.closest("label, [data-mm-ignore], [role=combobox], [role=listbox]") || target.closest("form")?.querySelector("input[type=password]"));
}

const CLICK_COUNT_MAX = 999;

/**
 * Clicks of one page as two short strings, sent with `$clicks` on leaving: `$grid` "cell~count,…" (≤40 cells) and
 * `$el` "key~count,…" (≤8 elements, so always under ingest's 500 characters a property). Counts only, not their order.
 */
export function heatCounter() {
  const cells = new Map<string | number, number>();
  const elements = new Map<string | number, number>();
  const add = (map: Map<string | number, number>, key: string | number, max: number) => {
    if (map.has(key) || map.size < max) map.set(key, Math.min((map.get(key) ?? 0) + 1, CLICK_COUNT_MAX));
  };
  const text = (map: Map<string | number, number>) => [...map].map(([k, n]) => `${k}~${n}`).join();
  return {
    record(e: Pick<MouseEvent, "isTrusted" | "detail" | "clientX" | "clientY">, target: Element) {
      if (!e.isTrusted || heatIgnored(target)) return;
      const key = elementKey(target);
      if (key) add(elements, key, 8);
      // A keyboard click (detail 0) has no position; fixed bars and sticky headers move with the window, so they have none on the page.
      let node: Element | null = target;
      while (node && !/^(fix|stic)/.test(getComputedStyle(node).position)) node = node.parentElement;
      if (e.detail > 0 && !node) add(cells, heatCell(e.clientX, scrollY + e.clientY, innerWidth, document.documentElement.scrollHeight), 40);
    },
    take(): Props | null {
      if (!cells.size && !elements.size) return null;
      const out: Props = {};
      if (cells.size) out.$grid = text(cells);
      if (elements.size) out.$el = text(elements);
      cells.clear();
      elements.clear();
      return out;
    },
  };
}

const DEAD_WAIT_MS = 1500;
// A link to another page on a slow connection is still loading after 1.5 s, not dead.
const LINK_WAIT_MS = 5000;
function opensAnotherPage(el: Element): boolean {
  const href = el.getAttribute("href");
  if (!href || !el.matches("a")) return false;
  try {
    const to = new URL(href, location.href);
    return to.pathname !== location.pathname || to.search !== location.search;
  } catch {
    return false;
  }
}

export function watchClicks(emit: Emit, opts: { outbound: boolean; contacts?: boolean; count?: (target: Element) => void; heat?: (e: MouseEvent, target: Element) => void }) {
  const rage = rageDetector();
  const changes = changeWatcher();
  let lastClick = 0;
  let deadSent = 0;
  let lastHref = typeof location === "object" ? location.href : "";
  const ids = new WeakMap<Element, number>();
  let nextId = 0;
  const idOf = (el: Element) => {
    let id = ids.get(el);
    if (id === undefined) ids.set(el, (id = ++nextId));
    return String(id);
  };
  const onClick = (e: Event) => {
    // auxclick covers the middle button (open in a new tab); a right-click opens a menu, it doesn't act.
    if (e.type === "auxclick" && (e as MouseEvent).button !== 1) return;
    const target = e.target instanceof Element ? e.target : null;
    // The survey widget's own buttons aren't the site's.
    if (!target || target.hasAttribute("data-mm-survey")) return;
    opts.count?.(target);
    if (e.type === "click") opts.heat?.(e as MouseEvent, target);
    if (e.type === "click" && e instanceof MouseEvent && !expectsRepeatedClicks(target)) {
      const el = target.closest("button, a, [role=button], label, [onclick]") ?? target;
      const responded = lastClick > 0 && (changes.since(lastClick) || location.href !== lastHref);
      lastClick = Date.now();
      lastHref = location.href;
      changes.arm();
      if (rage(e.clientX, e.clientY, idOf(el), responded)) emit(RAGE_EVENT, { target: clickTarget(target) });
      // Dead click: something that looks clickable where nothing happens (no page change, no navigation).
      if (deadSent < 10 && looksClickable(el) && !opensOutOfPlace(el, e)) {
        const at = lastClick;
        const href = location.href;
        setTimeout(() => {
          // Only what happened before the next click counts as this click's effect.
          const until = lastClick > at ? lastClick : Infinity;
          if (!changes.between(at, until) && location.href === href && document.visibilityState === "visible" && deadSent < 10) {
            deadSent++;
            emit(DEAD_EVENT, { target: clickTarget(target) });
          }
        }, opensAnotherPage(el) ? LINK_WAIT_MS : DEAD_WAIT_MS);
      }
    }

    const tracked = target.closest("[data-track]");
    const name = tracked?.getAttribute("data-track");
    if (tracked && name) emit(name.slice(0, 120), dataProps(tracked));

    const link = target.closest("a[href]");
    const href = link?.getAttribute("href") ?? null;
    const intent = linkIntent(href);
    if (intent) {
      // Contact and share links carry phone numbers, addresses or page text: never sent as outbound URLs.
      if (opts.contacts !== false) emit(intent.event === "contact" ? CONTACT_EVENT : SHARE_EVENT, { channel: intent.channel });
      return;
    }
    // Downloads count once, as a download (not also as an outbound link).
    const download = downloadFile(href, location.hostname);
    if (download) return emit(DOWNLOAD_EVENT, download);
    if (opts.outbound) {
      const url = outboundUrl(href, location.hostname);
      if (url) {
        const text = linkText(link);
        emit(OUTBOUND_EVENT, text ? { url, text } : { url });
      }
    }
    // Contact buttons that open an in-app chat or a call sheet have no link to read.
    if (!link && !tracked && e.type === "click" && opts.contacts !== false) {
      const button = target.closest("button, [role=button]");
      if (button && contactButton(button.getAttribute("aria-label") || button.textContent)) emit(CONTACT_EVENT, { channel: "button" });
    }
  };
  // Capture phase: runs before handlers that navigate or stop propagation.
  document.addEventListener("click", onClick, { capture: true });
  document.addEventListener("auxclick", onClick, { capture: true });
}
