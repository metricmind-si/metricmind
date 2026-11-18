import { beforeEach, describe, expect, mock, test } from "bun:test";

// The SDK only touches Platform, Dimensions, AppState and Linking from react-native.
const rn = { Platform: { OS: "android", Version: 34, constants: { Release: "14" } } as Record<string, unknown>, Dimensions: { get: () => ({ width: 393, height: 852 }) }, AppState: { addEventListener: () => ({ remove() {} }) }, Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) } };
mock.module("react-native", () => rn);
const { Tracker, VISITOR_LEGACY_ISSUED, VISITOR_LIFETIME_MS, appContext, campaignFrom, feedbackText, screenPath, searchTermFor, uuid } = await import("../src/metricmind");

function memory() {
  const m = new Map<string, string>();
  return { m, getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => void m.set(k, v), removeItem: async (k: string) => void m.delete(k) };
}

function harness(status = 202) {
  const sent: { site: string; app: Record<string, string>; events: Record<string, unknown>[] }[] = [];
  let now = 1_760_000_000_000;
  const storage = memory();
  const fetch = (async (_url: string, init?: { body?: string }) => {
    if (init?.body) sent.push(JSON.parse(init.body));
    return new Response(status === 202 ? JSON.stringify({ accepted: 1 }) : "", { status });
  }) as unknown as import("../src/metricmind").FetchLike;
  const make = () => new Tracker({ site: "site_123", appVersion: "2.4.1", build: "41", storage }, { fetch, now: () => now, storage, campaignWaitMs: 10 });
  return { sent, storage, fetch, make, advance: (ms: number) => (now += ms), setStatus: (s: number) => (status = s) };
}

const setPlatform = (p: Record<string, unknown>) => {
  for (const k of Object.keys(rn.Platform)) delete rn.Platform[k];
  Object.assign(rn.Platform, p);
};
beforeEach(() => setPlatform({ OS: "android", Version: 34, constants: { Release: "14" } }));

describe("helpers", () => {
  test("uuid is RFC 4122 v4", () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  test("screen names become paths", () => {
    expect(screenPath("Checkout")).toBe("/Checkout");
    expect(screenPath("Order details")).toBe("/Order-details");
    expect(screenPath("/Home/Feed")).toBe("/Home/Feed");
  });
  test("search never sends emails or phone numbers", () => {
    expect(searchTermFor("  Golf 7 ")).toBe("golf 7");
    expect(searchTermFor("jean@example.com")).toBeNull();
    expect(searchTermFor("06 12 34 56 78")).toBeNull();
  });
  test("app context: Android release, phone vs tablet, iOS", () => {
    expect(appContext({ appVersion: "2.4.1", build: "41" })).toEqual({ platform: "android", version: "2.4.1", build: "41", os_version: "14", device: "phone" });
    setPlatform({ OS: "ios", Version: "18.1", isPad: true });
    expect(appContext({ appVersion: "3.0" })).toEqual({ platform: "ios", version: "3.0", os_version: "18.1", device: "tablet" });
  });
});

describe("lifecycle", () => {
  test("a resume while still counting keeps the time", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("Home");
    h.advance(6000);
    t.foreground();
    h.advance(1000);
    t.background();
    await t.flush();
    expect(h.sent.flatMap((b) => b.events).filter((e) => e.type === "exit").map((e) => e.value)).toEqual([7000]);
  });

  test("inactive then background ends the screen once", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("Home");
    h.advance(5000);
    t.background();
    t.background();
    await t.flush();
    expect(h.sent.flatMap((b) => b.events).filter((e) => e.type === "exit").map((e) => e.value)).toEqual([5000]);
  });
});

describe("sessions", () => {
  test("a short trip to the background continues; 30 s or more starts a new session with the screen as entry", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("Home");
    h.advance(2000);
    t.background();
    h.advance(10_000);
    t.foreground();
    h.advance(2000);
    t.background();
    h.advance(45_000);
    t.foreground();
    t.track("after_return");
    await t.flush();
    const events = h.sent.flatMap((b) => b.events);
    expect(events.map((e) => [e.type, e.path])).toEqual([["pageview", "/Home"], ["exit", "/Home"], ["exit", "/Home"], ["pageview", "/Home"], ["event", "/Home"]]);
    expect(events[2].session).toBe(events[0].session);
    expect(events[3].session).not.toBe(events[0].session);
    expect(events[4].session).toBe(events[3].session);
  });
});

describe("sessions after a relaunch", () => {
  test("within 30 s continues, later starts a new session", async () => {
    const h = harness();
    const first = h.make();
    first.trackScreen("Home");
    first.background();
    await first.flush();
    h.advance(5000);
    const quick = h.make();
    quick.trackScreen("Home");
    await quick.flush();
    h.advance(60_000);
    const later = h.make();
    later.foreground(); // AppState "active" can arrive before the first screen
    later.trackScreen("Home");
    await later.flush();
    const views = h.sent.flatMap((b) => b.events).filter((e) => e.type === "pageview").map((e) => e.session);
    expect(views[1]).toBe(views[0]);
    expect(views[2]).not.toBe(views[0]);
  });
});

describe("feedback", () => {
  test("messages lose emails and phone numbers; ratings outside 1–5 are dropped", async () => {
    expect(feedbackText("Call me on 06 12 34 56 78 or jean.dupont@example.com  please")).toBe("Call me on [phone] or [email] please");
    expect(feedbackText("  ")).toBeNull();
    const h = harness();
    const t = h.make();
    t.trackScreen("Sell");
    t.feedback("Publishing keeps failing", 2);
    t.feedback("Out of range", 9);
    await t.flush();
    const fb = h.sent.flatMap((b) => b.events).filter((e) => e.name === "$feedback");
    expect(fb.map((e) => e.props)).toEqual([{ message: "Publishing keeps failing", rating: 2 }, { message: "Out of range" }]);
    expect(fb[0].path).toBe("/Sell");
  });
});

describe("screen timings", () => {
  test("screenReady records time to full display once per screen view", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("Listing");
    h.advance(1200);
    t.screenReady();
    t.screenReady();
    await t.flush();
    const vitals = h.sent.flatMap((b) => b.events).filter((e) => e.type === "vital");
    expect(vitals.map((e) => [e.name, e.value, e.path])).toEqual([["SCREEN_READY", 1200, "/Listing"]]);
  });
});

describe("consent", () => {
  test("enabled: false stores and sends nothing until optIn, which is remembered", async () => {
    const h = harness();
    const waiting = () => new Tracker({ site: "site_123", appVersion: "2.4.1", storage: h.storage, enabled: false }, { fetch: h.fetch, now: () => 1_760_000_000_000, storage: h.storage });
    const t = waiting();
    t.trackScreen("Home");
    t.track("before_consent");
    await t.flush();
    expect(h.sent).toEqual([]);
    expect(t.isEnabled).toBe(false);
    expect(h.storage.m.size).toBe(0); // no install ID before consent
    await t.optIn();
    t.track("after_consent");
    await t.flush();
    expect(h.sent.flatMap((b) => b.events).map((e) => e.name)).toEqual(["after_consent"]);
    const relaunched = waiting();
    await relaunched.flush();
    expect(relaunched.isEnabled).toBe(true);
    relaunched.optOut();
    const again = waiting();
    await again.flush();
    expect(again.isEnabled).toBe(false);
    expect(h.storage.m.has("mm_visitor")).toBe(false); // opting out deletes the ID, and relaunch doesn't recreate it
  });
});

describe("releases", () => {
  test("events queued before an app update are sent with the release that recorded them", async () => {
    const h = harness(503);
    const old = h.make();
    old.captureError(new Error("crash"), { fatal: true });
    await old.flush(); // offline: stays on the device
    h.setStatus(202);
    const updated = new Tracker({ site: "site_123", appVersion: "2.4.2", build: "42", storage: h.storage }, { fetch: h.fetch, now: () => 1_760_000_000_000, storage: h.storage });
    updated.trackScreen("Home");
    await updated.flush();
    const delivered = h.sent.slice(1); // the first attempt was the offline one
    expect(delivered.map((b) => b.app.version)).toEqual(["2.4.1", "2.4.2"]);
    expect(delivered[0].events.map((e) => e.type)).toEqual(["error"]);
    expect(h.sent.flatMap((b) => b.events).every((e) => !("_app" in e))).toBe(true);
  });
});

describe("campaigns", () => {
  test("utm parameters from deep links, universal links and ref=", () => {
    expect(campaignFrom("myapp://listing/42?utm_source=newsletter&utm_medium=email&utm_campaign=Spring%20sale#top")).toEqual({ source: "newsletter", medium: "email", campaign: "Spring sale" });
    expect(campaignFrom("https://example.com/app?ref=producthunt")).toEqual({ source: "producthunt" });
    expect(campaignFrom("myapp://home?id=4")).toBeNull();
    expect(campaignFrom("myapp://home")).toBeNull();
    expect(campaignFrom("myapp://x?utm_source=%E0%A4%A&utm_medium=cpc")).toEqual({ medium: "cpc" });
  });

  test("a campaign link credits the screen it opens, in a new session", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("Home");
    h.advance(3000);
    t.openURL("myapp://home?id=1"); // no campaign: nothing happens
    t.openURL("myapp://listing/42?utm_source=instagram&utm_campaign=launch");
    t.trackScreen("Listing"); // the navigator opens the link's screen
    await Bun.sleep(30);
    await t.flush();
    const events = h.sent.flatMap((b) => b.events);
    expect(events.map((e) => [e.type, e.path])).toEqual([["pageview", "/Home"], ["exit", "/Home"], ["pageview", "/Listing"]]);
    expect(events[2].utm).toEqual({ source: "instagram", campaign: "launch" });
    expect(events[1].session).toBe(events[0].session);
    expect(events[2].session).not.toBe(events[0].session);
  });

  test("a campaign link to the screen already shown counts it again", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("Home");
    t.openURL("myapp://home?utm_source=qr");
    await Bun.sleep(30);
    await t.flush();
    const events = h.sent.flatMap((b) => b.events);
    expect(events.map((e) => [e.type, e.path])).toEqual([["pageview", "/Home"], ["exit", "/Home"], ["pageview", "/Home"]]);
    expect(events[2].utm).toEqual({ source: "qr" });
  });

  test("a cold start link credits the first screen", async () => {
    const h = harness();
    const t = h.make();
    t.openURL("myapp://x?utm_source=qr&utm_medium=print");
    t.trackScreen("Home");
    await t.flush();
    expect(h.sent[0].events[0].utm).toEqual({ source: "qr", medium: "print" });
  });
});

describe("tracker", () => {
  test("screens, engaged time, events and one batch with app context", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("Home");
    h.advance(4000);
    t.trackScreen("Checkout");
    t.track("purchase", { plan: "pro" });
    t.contact("WhatsApp");
    t.search("velo electrique");
    await t.flush();
    expect(h.sent).toHaveLength(1);
    const b = h.sent[0];
    expect(b.site).toBe("site_123");
    expect(b.app).toEqual({ platform: "android", version: "2.4.1", build: "41", os_version: "14", device: "phone" });
    expect(b.events.map((e) => [e.type, e.path, e.name ?? null])).toEqual([
      ["pageview", "/Home", null], ["exit", "/Home", null], ["pageview", "/Checkout", null],
      ["event", "/Checkout", "purchase"], ["event", "/Checkout", "contact"], ["event", "/Checkout", "search"],
    ]);
    expect(b.events[1].value).toBe(4000);
    expect(b.events[4].props).toEqual({ channel: "whatsapp" });
    expect(b.events[5].props).toEqual({ term: "velo electrique" });
    expect(new Set(b.events.map((e) => e.session)).size).toBe(1);
    expect(b.events[0].viewport).toBe("393x852");
  });

  test("contacts and searches carry context: category, number of results", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("listing/[id]");
    t.contact("Phone", { category: "cars", channel: "spoofed" });
    t.search("Golf 7", { results: 0, category: "cars" });
    t.search("velo", { results: -1 });
    await t.flush();
    const [contact, search, bad] = h.sent[0].events.filter((e) => e.type === "event");
    expect(contact.props).toEqual({ category: "cars", channel: "phone" });
    expect(search.props).toEqual({ category: "cars", term: "golf 7", results: 0 });
    expect(bad.props).toEqual({ term: "velo" });
  });

  test("a new session after 30 idle minutes; background ends the screen's engaged time", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("Home");
    h.advance(10_000);
    t.background();
    h.advance(31 * 60_000);
    t.foreground();
    t.trackScreen("Search");
    await t.flush();
    const events = h.sent.flatMap((b) => b.events);
    expect(events.find((e) => e.type === "exit")?.value).toBe(10_000);
    const sessions = [...new Set(events.filter((e) => e.type === "pageview").map((e) => e.session))];
    expect(sessions).toHaveLength(2);
  });

  test("failed sends stay queued and on disk for the next launch", async () => {
    const h = harness(503);
    const t = h.make();
    t.track("signup");
    await t.flush();
    expect(JSON.parse(h.storage.m.get("mm_queue")!)).toHaveLength(1);
    h.setStatus(202);
    const next = h.make(); // app relaunched
    await next.flush();
    expect(h.sent.at(-1)!.events.map((e) => e.name)).toEqual(["signup"]);
    expect(JSON.parse(h.storage.m.get("mm_queue")!)).toHaveLength(0);
  });

  test("the install ID expires 13 months after it was made, however often the app is used", async () => {
    const h = harness();
    const a = h.make();
    await a.loaded;
    const visitor = a.ids().visitor;
    expect(h.storage.m.get("mm_visitor_at")).toBeDefined();
    h.advance(VISITOR_LIFETIME_MS - 1000);
    const b = h.make();
    await b.loaded;
    b.track("still");
    expect(b.ids().visitor).toBe(visitor); // use didn't extend it...
    h.advance(1000);
    b.track("later"); // ...and a run that stays open past the limit changes too
    await b.flush();
    const [still, later] = h.sent.flatMap((x) => x.events);
    expect(still.visitor).toBe(visitor);
    expect(later.visitor).not.toBe(visitor);
    expect(later.session).not.toBe(still.session);
    expect(h.storage.m.get("mm_visitor")).toBe(later.visitor as string);
  });
  test("an install ID without a date keeps going, counted from the day the rule shipped", async () => {
    const h = harness();
    h.storage.m.set("mm_visitor", "old-id");
    const a = h.make();
    await a.loaded;
    expect(a.ids().visitor).toBe("old-id");
    expect(h.storage.m.get("mm_visitor_at")).toBe(String(VISITOR_LEGACY_ISSUED));
    h.advance(VISITOR_LEGACY_ISSUED + VISITOR_LIFETIME_MS - 1_760_000_000_000);
    const b = h.make();
    await b.loaded;
    expect(b.ids().visitor).not.toBe("old-id");
  });
  test("the install ID survives relaunches; identify links the user; reset forgets", async () => {
    const h = harness();
    const a = h.make();
    await a.loaded;
    const visitor = a.ids().visitor;
    a.identify("user_42", { plan: "pro" });
    await a.flush();
    const b = h.make();
    await b.loaded;
    expect(b.ids()).toMatchObject({ visitor, user: "user_42" });
    b.reset();
    expect(b.ids().visitor).not.toBe(visitor);
    expect(b.ids().user).toBeUndefined();
    expect(h.sent.flatMap((x) => x.events).find((e) => e.name === "$identify")).toMatchObject({ user: "user_42", props: { plan: "pro" } });
  });

  test("crashes are fatal errors; opt-out stops everything and deletes the IDs", async () => {
    const h = harness();
    const t = h.make();
    t.captureError(new TypeError("undefined is not an object"), { fatal: true });
    await t.flush();
    expect(h.sent[0].events[0]).toMatchObject({ type: "error", props: { fatal: true }, error: { message: "TypeError: undefined is not an object" } });
    t.optOut();
    t.track("after");
    await t.flush();
    expect(h.sent).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.storage.m.get("mm_optout")).toBe("1");
    expect(h.storage.m.has("mm_visitor")).toBe(false);
  });

  test("feature flags: evaluated by the server, exposure recorded once", async () => {
    const urls: string[] = [];
    const storage = memory();
    const sent: { events: Record<string, unknown>[] }[] = [];
    const fetch = (async (url: string, init?: { body?: string }) => {
      if (init?.body) { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 202 }); }
      urls.push(url);
      return new Response(JSON.stringify({ flags: { "new-checkout": { enabled: true, variant: "on" } } }), { status: 200 });
    }) as unknown as import("../src/metricmind").FetchLike;
    const t = new Tracker({ site: "site_123", appVersion: "1.0", storage }, { fetch, now: () => Date.now(), storage });
    expect(await t.flag("new-checkout")).toEqual({ enabled: true, variant: "on" });
    expect(await t.flag("new-checkout")).toEqual({ enabled: true, variant: "on" });
    expect(await t.flag("unknown")).toEqual({ enabled: false, variant: "off" });
    await t.flush();
    expect(urls[0]).toContain("/v1/flags?site=site_123");
    expect(urls[0]).toContain("platform=android");
    expect(sent.flatMap((b) => b.events).filter((e) => e.name === "$flag")).toHaveLength(1);
  });

  test("feature flags: the environment is sent only when set", async () => {
    const urlFor = async (environment?: string) => {
      const urls: string[] = [];
      const storage = memory();
      const fetch = (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ flags: {} }), { status: 200 });
      }) as unknown as import("../src/metricmind").FetchLike;
      const t = new Tracker({ site: "site_123", appVersion: "1.0", storage, environment }, { fetch, now: () => Date.now(), storage });
      await t.flag("new-checkout");
      return urls[0];
    };
    expect(await urlFor()).not.toContain("env=");
    expect(await urlFor("")).not.toContain("env=");
    expect(await urlFor("staging")).toContain("env=staging");
  });
});
