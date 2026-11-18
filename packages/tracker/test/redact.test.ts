import { describe, expect, test } from "bun:test";
import { REDACTED_PATH, REDACTED_TEXT, redactEvent as redact, redactPath, redactReferrer, type Redaction } from "../src/redact";
import type { TrackerEvent } from "../src/types";

const redactEvent = (r: Redaction, e: Pick<TrackerEvent, "type" | "name" | "props" | "error">) => redact(r, e);

const ids: Redaction = { path: (p) => p.replace(/^\/orders\/[^/]+/, "/orders/[id]") };

describe("redactPath", () => {
  test("without a hook the path is unchanged", () => {
    expect(redactPath(undefined, "/orders/42")).toBe("/orders/42");
    expect(redactPath({}, "/orders/42")).toBe("/orders/42");
  });
  test("the hook's answer, or null to leave the page out", () => {
    expect(redactPath(ids, "/orders/42/items")).toBe("/orders/[id]/items");
    expect(redactPath({ path: () => null }, "/share/abc")).toBeNull();
  });
  test("a hook that throws or answers nonsense never lets the path through", () => {
    expect(redactPath({ path: () => { throw new Error("x"); } }, "/orders/42")).toBe(REDACTED_PATH);
    expect(redactPath({ path: () => "orders/42" }, "/orders/42")).toBe(REDACTED_PATH);
    expect(redactPath({ path: () => 42 as unknown as string }, "/orders/42")).toBe(REDACTED_PATH);
  });
});

describe("redactReferrer", () => {
  test("same site: the redacted path; another site: its origin only", () => {
    expect(redactReferrer(ids, "https://app.example/orders/42?x=1", "https://app.example")).toBe("https://app.example/orders/[id]");
    expect(redactReferrer(ids, "https://mail.example/inbox/77", "https://app.example")).toBe("https://mail.example/");
    expect(redactReferrer({ path: () => null }, "https://app.example/share/t", "https://app.example")).toBe("https://app.example/");
  });
  test("without a path hook the referrer is unchanged", () => {
    expect(redactReferrer(undefined, "https://a.example/x", "https://b.example")).toBe("https://a.example/x");
    expect(redactReferrer(ids, "", "https://b.example")).toBeUndefined();
  });
});

describe("redactEvent", () => {
  const scrub: Redaction = { value: (v, field) => (field === "$rage.target" ? v.split(":")[0] : field.startsWith("error.") ? v.replace(/\d+/g, "…") : field === "$clicks.label" ? "button" : null) };

  test("error message and stack go through the hook", () => {
    const e = redactEvent(scrub, { type: "error", error: { message: "order 42 failed", stack: "at x:1:2" } });
    expect(e.error).toEqual({ message: "order … failed", stack: "at x:…:…" });
    const dropped = redactEvent({ value: () => null }, { type: "error", error: { message: "secret", stack: "s" } });
    expect(dropped.error).toEqual({ message: REDACTED_TEXT });
  });
  test("string properties go through it by event and key; null drops them; numbers stay", () => {
    expect(redactEvent(scrub, { type: "event", name: "$rage", props: { target: "button: Delete Acme" } }).props).toEqual({ target: "button" });
    expect(redactEvent(scrub, { type: "event", name: "$form_abandon", props: { form: "Acme", fields: 2 } }).props).toEqual({ fields: 2 });
  });
  test("click count labels are text too, merged when they redact to the same", () => {
    expect(redactEvent(scrub, { type: "event", name: "$clicks", props: { "button: Acme": 2, "button: Beta": 3, $grid: "1~2" } }).props).toEqual({ button: 5, $grid: "1~2" });
  });
  test("a hook that throws drops the value", () => {
    expect(redactEvent({ value: () => { throw new Error("x"); } }, { type: "event", name: "x", props: { a: "b" } }).props).toEqual({});
  });
  test("without a value hook the event is the same object", () => {
    const e = { type: "event" as const, name: "x", props: { a: "b" } };
    expect(redactEvent(ids, e)).toBe(e);
  });
});
