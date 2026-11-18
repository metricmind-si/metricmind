import { describe, expect, test } from "bun:test";
import { isCrawler, isLikelyBot } from "../src/bot";
import { clickCounter } from "../src/clicks";
import { clickTarget, dataProps, downloadFile, linkText, opensOutOfPlace, outboundUrl, rageDetector } from "../src/clicks";
import { clearIdentity, currentSession, SESSION_IDLE_MS, touchSession, VISITOR_LEGACY_ISSUED, VISITOR_LIFETIME_MS, visitorId } from "../src/identity";
import { isTypedField } from "../src/forms";
import { readOverrides, setOverride, withOverrides } from "../src/flag-override";
import { delivered, Queue, type Transport } from "../src/queue";
import { hashPath, isLocalHost, saleOf, isNoiseError, navigationStatus, privacySignal, scrollPercent, ttfbFrom, utmParams } from "../src/tracker";
import type { Batch, TrackerEvent } from "../src/types";

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const event = (n: number): TrackerEvent => ({
  id: `id-${n}`,
  type: "pageview",
  ts: n,
  visitor: "v",
  session: "s",
  path: "/",
});

describe("flag overrides", () => {
  test("stored per browser, cleared with null", () => {
    const store = memoryStore();
    setOverride(store, "a", "b");
    setOverride(store, "c", "off");
    expect(readOverrides(store)).toEqual({ a: "b", c: "off" });
    setOverride(store, "a", null);
    setOverride(store, "c", null);
    expect(readOverrides(store)).toEqual({});
    expect(store.getItem("mm_fo")).toBeNull();
  });
  test("broken storage reads as none", () => {
    const store = memoryStore();
    store.setItem("mm_fo", "{oops");
    expect(readOverrides(store)).toEqual({});
  });
  test("win over the server's answer, and only keep a payload on its own variant", () => {
    const server = { a: { enabled: false, variant: "off" }, b: { enabled: true, variant: "x", payload: 1 }, c: { enabled: true, variant: "y", payload: 2 } };
    expect(withOverrides(server, { a: "on", b: "z", c: "y", d: "off" })).toEqual({
      a: { enabled: true, variant: "on" },
      b: { enabled: true, variant: "z" },
      c: { enabled: true, variant: "y", payload: 2 },
      d: { enabled: false, variant: "off" },
    });
  });
});

describe("identity", () => {
  test("visitor id is stable", () => {
    const store = memoryStore();
    expect(visitorId(store)).toBe(visitorId(store));
  });

  test("visitor id expires 13 months after it was made, however often the visitor comes back", () => {
    const store = memoryStore();
    const born = Date.UTC(2027, 0, 15);
    const id = visitorId(store, born);
    for (let month = 1; month <= 12; month++) expect(visitorId(store, born + month * 30 * 86_400_000)).toBe(id);
    expect(visitorId(store, born + VISITOR_LIFETIME_MS - 1)).toBe(id);
    const next = visitorId(store, born + VISITOR_LIFETIME_MS);
    expect(next).not.toBe(id);
    // The new one has its own 13 months.
    expect(visitorId(store, born + 2 * VISITOR_LIFETIME_MS - 1)).toBe(next);
    expect(visitorId(store, born + 2 * VISITOR_LIFETIME_MS)).not.toBe(next);
  });

  test("the lifetime never passes 13 calendar months, from any day", () => {
    for (let day = 0; day < 4 * 366; day++) {
      const born = Date.UTC(2026, 0, 1 + day);
      const d = new Date(born);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 14, 0)).getUTCDate();
      const limit = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 13, Math.min(d.getUTCDate(), last));
      expect(born + VISITOR_LIFETIME_MS).toBeLessThanOrEqual(limit);
    }
  });

  test("an id without a date keeps going, counted from the day the rule shipped, and isn't extended", () => {
    const store = memoryStore();
    store.setItem("mm_vid", "old-id");
    const later = VISITOR_LEGACY_ISSUED + 200 * 86_400_000;
    expect(visitorId(store, later)).toBe("old-id");
    expect(store.getItem("mm_vid_at")).toBe(String(VISITOR_LEGACY_ISSUED));
    expect(visitorId(store, VISITOR_LEGACY_ISSUED + VISITOR_LIFETIME_MS)).not.toBe("old-id");
  });

  test("a broken or future date can't keep an id alive", () => {
    for (const bad of ["soon", "0", String(Date.UTC(2099, 0, 1))]) {
      const store = memoryStore();
      store.setItem("mm_vid", "old-id");
      store.setItem("mm_vid_at", bad);
      expect(visitorId(store, VISITOR_LEGACY_ISSUED + 1)).toBe("old-id");
      expect(visitorId(store, VISITOR_LEGACY_ISSUED + VISITOR_LIFETIME_MS)).not.toBe("old-id");
    }
  });

  test("an expired id starts a new visit too", () => {
    const store = memoryStore();
    const session = touchSession(store, 1000);
    visitorId(store, 1000);
    touchSession(store, 1000 + VISITOR_LIFETIME_MS - 1);
    visitorId(store, 1000 + VISITOR_LIFETIME_MS);
    expect(touchSession(store, 1000 + VISITOR_LIFETIME_MS)).not.toBe(session);
  });

  test("clearing identity forgets the date too", () => {
    const store = memoryStore();
    visitorId(store, 1000);
    clearIdentity(store, undefined);
    expect(store.getItem("mm_vid_at")).toBeNull();
  });

  test("session persists while active and rotates after 30 idle minutes", () => {
    const store = memoryStore();
    const first = touchSession(store, 0);
    expect(touchSession(store, SESSION_IDLE_MS - 1)).toBe(first);
    // Activity at SESSION_IDLE_MS - 1 extends the session.
    expect(touchSession(store, 2 * SESSION_IDLE_MS - 2)).toBe(first);
    expect(touchSession(store, 4 * SESSION_IDLE_MS)).not.toBe(first);
  });

  test("works without storage", () => {
    expect(visitorId(undefined)).toMatch(/[0-9a-f-]{36}/);
  });
});

describe("queue", () => {
  function recording(ok = true) {
    const sent: Batch[] = [];
    const beacons: Batch[] = [];
    const transport: Transport = {
      send: async (_url, body) => (sent.push(JSON.parse(body)), ok),
      beacon: (_url, body) => (beacons.push(JSON.parse(body)), true),
    };
    return { sent, beacons, transport };
  }

  test("flushes when the batch is full", async () => {
    const { sent, transport } = recording();
    const q = new Queue({ endpoint: "x", site: "site1", maxBatch: 2, flushMs: 60_000 }, transport);
    q.push(event(1));
    q.push(event(2));
    await Bun.sleep(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ site: "site1", events: [event(1), event(2)] });
  });

  test("storage-free batches say so, for the server to derive visitor and session", async () => {
    const { sent, beacons, transport } = recording();
    const q = new Queue({ endpoint: "x", site: "site1", anonymous: true, maxBatch: 1, flushMs: 60_000 }, transport);
    q.push(event(1));
    await Bun.sleep(0);
    q.push({ ...event(2), ts: 2 });
    q.flushBeacon();
    expect(sent[0]).toEqual({ site: "site1", events: [event(1)], anonymous: true });
    expect([...sent, ...beacons].every((b) => b.anonymous === true)).toBe(true);
  });

  test("flushes after the timeout", async () => {
    const { sent, transport } = recording();
    const q = new Queue({ endpoint: "x", site: "s", flushMs: 10 }, transport);
    q.push(event(1));
    await Bun.sleep(30);
    expect(sent).toHaveLength(1);
  });

  test("beacon flush drains everything synchronously", () => {
    const { beacons, transport } = recording();
    const q = new Queue({ endpoint: "x", site: "s", flushMs: 60_000 }, transport);
    for (let i = 0; i < 5; i++) q.push(event(i));
    q.flushBeacon();
    expect(q.size).toBe(0);
    expect(beacons.flatMap((b) => b.events)).toHaveLength(5);
  });

  test("retries failed deliveries", async () => {
    let calls = 0;
    const transport: Transport = { send: async () => ++calls >= 2, beacon: () => true };
    const q = new Queue({ endpoint: "x", site: "s", maxRetries: 2 }, transport);
    q.push(event(1));
    await q.flush();
    expect(calls).toBe(2);
  });

  test("clear drops queued events (opt-out)", () => {
    const { beacons, transport } = recording();
    const q = new Queue({ endpoint: "x", site: "s", flushMs: 60_000 }, transport);
    q.push(event(1)); q.push(event(2));
    q.clear();
    q.flushBeacon();
    expect(q.size).toBe(0);
    expect(beacons).toHaveLength(0);
  });

  test("keeps undelivered events for the page-hide beacon", async () => {
    const beacons: Batch[] = [];
    const transport: Transport = { send: async () => false, beacon: (_u, b) => (beacons.push(JSON.parse(b)), true) };
    const q = new Queue({ endpoint: "x", site: "s", maxRetries: 0, flushMs: 60_000 }, transport);
    q.push(event(1));
    await q.flush();
    expect(q.size).toBe(1);
    q.push(event(2));
    q.flushBeacon();
    expect(beacons.flatMap((b) => b.events)).toEqual([event(1), event(2)]);
  });
});

describe("helpers", () => {
  test("utm params", () => {
    expect(utmParams("?utm_source=hn&utm_medium=social")).toEqual({ source: "hn", medium: "social" });
    expect(utmParams("?utm_source=google&utm_term=voiture%20occasion&utm_content=ad_b&gclid=Cj0KCQ")).toEqual({ source: "google", term: "voiture occasion", content: "ad_b", click: "google_ads" });
    expect(utmParams("?msclkid=abc")).toEqual({ click: "microsoft_ads" }); // only the network, never the ID
    expect(utmParams("?fbclid=IwAR0")).toEqual({ click: "facebook" });
    expect(utmParams("?ref=producthunt")?.source).toBe("producthunt");
    expect(utmParams("?q=1")).toBeUndefined();
  });

  test("bot detection", () => {
    expect(isLikelyBot({ userAgent: "Mozilla/5.0 HeadlessChrome/140", webdriver: false }, {})).toBe(true);
    expect(isLikelyBot({ userAgent: "Mozilla/5.0 Chrome/140", webdriver: true }, {})).toBe(true);
    expect(isLikelyBot({ userAgent: "Mozilla/5.0 (Macintosh) Chrome/140 Safari/537.36", webdriver: false }, {})).toBe(false);
  });

  test("crawlers are told apart from automation and people", () => {
    expect(isCrawler("Mozilla/5.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)")).toBe(true);
    expect(isCrawler("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isCrawler("Mozilla/5.0 HeadlessChrome/140")).toBe(false);
    expect(isCrawler("Mozilla/5.0 (Macintosh) Chrome/140 Safari/537.36")).toBe(false);
  });
});


describe("hash routing", () => {
  test("hash routes are pages; anchors and query strings aren't", () => {
    expect(hashPath("/", "#/listing/3")).toBe("/listing/3");
    expect(hashPath("/", "#!/listing/3?ref=mail")).toBe("/listing/3");
    expect(hashPath("/app/", "#/settings")).toBe("/app/settings");
    expect(hashPath("/pricing", "#faq")).toBe("/pricing");
    expect(hashPath("/pricing", "")).toBe("/pricing");
  });
});

describe("click counter", () => {
  const el = (label: string | null, opts: { ignored?: boolean; none?: boolean } = {}) => {
    const node = { tagName: "BUTTON", textContent: label ?? "", getAttribute: () => null, closest: (q: string) => (q === "[data-mm-ignore]" ? (opts.ignored ? node : null) : opts.none ? null : node) };
    return node as unknown as Element;
  };
  test("adds up clicks per label and starts over after each report", () => {
    const c = clickCounter();
    expect(c.take()).toBeNull();
    c.record(el("Contacter"));
    c.record(el("Contacter"));
    c.record(el("Favoris"));
    expect(c.take()).toEqual({ "button: Contacter": 2, "button: Favoris": 1 });
    expect(c.take()).toBeNull();
  });
  test("skips what isn't a control, ignored parts of the page, and new labels past the limit", () => {
    const c = clickCounter();
    c.record(el("Paragraph", { none: true }));
    c.record(el("Secret", { ignored: true }));
    expect(c.take()).toBeNull();
    for (let i = 0; i < 25; i++) c.record(el(`Item ${i}`));
    c.record(el("Item 0"));
    const out = c.take()!;
    expect(Object.keys(out)).toHaveLength(20);
    expect(out["button: Item 0"]).toBe(2);
  });
  test("labels mask emails and long numbers", () => {
    const c = clickCounter();
    c.record(el("me@site.com"));
    c.record(el("Call 0612345"));
    expect(Object.keys(c.take()!)).toEqual(["button: [email]", "button: Call …"]);
  });
});

describe("clicks", () => {
  test("outboundUrl keeps external http(s) links without query or hash", () => {
    expect(outboundUrl("https://github.com/x?token=1#a", "shop.example")).toBe("https://github.com/x");
    expect(outboundUrl("/annonces", "shop.example")).toBeNull();
    expect(outboundUrl("https://www.shop.example/x", "shop.example")).toBeNull();
    expect(outboundUrl("mailto:a@b.c", "shop.example")).toBeNull();
    expect(outboundUrl(null, "shop.example")).toBeNull();
  });

  test("dataProps reads sibling data attributes as camelCase", () => {
    const attrs = [
      { name: "data-track", value: "signup" },
      { name: "data-plan", value: "pro" },
      { name: "data-seat-count", value: "3" },
      { name: "class", value: "btn" },
    ];
    expect(dataProps({ attributes: attrs } as unknown as Element)).toEqual({ plan: "pro", seatCount: "3" });
  });
});

test("local hosts are recognised", () => {
  for (const h of ["localhost", "app.localhost", "127.0.0.1", "192.168.1.4", "10.0.0.2", "172.20.1.1", "mac.local"]) {
    expect(isLocalHost(h)).toBe(true);
  }
  for (const h of ["shop.example", "172.32.0.1", "8.8.8.8"]) expect(isLocalHost(h)).toBe(false);
});

describe("identify", () => {
  test("user ID is stored and cleared with the identity", async () => {
    const { setUserId, userId, clearIdentity } = await import("../src/identity");
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    expect(userId(store)).toBeUndefined();
    setUserId(store, "user_1");
    expect(userId(store)).toBe("user_1");
    clearIdentity(store, store);
    expect(userId(store)).toBeUndefined();
  });
});

describe("ttfbFrom", () => {
  test("reads navigation timing without waiting for load", () => {
    expect(ttfbFrom({ responseStart: 412.6, activationStart: 0 })).toBe(412.6);
    expect(ttfbFrom({ responseStart: 900, activationStart: 1200 })).toBe(0);
    expect(ttfbFrom({ responseStart: 0, activationStart: 0 })).toBeNull();
    expect(ttfbFrom(undefined)).toBeNull();
  });
});

describe("shared session", () => {
  test("two tabs sharing localStorage keep one session", () => {
    const shared = new Map<string, string>();
    const store = { getItem: (k: string) => shared.get(k) ?? null, setItem: (k: string, v: string) => void shared.set(k, v), removeItem: (k: string) => void shared.delete(k) };
    const tabA = touchSession(store, 1_000);
    const tabB = touchSession(store, 60_000); // a link opened in a new tab a minute later
    expect(tabB).toBe(tabA);
  });
});

describe("contact links", () => {
  test("channel only, never the number or address", async () => {
    const { contactChannel } = await import("../src/clicks");
    expect(contactChannel("tel:+212600000000")).toBe("phone");
    expect(contactChannel("https://wa.me/212600000000?text=Salam")).toBe("whatsapp");
    expect(contactChannel("https://api.whatsapp.com/send?phone=212600000000")).toBe("whatsapp");
    expect(contactChannel("mailto:seller@example.com")).toBe("email");
    expect(contactChannel("https://t.me/someone")).toBe("telegram");
    expect(contactChannel("https://shop.example/listing/x")).toBeNull();
    expect(contactChannel("https://wa.me/?text=Regarde%20cette%20annonce")).toBeNull();
    const { linkIntent } = await import("../src/clicks");
    expect(linkIntent("https://wa.me/?text=x")).toEqual({ event: "share", channel: "whatsapp" });
    expect(linkIntent("https://www.facebook.com/sharer/sharer.php?u=x")).toEqual({ event: "share", channel: "facebook" });
    expect(linkIntent("https://x.com/intent/tweet?url=x")).toEqual({ event: "share", channel: "x" });
    expect(contactChannel(null)).toBeNull();
  });
});

describe("contact buttons", () => {
  test("labels that start a conversation count, others don't", async () => {
    const { contactButton } = await import("../src/clicks");
    for (const l of ["Contacter le vendeur", "Contact seller", "  Appeler  ", "Call now", "Send message", "Envoyer un message", "Écrire au vendeur", "WhatsApp", "اتصل بالبائع", "تواصل مع البائع"]) expect(contactButton(l)).toBe(true);
    for (const l of ["Contacts", "Calling all deals", "Add to cart", "Partager", "Messages", "", "Contacter " + "x".repeat(40)]) expect(contactButton(l)).toBe(false);
  });
});

describe("site search", () => {
  test("reads the usual search parameters, normalized, never emails or phone numbers", async () => {
    const { searchTerm } = await import("../src/search");
    expect(searchTerm("?q=Golf%207%20%20Diesel&city=rabat")).toBe("golf 7 diesel");
    expect(searchTerm("?query=velo")).toBe("velo");
    expect(searchTerm("?category=rentals")).toBeNull();
    expect(searchTerm("?q=")).toBeNull();
    expect(searchTerm("?q=sam@example.com")).toBeNull();
    expect(searchTerm("?q=06%2012%2034%2056%2078")).toBeNull();
    expect(searchTerm("?q=iphone 13")).toBe("iphone 13");
    expect(searchTerm("?find=sofa", "find")).toBe("sofa");
    expect(searchTerm("?q=sofa", "off")).toBeNull();
    expect(searchTerm(`?q=${"a".repeat(300)}`)?.length).toBe(100);
  });
});


describe("scrollPercent", () => {
  test("bottom of the viewport as a share of the page, clamped", () => {
    expect(scrollPercent(0, 800, 800)).toBe(100); // short page: all of it is seen
    expect(scrollPercent(0, 800, 3200)).toBe(25);
    expect(scrollPercent(1600, 800, 3200)).toBe(75);
    expect(scrollPercent(2600, 800, 3200)).toBe(100); // overscroll on iOS
    expect(scrollPercent(0, 800, 0)).toBe(0);
  });
});

describe("rage clicks", () => {
  test("once per burst of three quick clicks on one spot", () => {
    let t = 0;
    const rage = rageDetector(() => t);
    const at = (ms: number, x = 100, y = 100) => ((t = ms), rage(x, y));
    expect([at(0), at(200), at(400)]).toEqual([false, false, true]);
    expect([at(600), at(800), at(1100), at(1300)]).toEqual([false, false, false, false]); // same burst
    expect([at(5000), at(5100), at(5200)]).toEqual([false, false, true]); // after a pause
    expect([at(9000, 0, 0), at(9100, 200, 0), at(9200, 400, 0)]).toEqual([false, false, false]); // different spots
    expect([at(20000), at(21500), at(23000)]).toEqual([false, false, false]); // too slow
  });

  test("a page that responds, or a different element, is not rage", () => {
    let t = 0;
    const rage = rageDetector(() => t);
    const at = (ms: number, key = "btn", responded = false) => ((t = ms), rage(100, 100, key, responded));
    expect([at(0), at(200, "btn", true), at(400, "btn", true)]).toEqual([false, false, false]); // stepper: the page changed each time
    expect([at(5000, "a"), at(5100, "b"), at(5200, "c")]).toEqual([false, false, false]); // three different elements
    expect([at(9000), at(9150), at(9300)]).toEqual([false, false, true]); // a dead button
  });

  test("a link opened in a new tab or window is not a dead click", () => {
    const link = { matches: (sel: string) => sel === "a[href]" } as unknown as Element;
    const button = { matches: () => false } as unknown as Element;
    const keys = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(opensOutOfPlace(link, keys)).toBe(false);
    expect(opensOutOfPlace(link, { ...keys, metaKey: true })).toBe(true); // Cmd-click on a Mac
    expect(opensOutOfPlace(link, { ...keys, ctrlKey: true })).toBe(true);
    expect(opensOutOfPlace(link, { ...keys, shiftKey: true })).toBe(true);
    expect(opensOutOfPlace(button, { ...keys, metaKey: true })).toBe(false); // a button still does nothing
  });

  test("target is a short label without long numbers, else the tag", () => {
    const el = (tag: string, attrs: Record<string, string>, text = "") => ({
      tagName: tag.toUpperCase(),
      textContent: text,
      getAttribute: (k: string) => attrs[k] ?? null,
      closest: (sel: string) => (/button|\ba\b|role=button/.test(sel) && ["button", "a"].includes(tag) ? el(tag, attrs, text) : null),
    }) as unknown as Element;
    expect(clickTarget(el("button", {}, "  Afficher le numéro "))).toBe("button: Afficher le numéro");
    expect(clickTarget(el("a", { "aria-label": "Call 0612345678" }))).toBe("a: Call …");
    expect(clickTarget(el("div", {}, "some long text that is not a control"))).toBe("div");
    expect(linkText(el("a", {}, "  Voir sur   Avito "))).toBe("Voir sur Avito");
    expect(linkText(el("a", {}, "Écrire à contact@shop.ma ou 06 12 34 56 78"))).toBe("Écrire à [email] ou …");
    expect(linkText(el("a", { "aria-label": "GitHub" }, "icon"))).toBe("GitHub");
    expect(linkText(null)).toBe("");
  });
});

describe("feedback", () => {
  test("text is trimmed, capped, and never carries emails or phone numbers", async () => {
    const { feedbackText } = await import("../src/search");
    expect(feedbackText("  The filters   are confusing ")).toBe("The filters are confusing");
    expect(feedbackText("Call me on 06 12 34 56 78 or jean.dupont@example.com please")).toBe("Call me on [phone] or [email] please");
    expect(feedbackText("   ")).toBeNull();
    expect(feedbackText("x".repeat(900))?.length).toBe(500);
  });
});

describe("delivery", () => {
  test("rate limits, timeouts and server errors are retried; other client errors are dropped", () => {
    expect([200, 202, 204].map(delivered)).toEqual([true, true, true]);
    expect([408, 425, 429, 500, 502, 503].map(delivered)).toEqual([false, false, false, false, false, false]);
    expect([400, 403, 404, 413].map(delivered)).toEqual([true, true, true, true]);
  });

  test("a batch still being retried goes out with the page-close beacon, once", async () => {
    const beacons: string[] = [];
    let sends = 0;
    const transport: Transport = {
      send: async () => (sends++, false), // endpoint down
      beacon: (_u, body) => (beacons.push(body), true),
    };
    const q = new Queue({ endpoint: "x", site: "s", maxRetries: 3, flushMs: 60_000 }, transport);
    q.push({ id: "e1", type: "pageview", ts: 1, visitor: "v", session: "s", path: "/" } as never);
    const flushing = q.flush();
    await new Promise((r) => setTimeout(r, 50)); // first attempt failed, waiting to retry
    q.flushBeacon();
    await flushing;
    expect(beacons).toHaveLength(1);
    expect(JSON.parse(beacons[0]).events.map((e: { id: string }) => e.id)).toEqual(["e1"]);
    expect(sends).toBe(1); // no more retries after the beacon took it
    expect(q.size).toBe(0);
  });

  test("an opt-out cancels batches waiting to be retried", async () => {
    let sends = 0;
    const transport: Transport = { send: async () => (sends++, false), beacon: () => true };
    const q = new Queue({ endpoint: "x", site: "s", maxRetries: 3, flushMs: 60_000 }, transport);
    q.push({ id: "e1", type: "pageview", ts: 1, visitor: "v", session: "s", path: "/" } as never);
    const flushing = q.flush();
    await new Promise((r) => setTimeout(r, 50));
    q.clear();
    await flushing;
    expect(sends).toBe(1);
    expect(q.size).toBe(0);
  });
});

describe("error noise", () => {
  test("extension errors, detail-less cross-origin errors and ResizeObserver loops are dropped", () => {
    expect(isNoiseError("TypeError: x is undefined", "at chrome-extension://abc/content.js:1:2")).toBe(true);
    expect(isNoiseError("oops", undefined, "moz-extension://abc/inject.js")).toBe(true);
    expect(isNoiseError("Script error.", undefined)).toBe(true);
    expect(isNoiseError("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
    expect(isNoiseError("ResizeObserver loop limit exceeded")).toBe(true);
    expect(isNoiseError("TypeError: Cannot read properties of undefined (reading 'price')", "at https://site.com/app.js:10:5")).toBe(false);
    expect(isNoiseError("Script error.", "at https://site.com/app.js:1:1")).toBe(false);
  });
});

test("privacy signals: GPC or Do Not Track", () => {
  expect(privacySignal({ globalPrivacyControl: true })).toBe(true);
  expect(privacySignal({ doNotTrack: "1" })).toBe(true);
  expect(privacySignal({ doNotTrack: "yes" })).toBe(true);
  expect(privacySignal({ globalPrivacyControl: false, doNotTrack: "0" })).toBe(false);
  expect(privacySignal({})).toBe(false);
});

test("search result counts come from a whole number in data-mm-results", async () => {
  const { searchResults } = await import("../src/search");
  const doc = (v: string | null) => ({ querySelector: (sel: string) => (v === null || !sel.includes("data-mm-results") ? null : { getAttribute: () => v }), querySelectorAll: () => [] }) as unknown as Document;
  expect(searchResults(doc("12"))).toBe(12);
  expect(searchResults(doc(" 0 "))).toBe(0);
  expect(searchResults(doc(null))).toBeNull();
  expect(searchResults(doc("about 12"))).toBeNull();
  expect(searchResults(doc("-3"))).toBeNull();
  expect(searchResults(doc(""))).toBeNull();
});

test("without data-mm-results, a count stated on the results page is read (count only)", async () => {
  const { searchResults } = await import("../src/search");
  const page = (...lines: string[]) => ({ querySelector: () => null, querySelectorAll: () => lines.map((textContent) => ({ textContent })) }) as unknown as Document;
  expect(searchResults(page("Annonces récentes", "41 résultats pour « iphone »"))).toBe(41);
  expect(searchResults(page("41 نتيجة عن \"iphone\""))).toBe(41);
  expect(searchResults(page("1 234 results for golf"))).toBe(1234);
  expect(searchResults(page("0 résultats pour « zqx »"))).toBe(0);
  expect(searchResults(page("Aucune annonce trouvée"))).toBe(0);
  expect(searchResults(page("No results for “golf”"))).toBe(0);
  // Not a results line: other numbers, long paragraphs, words that only start like a result word.
  expect(searchResults(page("12 annonces aujourd'hui", "Livraison en 48 heures"))).toBeNull();
  expect(searchResults(page(`${"x".repeat(130)} 3 results`))).toBeNull();
  expect(searchResults(page("3 resultsxyz"))).toBeNull();
});

test("results read from text skip hidden templates, autocomplete widgets, sidebars and per-page settings", async () => {
  const { searchResults } = await import("../src/search");
  type N = { textContent: string; hidden?: boolean };
  const node = (n: N) => ({ textContent: n.textContent, closest: () => (n.hidden ? {} : null), getClientRects: () => (n.hidden ? [] : [{}]) });
  const page = (nodes: N[], main?: N[]) => ({
    querySelector: (sel: string) => (sel.includes("main") && main ? { querySelectorAll: () => main.map(node) } : null),
    querySelectorAll: () => nodes.map(node),
  }) as unknown as Document;
  expect(searchResults(page([{ textContent: "No results found", hidden: true }, { textContent: "41 résultats" }]))).toBe(41);
  expect(searchResults(page([{ textContent: "Aucune annonce sauvegardée" }, { textContent: "12 résultats pour « golf »" }]))).toBe(12);
  expect(searchResults(page([{ textContent: "Aucune annonce trouvée" }]))).toBe(0);
  expect(searchResults(page([{ textContent: "20 résultats par page" }]))).toBeNull();
  // Inside <main> when the page has one: a header widget's count doesn't count.
  expect(searchResults(page([{ textContent: "5 results" }], [{ textContent: "3 résultats pour « x »" }]))).toBe(3);
  // The first read trusts only data-mm-results.
  expect(searchResults(page([{ textContent: "41 résultats" }]), false)).toBeNull();
});

describe("downloads and pages not found", () => {
  test("links to files are downloads: path without query, file name; other links aren't", () => {
    expect(downloadFile("/files/Tarifs 2026.pdf?token=abc", "shop.example")).toEqual({ file: "/files/Tarifs%202026.pdf", name: "Tarifs 2026.pdf" });
    expect(downloadFile("https://cdn.example.com/app.apk#x", "shop.example")).toEqual({ file: "https://cdn.example.com/app.apk", name: "app.apk" });
    expect(downloadFile("/pricing", "shop.example")).toBeNull();
    expect(downloadFile("mailto:a@b.co", "shop.example")).toBeNull();
  });
  test("the page's HTTP status comes from Navigation Timing when the browser has it", () => {
    expect(navigationStatus([{ responseStatus: 404 }])).toBe(404);
    expect(navigationStatus([{}])).toBe(0);
    expect(navigationStatus([])).toBe(0);
  });
});

describe("a long read stays in its visit", () => {
  test("currentSession keeps the session however long ago it was active, and doesn't count as activity", () => {
    const store = memoryStore();
    const id = touchSession(store, 1_000);
    const seen = store.getItem("mm_seen");
    expect(currentSession(store)).toBe(id);
    expect(store.getItem("mm_seen")).toBe(seen);
    expect(touchSession(store, 1_000 + SESSION_IDLE_MS + 1)).not.toBe(id);
  });
});

describe("isTypedField", () => {
  const field = (tagName: string, type?: string) => ({ tagName, getAttribute: () => type ?? null }) as unknown as Element;
  test("typing starts a form; a menu, a tick or a quantity doesn't", () => {
    expect(isTypedField(field("INPUT", "email"))).toBe(true);
    expect(isTypedField(field("INPUT"))).toBe(true);
    expect(isTypedField(field("TEXTAREA"))).toBe(true);
    expect(isTypedField(field("SELECT"))).toBe(false);
    expect(isTypedField(field("INPUT", "checkbox"))).toBe(false);
    expect(isTypedField(field("INPUT", "number"))).toBe(false);
  });
});

describe("saleOf", () => {
  test("keeps a real sale, normalized", () => {
    expect(saleOf({ amount: 49.5, currency: "eur", order_id: 1001 })).toEqual({ revenue: { amount: 49.5, currency: "EUR", order_id: "1001" } });
    expect(saleOf({ amount: 10, currency: "USD" })).toEqual({ revenue: { amount: 10, currency: "USD" } });
  });
  test("drops what isn't one", () => {
    expect(saleOf(undefined)).toEqual({});
    expect(saleOf({ amount: 0, currency: "EUR" })).toEqual({});
    expect(saleOf({ amount: Number.NaN, currency: "EUR" })).toEqual({});
    expect(saleOf({ amount: 5, currency: "euro" })).toEqual({});
  });
});
