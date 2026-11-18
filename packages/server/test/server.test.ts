import { expect, test } from "bun:test";
import { createTracker } from "../src/server";

function fakeFetch(statuses: number[]) {
  const calls: { headers: Record<string, string>; body: { site: string; events: { name: string }[] } }[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response("", { status: statuses.shift() ?? 202 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("batches events and authenticates with the server key", async () => {
  const { fn, calls } = fakeFetch([]);
  const mm = createTracker({ site: "s_1", key: "mmsk_abc", fetch: fn });
  mm.track("signup_completed", { visitor: "v1", props: { plan: "pro" } });
  mm.track("invoice_paid", { user: "u_1" });
  await mm.flush();
  expect(calls).toHaveLength(1);
  expect(calls[0].headers["x-mm-key"]).toBe("mmsk_abc");
  expect(calls[0].body.site).toBe("s_1");
  expect(calls[0].body.events.map((e) => e.name)).toEqual(["signup_completed", "invoice_paid"]);
});

test("uses Bearer for API keys and splits large batches", async () => {
  const { fn, calls } = fakeFetch([]);
  const mm = createTracker({ site: "s_1", key: "mmk_xyz", fetch: fn });
  for (let i = 0; i < 150; i++) mm.track("job_done", { user: "u" });
  await mm.flush();
  expect(calls[0].headers.authorization).toBe("Bearer mmk_xyz");
  expect(calls.map((c) => c.body.events.length)).toEqual([100, 50]);
});

test("retries 429/5xx, gives up on 4xx and reports", async () => {
  const errors: string[] = [];
  const { fn, calls } = fakeFetch([503, 429, 202, 400]);
  const mm = createTracker({ site: "s_1", key: "k", fetch: fn, onError: (e) => void errors.push(e.message) });
  mm.track("a", { user: "u" });
  await mm.flush();
  expect(calls).toHaveLength(3);
  mm.track("b", { user: "u" });
  await mm.flush();
  expect(calls).toHaveLength(4);
  expect(errors).toEqual(["MetricMind refused 1 event(s): 400"]);
}, 10_000);

test("refuses events without a visitor or user", () => {
  const errors: string[] = [];
  const mm = createTracker({ site: "s_1", key: "k", fetch: fakeFetch([]).fn, onError: (e) => void errors.push(e.message) });
  mm.track("orphan");
  expect(errors[0]).toContain("needs a visitor");
});
