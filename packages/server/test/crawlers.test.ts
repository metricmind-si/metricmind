import { afterEach, describe, expect, test } from "bun:test";
import { crawlerAddress, looksLikeCrawler, trackCrawler } from "../src/crawlers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("pre-filter catches AI crawlers and skips browsers", () => {
  expect(looksLikeCrawler("Mozilla/5.0 (compatible; GPTBot/1.2)")).toBe(true);
  expect(looksLikeCrawler("Mozilla/5.0 (compatible; ClaudeBot/1.0)")).toBe(true);
  expect(looksLikeCrawler("Mozilla/5.0 (iPhone) Safari/604.1")).toBe(false);
  expect(looksLikeCrawler(null)).toBe(false);
});

test("reports crawler hits with the server key and never throws", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    throw new Error("network down");
  }) as unknown as typeof fetch;

  const opts = { site: "site_demo", key: "mmsk_x", endpoint: "http://localhost:3200/v1/crawl" };
  await trackCrawler(new Request("https://shop.example/llms.txt", { headers: { "user-agent": "PerplexityBot/1.0" } }), opts);
  await trackCrawler(new Request("https://shop.example/", { headers: { "user-agent": "Mozilla/5.0 Chrome/140" } }), opts);

  expect(calls).toHaveLength(1);
  expect((calls[0].init.headers as Record<string, string>)["x-mm-key"]).toBe("mmsk_x");
  expect(JSON.parse(String(calls[0].init.body)).hits[0]).toMatchObject({ path: "/llms.txt", ua: "PerplexityBot/1.0" });
});

describe("what a read reports", () => {
  const opts = { site: "site_demo", key: "mmsk_x", endpoint: "http://localhost:3200/v1/crawl" };
  const capture = () => {
    const bodies: { v: number; hits: Record<string, unknown>[] }[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    return bodies;
  };
  const gpt = (headers: Record<string, string> = {}) => new Request("https://shop.example/.env", { headers: { "user-agent": "GPTBot/1.2", ...headers } });

  test("no status unless one is passed: never an assumed 200", async () => {
    const bodies = capture();
    await trackCrawler(gpt(), opts);
    await trackCrawler(gpt(), opts, 404);
    await trackCrawler(gpt(), opts, { status: 200 });
    expect(bodies.map((b) => b.v)).toEqual([2, 2, 2]);
    expect(bodies.map((b) => b.hits[0].status)).toEqual([undefined, 404, 200]);
  });

  test("sends the crawler's address for the check: explicit first, then the usual proxy headers", async () => {
    const bodies = capture();
    await trackCrawler(gpt({ "x-forwarded-for": "20.171.206.9, 10.0.0.2" }), opts);
    await trackCrawler(gpt({ "cf-connecting-ip": "2001:db8::1", "x-forwarded-for": "198.51.100.1" }), opts);
    await trackCrawler(gpt({ "x-forwarded-for": "198.51.100.1" }), opts, { ip: "20.171.206.10", status: 404 });
    await trackCrawler(gpt(), opts);
    expect(bodies.map((b) => b.hits[0].ip)).toEqual(["20.171.206.9", "2001:db8::1", "20.171.206.10", undefined]);
  });

  test("crawlerAddress ignores junk", () => {
    expect(crawlerAddress(new Request("https://x.example/", { headers: { "x-real-ip": "203.0.113.4" } }))).toBe("203.0.113.4");
    expect(crawlerAddress(new Request("https://x.example/", { headers: { "x-forwarded-for": "x".repeat(80) } }))).toBe("");
    expect(crawlerAddress(new Request("https://x.example/"))).toBe("");
  });
});
