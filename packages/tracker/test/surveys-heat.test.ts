import { describe, expect, test } from "bun:test";
import { heatCell, stableName } from "../src/clicks";
import { alwaysEnds, nextIndex, OTHER, routeKey, routingLoop, surveysDue, type PublicQuestion, type PublicSurvey } from "../src/survey-state";
import { answerProps, feedbackOf, surveyDirection, surveyWords } from "../src/survey-widget";

const DAY = 86_400_000;
const survey = (over: Partial<PublicSurvey> = {}): PublicSurvey => ({ id: "srv_a", questions: [], delay: 0, wait: 0, repeat: 0, ...over });

describe("surveysDue", () => {
  test("never seen: due", () => expect(surveysDue([survey()], {}, 1000)).toHaveLength(1));
  test("seen, no repeat: never again, even after a long time", () => expect(surveysDue([survey()], { srv_a: 1 }, 1000 * DAY)).toEqual([]));
  test("seen with a repeat: only after its days", () => {
    const s = survey({ repeat: 30 });
    expect(surveysDue([s], { srv_a: 1 }, 29 * DAY)).toEqual([]);
    expect(surveysDue([s], { srv_a: 1 }, 30 * DAY + 1)).toHaveLength(1);
  });
  test("quiet days count from any survey", () => {
    const s = survey({ id: "srv_b", wait: 7 });
    expect(surveysDue([s], { srv_a: 1, $: 1 }, 6 * DAY)).toEqual([]);
    expect(surveysDue([s], { srv_a: 1, $: 1 }, 8 * DAY)).toHaveLength(1);
  });
});

describe("routing", () => {
  const list: PublicQuestion[] = [
    { id: "qa", type: "nps", text: "?", routes: { detractor: "qc", promoter: "end" } },
    { id: "qb", type: "text", text: "?", next: "end" },
    { id: "qc", type: "choice", text: "?", choices: ["A", "B"], other: true, routes: { A: "qb", [OTHER]: "end" } },
    { id: "qd", type: "multi", text: "?", choices: ["A", "B"] },
  ];
  test("NPS groups", () => {
    expect([0, 6, 7, 8, 9, 10].map((n) => routeKey(list[0], { n }))).toEqual(["detractor", "detractor", "passive", "passive", "promoter", "promoter"]);
  });
  test("an answer goes where its route says, otherwise on", () => {
    expect(nextIndex(list, 0, { n: 3 })).toBe(2);
    expect(nextIndex(list, 0, { n: 7 })).toBe(1);
    expect(nextIndex(list, 0, { n: 10 })).toBe(4);
    expect(nextIndex(list, 2, { c: "A" })).toBe(1);
    expect(nextIndex(list, 2, { c: OTHER })).toBe(4);
    expect(nextIndex(list, 2, { c: "B" })).toBe(3);
  });
  test("multiple choice and an empty answer take the question's own next", () => {
    expect(nextIndex(list, 3, { c: "A\nB" })).toBe(4);
    expect(nextIndex(list, 1, null)).toBe(4);
  });
  test("a target that's gone falls through to the next question", () => {
    expect(nextIndex([{ id: "qa", type: "text", text: "?", next: "qz" }, { id: "qb", type: "text", text: "?" }], 0, null)).toBe(1);
  });
  test("loops are found, forward jumps aren't loops", () => {
    expect(routingLoop(list)).toBeNull();
    expect(routingLoop([{ id: "qa", type: "text", text: "?" }, { id: "qb", type: "text", text: "?", next: "qa" }])?.id).toBe("qa");
    expect(routingLoop([{ id: "qa", type: "nps", text: "?", routes: { promoter: "qc" } }, { id: "qb", type: "text", text: "?" }, { id: "qc", type: "text", text: "?", next: "qb" }])?.id).toBe("qb");
  });
  test("the button says Send only when every answer ends it", () => {
    expect(alwaysEnds(list, 1)).toBe(true);
    expect(alwaysEnds(list, 3)).toBe(true);
    expect(alwaysEnds(list, 0)).toBe(false);
  });
});

describe("what a feedback tab sends to Feedback", () => {
  const a = (more: object) => ({ survey: "srv_a", a: "answer", q: "qx", ...more }) as Parameters<typeof feedbackOf>[0];
  test("text, a choice, several choices and Other", () => {
    expect(feedbackOf(a({ t: "text", text: "Great" }))).toEqual({ message: "Great" });
    expect(feedbackOf(a({ t: "choice", c: "Price" }))).toEqual({ message: "Price" });
    expect(feedbackOf(a({ t: "multi", c: "A\nB" }))).toEqual({ message: "A, B" });
    expect(feedbackOf(a({ t: "choice", c: OTHER, text: "Mine" }))).toEqual({ message: "Mine" });
    expect(feedbackOf(a({ t: "multi", c: `A\n${OTHER}`, text: "Mine" }))).toEqual({ message: "A: Mine" });
  });
  test("a score says what it's out of; only 1 to 5 is a rating", () => {
    expect(feedbackOf(a({ t: "rating", n: 4 }))).toEqual({ message: "4/5", rating: 4 });
    expect(feedbackOf(a({ t: "nps", n: 9 }))).toEqual({ message: "9/10" });
  });
  test("only answers", () => {
    expect(feedbackOf({ survey: "srv_a", a: "shown" })).toBeNull();
    expect(feedbackOf({ survey: "srv_a", a: "dismiss" })).toBeNull();
  });
});

describe("answerProps", () => {
  const q = { id: "qx", text: "?" };
  test("multiple choice: only offered answers, one per line, within ingest's limit", () => {
    const multi: PublicQuestion = { ...q, type: "multi", choices: ["A", "B", "C"], other: true };
    expect(answerProps("srv_a", multi, ["A", "C", "Z"])).toEqual({ survey: "srv_a", a: "answer", q: "qx", t: "multi", c: "A\nC" });
    expect(answerProps("srv_a", multi, ["Z"])).toBeNull();
    expect(answerProps("srv_a", multi, [])).toBeNull();
    expect(answerProps("srv_a", multi, ["A", OTHER], "write to a@b.co")).toEqual({ survey: "srv_a", a: "answer", q: "qx", t: "multi", c: `A\n${OTHER}`, text: "write to [email]" });
    const long = "x".repeat(80);
    const many: PublicQuestion = { ...q, type: "multi", choices: Array.from({ length: 8 }, (_, i) => `${i}${long}`) };
    expect(String(answerProps("srv_a", many, many.choices!)?.c).length).toBeLessThanOrEqual(500);
  });
  test("single choice with Other keeps the text only for Other", () => {
    const choice: PublicQuestion = { ...q, type: "choice", choices: ["A"], other: true };
    expect(answerProps("srv_a", choice, OTHER, "Mine")).toEqual({ survey: "srv_a", a: "answer", q: "qx", t: "choice", c: OTHER, text: "Mine" });
    expect(answerProps("srv_a", choice, "A", "left over")).toEqual({ survey: "srv_a", a: "answer", q: "qx", t: "choice", c: "A" });
    expect(answerProps("srv_a", { ...choice, other: undefined }, OTHER, "Mine")).toBeNull();
  });
  test("NPS 0 to 10", () => {
    expect(answerProps("srv_a", { ...q, type: "nps" }, "0")).toEqual({ survey: "srv_a", a: "answer", q: "qx", t: "nps", n: 0 });
    expect(answerProps("srv_a", { ...q, type: "nps" }, "11")).toBeNull();
    expect(answerProps("srv_a", { ...q, type: "nps" }, "")).toBeNull();
  });
  test("rating 1 to 5", () => {
    expect(answerProps("srv_a", { ...q, type: "rating" }, "5")?.n).toBe(5);
    expect(answerProps("srv_a", { ...q, type: "rating" }, "0")).toBeNull();
    expect(answerProps("srv_a", { ...q, type: "rating" }, "2.5")).toBeNull();
  });
  test("a choice must be one of the choices", () => {
    expect(answerProps("srv_a", { ...q, type: "choice", choices: ["A"] }, "A")?.c).toBe("A");
    expect(answerProps("srv_a", { ...q, type: "choice", choices: ["A"] }, "B")).toBeNull();
  });
  test("free text is cleaned; empty is no answer", () => {
    expect(answerProps("srv_a", { ...q, type: "text" }, "mail a@b.co")?.text).toBe("mail [email]");
    expect(answerProps("srv_a", { ...q, type: "text" }, "   ")).toBeNull();
    expect(String(answerProps("srv_a", { ...q, type: "text" }, "x".repeat(900))?.text).length).toBe(500);
  });
});

describe("direction and words", () => {
  test("follows the question's script, else the page", () => {
    expect(surveyDirection("ما رأيك؟", "")).toBe("rtl");
    expect(surveyDirection("What do you think?", "")).toBe("ltr");
    expect(surveyDirection("What do you think?", "RTL")).toBe("rtl");
  });
  test("words: Arabic for right-to-left, else the page's language, else English", () => {
    expect(surveyWords("rtl", "fr").send).toBe("إرسال");
    expect(surveyWords("ltr", "fr-MA").send).toBe("Envoyer");
    expect(surveyWords("ltr", "de").send).toBe("Send");
  });
});

describe("heat", () => {
  test("a cell is column + row × 8, kept inside the grid", () => {
    expect(heatCell(0, 0, 1000, 2000)).toBe(0);
    expect(heatCell(999, 0, 1000, 2000)).toBe(7);
    expect(heatCell(0, 100, 1000, 2000)).toBe(8);
    expect(heatCell(1000, 2000, 1000, 2000)).toBe(159);
    expect(heatCell(5000, 99999, 1000, 2000)).toBe(159);
    expect(heatCell(-5, -5, 1000, 2000)).toBe(0);
  });
  test("names written by a developer pass; text, generated IDs and personal data don't", () => {
    for (const ok of ["buy", "signup_clicked", "cta-2", "Hero"]) expect(stableName(ok)).toBe(ok);
    for (const no of [null, "", "user-12345", ":r1:", "a@b.co", "Buy now", "x".repeat(33), "/path", "ember123", "7days"]) expect(stableName(no)).toBe("");
  });
});
