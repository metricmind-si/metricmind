// What the SDK measures and reports by itself: JS start, screen load, JS frames, stalls, uncaught errors.
import { describe, expect, mock, test } from "bun:test";

const rn = { Platform: { OS: "android", Version: 34, constants: { Release: "14" } }, Dimensions: { get: () => ({ width: 393, height: 852 }) }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) }, Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) } };
mock.module("react-native", () => rn);
const { Tracker, jsStartElapsed, watchErrors } = await import("../src/metricmind");
type Runtime = import("../src/metricmind").Runtime;

function harness() {
  const sent: { site: string; app: Record<string, string>; events: Record<string, unknown>[] }[] = [];
  let now = 1_760_000_000_000;
  const m = new Map<string, string>();
  const storage = { m, getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => void m.set(k, v), removeItem: async (k: string) => void m.delete(k) };
  const fetch = (async (_url: string, init?: { body?: string }) => {
    if (init?.body) sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  }) as unknown as import("../src/metricmind").FetchLike;
  // A device: a monotonic clock that started at boot, frames on request, and a bundle that began 900 ms ago.
  let mono = 50_000;
  const queued: (() => void)[] = [];
  const runtime: Runtime = { performance: { now: () => mono }, requestAnimationFrame: (cb) => queued.push(cb), __BUNDLE_START_TIME__: now - 900 };
  const make = (opts: { performance?: boolean; appVersion?: string } = {}, rt: Runtime = runtime) => new Tracker({ site: "site_123", appVersion: "2.4.1", build: "41", storage, ...opts }, { fetch, now: () => now, storage, runtime: rt });
  const advance = (ms: number) => {
    now += ms;
    mono += ms;
  };
  /** The next display refresh, ms later. */
  const frame = (ms = 16) => {
    advance(ms);
    for (const cb of queued.splice(0)) cb();
  };
  return { sent, storage, make, frame, queued, advance, events: () => sent.flatMap((b) => b.events) };
}
const message = (e: Record<string, unknown>) => (e.error as { message: string }).message;

describe("performance on the JS thread", () => {
  test("JS start and screen load end at the first frame after the first screen", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("Home");
    h.frame(40);
    h.advance(3000);
    t.trackScreen("Listing");
    h.frame(120);
    await t.flush();
    const vitals = h.events().filter((e) => e.type === "vital");
    expect(vitals.map((e) => [e.name, e.value, e.path])).toEqual([["SCREEN_LOAD", 40, "/Home"], ["APP_JS_START", 940, "/Home"], ["SCREEN_LOAD", 120, "/Listing"]]);
    expect(vitals[0].props).toEqual({ js: true, nav: false });
    // Never the native vital: APP_START means process launch to first frame, and marks a release as native.
    expect(h.events().some((e) => e.name === "APP_START")).toBe(false);
  });

  test("the bundle's start in either clock; nothing when the runtime doesn't say or the numbers disagree", () => {
    expect(jsStartElapsed({ __BUNDLE_START_TIME__: 1_760_000_000_000 }, 5000, 1_760_000_001_200)).toBe(1200);
    expect(jsStartElapsed({ __BUNDLE_START_TIME__: 4000 }, 5000, 1_760_000_001_200)).toBe(1000);
    expect(jsStartElapsed({ __BUNDLE_START_TIME__: 4000, nativePerformanceNow: () => 4800 }, 999_999, 0)).toBe(800);
    expect(jsStartElapsed({ performance: { rnStartupTiming: { startTime: 4100, endTime: 4700 } } }, 5000, 0)).toBe(900);
    expect(jsStartElapsed({ performance: { rnStartupTiming: { startTime: 4100, endTime: 9000 } } }, 5000, 0)).toBeNull(); // another clock
    expect(jsStartElapsed({ performance: { rnStartupTiming: { startTime: null } } }, 5000, 0)).toBeNull();
    expect(jsStartElapsed({}, 5000, 0)).toBeNull();
    expect(jsStartElapsed({ __BUNDLE_START_TIME__: 4000 }, 5000 + 61_000, 0)).toBeNull(); // started in the background long before
    const broken = { get performance(): never { throw new Error("no native module"); } };
    expect(jsStartElapsed(broken, 5000, 0)).toBeNull();
  });

  test("a screen's load counts from the navigation that led to it", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("Home");
    h.frame();
    t.navigationStart();
    h.advance(180); // rendering the screen
    t.trackScreen("Listing");
    h.frame(20);
    t.navigationStart(); // a tab pressed again: no screen follows
    h.advance(20_000);
    t.trackScreen("Search");
    h.frame(30);
    await t.flush();
    const loads = h.events().filter((e) => e.name === "SCREEN_LOAD");
    expect(loads.map((e) => [e.path, e.value, (e.props as { nav: boolean }).nav])).toEqual([["/Home", 16, false], ["/Listing", 200, true], ["/Search", 30, false]]);
  });

  test("frames are counted for 10 s per screen and sent with its exit, marked as JS frames", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("Home");
    h.frame(); // first frame: nothing to compare with yet
    for (let i = 0; i < 10; i++) h.frame(16);
    h.frame(40); // slow
    h.frame(900); // frozen (and slow)
    h.frame(16);
    for (let i = 0; i < 5; i++) h.frame(2000); // the window closes: the loop stops
    expect(h.queued).toHaveLength(0);
    t.trackScreen("Listing");
    t.trackScreen("Search"); // left before a second frame: nothing counted
    await t.flush();
    const exits = h.events().filter((e) => e.type === "exit");
    expect(exits.map((e) => [e.path, e.props ?? null])).toEqual([["/Home", { frames: 18, slow: 7, frozen: 6, js: true }], ["/Listing", null]]);
  });

  test("leaving the app stops the frames, drops the pending load and never yields a start time", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("Home");
    t.background(); // a system dialog at launch, before the first frame
    h.frame(30_000);
    t.foreground();
    h.frame();
    h.frame();
    t.background();
    await t.flush();
    expect(h.events().filter((e) => e.type === "vital")).toEqual([]);
    // The half minute away isn't a frozen frame.
    expect(h.events().filter((e) => e.type === "exit").map((e) => e.props ?? null)).toEqual([null, { frames: 1, slow: 0, frozen: 0, js: true }]);
  });

  test("performance: false, or a runtime without the APIs, measures nothing and breaks nothing", async () => {
    const h = harness();
    const off = h.make({ performance: false });
    off.trackScreen("Home");
    h.frame();
    off.beat();
    off.trackScreen("Listing");
    const bare = h.make({}, {});
    bare.trackScreen("Home");
    bare.navigationStart();
    bare.beat();
    bare.trackScreen("Listing");
    const throwing = h.make({}, { performance: { now: () => 1 }, requestAnimationFrame: () => { throw new Error("no frames"); } });
    throwing.trackScreen("Home");
    await Promise.all([off.flush(), bare.flush(), throwing.flush()]);
    expect(h.events().some((e) => e.type === "vital" || (e.type === "exit" && e.props))).toBe(false);
  });

  test("a JS thread blocked for 2 s or more is a hang, marked js; time away from the app is not", async () => {
    const h = harness();
    const t = h.make();
    t.trackScreen("Search");
    t.beat();
    h.advance(500);
    t.beat(); // on time
    h.advance(1500);
    t.beat(); // 1 s late: not a stall
    h.advance(3100);
    t.beat(); // 2.6 s late
    await Bun.sleep(600);
    h.advance(3100);
    t.beat(); // late again...
    t.background(); // ...but the app was suspended: the lifecycle event arrived right after
    h.advance(40_000);
    t.foreground();
    t.beat(); // the first check back starts over
    h.advance(90_000);
    t.beat(); // longer than any stall: a frozen process
    await Bun.sleep(600);
    await t.flush();
    const errors = h.events().filter((e) => e.type === "error");
    expect(errors.map((e) => [e.path, message(e), e.props])).toEqual([["/Search", "JavaScript thread blocked for 2 s or more", { fatal: false, kind: "hang", js: true, duration_ms: 2600 }]]);
  });
});

describe("automatic error reporting", () => {
  const errorUtils = () => {
    const calls: string[] = [];
    let handler = (_e: unknown, fatal?: boolean) => void calls.push(`native:${fatal}`);
    return { calls, utils: { getGlobalHandler: () => handler, setGlobalHandler: (h: typeof handler) => void (handler = h) }, raise: (e: unknown, fatal?: boolean) => handler(e, fatal) };
  };

  test("uncaught errors reach us and the handler before us; a crash is saved before the app is allowed to close", async () => {
    const h = harness();
    const t = h.make();
    await t.loaded;
    const eu = errorUtils();
    watchErrors(t, { ErrorUtils: eu.utils });
    eu.raise(new TypeError("undefined is not a function"), false);
    expect(eu.calls).toEqual(["native:false"]); // non-fatal: passed on at once
    eu.raise(new Error("boom"), true);
    expect(eu.calls).toEqual(["native:false"]); // fatal: the report is saved first
    await Bun.sleep(5);
    expect(eu.calls).toEqual(["native:false", "native:true"]);
    await t.flush();
    expect(h.events().map((e) => [message(e), e.props])).toEqual([["TypeError: undefined is not a function", { fatal: false }], ["Error: boom", { fatal: true }]]);
  });

  test("a library that replaces the handler later, chaining or not, still leaves one report per error", async () => {
    const h = harness();
    const t = h.make();
    await t.loaded;
    const eu = errorUtils();
    watchErrors(t, { ErrorUtils: eu.utils });
    // A crash reporter that calls the handler it found (ours)...
    const ours = eu.utils.getGlobalHandler();
    eu.utils.setGlobalHandler((e, fatal) => {
      eu.calls.push("reporter");
      ours(e, fatal);
    });
    eu.raise(new Error("one"), false);
    // ...and one that doesn't call anything.
    eu.utils.setGlobalHandler(() => void eu.calls.push("selfish"));
    eu.raise(new Error("two"), false);
    eu.raise("a string", false);
    await t.flush();
    expect(eu.calls).toEqual(["reporter", "native:false", "selfish", "selfish"]);
    expect(h.events().map(message)).toEqual(["Error: one", "Error: two", "Error: a string"]);
  });

  test("a broken ErrorUtils, or none at all, never throws into the app", () => {
    const t = harness().make();
    expect(() => watchErrors(t, {})).not.toThrow();
    const broken = { getGlobalHandler: (): never => { throw new Error("x"); }, setGlobalHandler: () => {} };
    expect(() => watchErrors(t, { ErrorUtils: broken })).not.toThrow();
  });

  test("unhandled promise rejections are non-fatal errors in release builds; objects are never serialised", async () => {
    const h = harness();
    const t = h.make();
    type Options = { allRejections: boolean; onUnhandled: (id: number, reason: unknown) => void };
    const installed: Options[] = [];
    const hermes = { enablePromiseRejectionTracker: (o: Options) => void installed.push(o) };
    watchErrors(t, { HermesInternal: hermes, __DEV__: true });
    expect(installed).toHaveLength(0); // development: React Native's own tracker shows them
    watchErrors(t, { HermesInternal: hermes });
    const [tracker] = installed;
    expect(tracker.allRejections).toBe(true);
    const failed = new TypeError("Network request failed");
    tracker.onUnhandled(1, failed);
    tracker.onUnhandled(2, failed); // the same error rejecting two promises
    tracker.onUnhandled(3, { email: "jean@example.com", code: 403 });
    tracker.onUnhandled(4, "timeout");
    tracker.onUnhandled(5, undefined);
    await t.flush();
    const errors = h.events();
    expect(errors.map(message)).toEqual(["TypeError: Network request failed", "Non-error value thrown", "Error: timeout", "Error: undefined"]);
    expect(errors.every((e) => e.type === "error" && JSON.stringify(e.props) === JSON.stringify({ fatal: false, promise: true }))).toBe(true);
    expect(JSON.stringify(errors)).not.toContain("jean@");
  });

  test("older React logs a render error and then throws it at the global handler: one report, the crash", async () => {
    const h = harness();
    const t = h.make();
    await t.loaded;
    const eu = errorUtils();
    const console = { error: () => {} };
    watchErrors(t, { console, ErrorUtils: eu.utils });
    const error = Object.assign(new Error("render failed"), { isComponentError: true });
    (console.error as (e: unknown) => void)(error);
    eu.raise(error, true);
    eu.raise(undefined, false); // nothing pending: an undefined error isn't "the same one"
    await Bun.sleep(5);
    await t.flush();
    expect(h.events().map((e) => [message(e), e.props])).toEqual([["Error: render failed", { fatal: true }], ["Error: undefined", { fatal: false }]]);
    expect(h.storage.m.has("mm_crash")).toBe(false);
  });

  test("a render error the app survives is an error; one it doesn't is the next launch's crash report", async () => {
    const h = harness();
    const t = h.make();
    await t.loaded;
    t.trackScreen("Listing");
    const logged: unknown[] = [];
    const console = { error: (...args: unknown[]) => void logged.push(args[0]) };
    watchErrors(t, { console });
    console.error("Warning: something harmless");
    console.error(new Error("logged by the app")); // not React Native's render path
    const caught = Object.assign(new Error("Cannot read property 'price' of undefined"), { isComponentError: true, componentStack: "\n    in ListingCard" });
    console.error(caught);
    console.error(caught);
    expect(logged).toHaveLength(4); // logging goes on as before
    expect(h.storage.m.has("mm_crash")).toBe(true);
    t.background(); // still running: an error boundary caught it
    await t.flush();
    expect(h.storage.m.has("mm_crash")).toBe(false);
    const errors = h.events().filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ path: "/Listing", props: { fatal: false, render: true }, error: { message: "Error: Cannot read property 'price' of undefined" } });
    expect((errors[0].error as { stack: string }).stack).toContain("Component stack:\n    in ListingCard");

    // No boundary: React Native closes the app right after logging it.
    t.foreground();
    const session = t.ids().session;
    console.error(Object.assign(new Error("Text strings must be rendered within a <Text> component"), { isComponentError: true }));
    await Bun.sleep(1);
    const relaunched = h.make({ appVersion: "2.4.2" });
    await relaunched.flush();
    const batch = h.sent.at(-1);
    expect(batch?.app.version).toBe("2.4.1"); // the release that crashed
    expect(batch?.events).toHaveLength(1);
    expect(batch?.events[0]).toMatchObject({ type: "error", path: "/Listing", session, props: { fatal: true, render: true } });
    expect(h.storage.m.has("mm_crash")).toBe(false);
    t.optOut(); // ends the first run's timer
  });
});
