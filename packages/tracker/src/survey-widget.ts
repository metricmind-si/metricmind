// The survey widget: a small card in a shadow root, so the site's CSS can't reach it. Built from text the site's team
// wrote, set as text and never as HTML. Mounted by mm.js through survey.js, and by the dashboard's form as a preview.
import { feedbackText } from "./text";
import { alwaysEnds, nextIndex, OTHER, SURVEY_KEY, surveysDue, TAB_ID, type PublicQuestion, type PublicSurvey, type SurveyBridge, type SurveyProps } from "./survey-state";

const WORDS: Record<string, Record<"send" | "next" | "close" | "thanks" | "low" | "high" | "survey" | "other" | "pick" | "feedback", string>> = {
  en: { send: "Send", next: "Next", close: "Close this survey", thanks: "Thanks for your answer.", low: "Not likely", high: "Very likely", survey: "Survey", other: "Other", pick: "Pick at least one answer.", feedback: "Feedback" },
  fr: { send: "Envoyer", next: "Suivant", close: "Fermer ce questionnaire", thanks: "Merci pour votre réponse.", low: "Peu probable", high: "Très probable", survey: "Questionnaire", other: "Autre", pick: "Choisissez au moins une réponse.", feedback: "Votre avis" },
  ar: { send: "إرسال", next: "التالي", close: "إغلاق هذا الاستبيان", thanks: "شكرا على إجابتك.", low: "غير مرجح", high: "مرجح جدا", survey: "استبيان", other: "أخرى", pick: "اختر إجابة واحدة على الأقل.", feedback: "رأيك" },
};

const RTL_TEXT = /^[^\p{L}]*[֐-ࣿיִ-﷿ﹰ-﻿]/u;

/** Which way the survey reads: by its own first question, else by the page. */
export function surveyDirection(text: string, pageDir: string): "rtl" | "ltr" {
  return RTL_TEXT.test(text) || pageDir.toLowerCase() === "rtl" ? "rtl" : "ltr";
}

/** The widget's words: Arabic for a right-to-left survey, else the page's language, else English. */
export function surveyWords(dir: "rtl" | "ltr", lang: string) {
  return WORDS[dir === "rtl" ? "ar" : lang.slice(0, 2).toLowerCase()] ?? WORDS.en;
}

const luminance = (color: string): number | null => {
  const m = color.match(/[\d.]+/g)?.map(Number);
  if (!m || m.length < 3 || (m.length > 3 && m[3] < 0.5)) return null;
  return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
};

/** Dark when the page says so or paints itself dark; the browser's preference only when the page has no background. */
function pageIsDark(): boolean {
  const html = document.documentElement;
  const theme = (html.getAttribute("data-theme") ?? "").toLowerCase();
  if (theme === "dark" || /\bdark\b/.test(html.className)) return true;
  if (theme === "light" || /\blight\b/.test(html.className)) return false;
  for (const node of [document.body, html]) {
    const l = node && luminance(getComputedStyle(node).backgroundColor);
    if (typeof l === "number") return l < 0.4;
  }
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

const CSS = `
:host{all:initial!important;position:fixed!important;z-index:2147483000!important;inset-block-end:16px!important;inset-inline-end:16px!important;width:min(340px,calc(100vw - 24px))!important;display:block!important;color-scheme:light!important;--bg:#fff;--ink:#1a1c23;--soft:#5b5f6b;--rule:#d9dbe3;--accent:var(--mm-survey-accent,#4f46e5);--on:#fff}
:host([data-dark]){color-scheme:dark!important;--bg:#1b1d24;--ink:#eef0f4;--soft:#b0b4c0;--rule:#3a3d48;--accent:var(--mm-survey-accent,#a99cff);--on:#14151a}
:host([data-inline]){position:relative!important;inset:auto!important;z-index:auto!important;width:min(340px,100%)!important}
@media (max-width:480px){:host(:not([data-inline])){inset-inline:12px!important;inset-block-end:max(12px,env(safe-area-inset-bottom))!important;width:auto!important}}
*{box-sizing:border-box}
section{position:relative;background:var(--bg);color:var(--ink);border:1px solid var(--rule);border-radius:12px;padding:16px;box-shadow:0 8px 28px rgba(0,0,0,.18);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif}
@media (prefers-reduced-motion:no-preference){section{animation:in .18s ease-out}@keyframes in{from{opacity:0;transform:translateY(6px)}}}
fieldset{border:0;margin:0;padding:0;min-width:0}
legend,.q{display:block;padding:0;margin:0 0 10px;padding-inline-end:28px;font-weight:600;overflow-wrap:anywhere}
.x{position:absolute;inset-block-start:8px;inset-inline-end:8px;width:28px;height:28px;display:grid;place-items:center;background:none;border:0;border-radius:6px;color:var(--soft);cursor:pointer;font:inherit;font-size:18px;line-height:1}
.x:hover{color:var(--ink);background:color-mix(in srgb,var(--ink) 8%,transparent)}
.scale{display:grid;gap:3px}
.scale label,.list label{position:relative;display:block;cursor:pointer}
.scale input,.list input{position:absolute;opacity:0;inset:0;width:100%;height:100%;margin:0;cursor:pointer}
.scale span{display:grid;place-items:center;height:32px;border:1px solid var(--rule);border-radius:6px;font-variant-numeric:tabular-nums;font-size:13px}
.ends{display:flex;justify-content:space-between;gap:12px;margin-top:6px;color:var(--soft);font-size:12px}
.list{display:grid;gap:4px}
.list span{display:block;padding:7px 10px;border:1px solid var(--rule);border-radius:6px;overflow-wrap:anywhere}
.scale label:hover span,.list label:hover span{border-color:var(--accent)}
input:checked+span{background:var(--accent);border-color:var(--accent);color:var(--on)}
input:focus-visible+span,button:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.other{margin-top:6px;min-height:52px}
.other[hidden]{display:none}
textarea{display:block;width:100%;min-height:72px;resize:vertical;padding:8px 10px;border:1px solid var(--rule);border-radius:6px;background:transparent;color:inherit;font:inherit}
.foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px}
.step{color:var(--soft);font-size:12px}
.go{margin-inline-start:auto;padding:6px 14px;min-height:32px;border:0;border-radius:6px;background:var(--accent);color:var(--on);font:inherit;font-weight:600;cursor:pointer}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.done{margin:0;padding-inline-end:28px}
`;

// A tab on the edge of the screen. Set in its own element so that it never covers the card it opens.
const TAB_CSS = `
:host{all:initial!important;position:fixed!important;z-index:2147482999!important;inset-block-start:50%!important;inset-inline-end:0!important;transform:translateY(-50%)!important;display:block!important;--accent:var(--mm-survey-accent,#4f46e5);--on:#fff}
:host([data-dark]){--accent:var(--mm-survey-accent,#a99cff);--on:#14151a}
button{writing-mode:vertical-rl;min-width:32px;padding:12px 8px;border:0;border-start-start-radius:8px;border-end-start-radius:8px;background:var(--accent);color:var(--on);font:600 13px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.18)}
:host([dir=rtl]) button{border-radius:0 8px 8px 0}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}

function applyStyles(root: ShadowRoot, css = CSS) {
  // A constructed stylesheet isn't subject to a site's style-src policy, unlike a <style> element.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    root.append(el("style", {}, css));
  }
}

const radio = (name: string, value: string, spoken?: string) => {
  const input = el("input", { type: "radio", name, value });
  input.required = true;
  if (spoken) input.setAttribute("aria-label", spoken);
  return el("label", {}, input, el("span", {}, value));
};

/** An option of a choice question: what it stores and what it says, which differ for "Other". */
const option = (type: "radio" | "checkbox", name: string, value: string, label: string) => {
  const input = el("input", { type, name, value });
  if (type === "radio") input.required = true;
  return el("label", {}, input, el("span", {}, label));
};

/** Ingest takes up to 500 characters in a property: past that, whole answers are left out rather than cut in two. */
function joinChoices(list: string[]) {
  let joined = "";
  for (const c of list) if (`${joined}\n${c}`.length <= 500) joined = joined ? `${joined}\n${c}` : c;
  return joined;
}

/** What to send for an answer, or null when there's none to send. `other` is what was written under "Other". */
export function answerProps(survey: string, q: PublicQuestion, raw: string | string[], other = ""): SurveyProps | null {
  const base = { survey, a: "answer", q: q.id, t: q.type };
  const written = feedbackText(other);
  const allowed = (c: string) => Boolean(q.choices?.includes(c)) || (Boolean(q.other) && c === OTHER);
  if (Array.isArray(raw)) {
    const picked = raw.filter(allowed);
    if (q.type !== "multi" || !picked.length) return null;
    return { ...base, c: joinChoices(picked), ...(picked.includes(OTHER) && written && { text: written }) };
  }
  if (q.type === "multi") return null;
  if (q.type === "text") {
    const text = feedbackText(raw);
    return text ? { ...base, text } : null;
  }
  if (q.type === "choice") return allowed(raw) ? { ...base, c: raw, ...(raw === OTHER && written && { text: written }) } : null;
  const n = Number(raw);
  const [min, max] = q.type === "nps" ? [0, 10] : [1, 5];
  return raw !== "" && Number.isInteger(n) && n >= min && n <= max ? { ...base, n } : null;
}

/** A feedback tab's answer as the Feedback page shows it: what was written or picked, the score when there's one on the page's scale. */
export function feedbackOf(props: SurveyProps): { message: string; rating?: number } | null {
  if (props.a !== "answer") return null;
  const picked = typeof props.c === "string" ? props.c.split("\n").filter((c) => c !== OTHER) : [];
  const message = [picked.join(", "), typeof props.text === "string" ? props.text : ""].filter(Boolean).join(": ");
  if (message) return { message };
  if (typeof props.n !== "number") return null;
  return props.t === "rating" ? { message: `${props.n}/5`, rating: props.n } : { message: `${props.n}/10` };
}

export function mountSurvey(survey: PublicSurvey, api: { send: (props: SurveyProps) => void; done: (hadFocus: boolean) => void }, options: { into?: HTMLElement; dark?: boolean; focus?: boolean } = {}) {
  // Its own element name: a page's `div { display: none }` shouldn't hide it.
  const host = document.createElement("mm-survey");
  for (const attr of ["data-mm-survey", "data-mm-ignore"]) host.setAttribute(attr, "");
  host.id = "mm-survey";
  const preview = Boolean(options.into);
  const dir = surveyDirection(survey.questions[0]?.text ?? "", preview ? "" : document.documentElement.dir || document.body?.dir || "");
  const words = surveyWords(dir, preview ? "en" : document.documentElement.lang || navigator.language || "en");
  host.dir = dir;
  if (options.dark ?? pageIsDark()) host.setAttribute("data-dark", "");
  if (preview) host.setAttribute("data-inline", "");
  const root = host.attachShadow({ mode: "open" });
  applyStyles(root);

  const status = el("div", { class: "sr", role: "status" });
  const body = el("div");
  const close = el("button", { class: "x", type: "button", "aria-label": words.close }, "×");
  const card = el("section", { role: "dialog", "aria-modal": "false", "aria-label": words.survey }, status, close, body);
  root.append(card);
  const hadFocus = () => root.activeElement !== null;

  const finish = () => {
    const focused = hadFocus();
    host.remove();
    api.done(focused);
  };
  // Answers can skip questions, and "i / n" would then count wrong.
  const routed = survey.questions.some((q) => q.routes || q.next);
  const asked = new Set<number>();
  const dismiss = () => {
    api.send({ survey: survey.id, a: "dismiss" });
    finish();
  };
  close.addEventListener("click", dismiss);
  card.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") dismiss();
  });

  const step = (i: number) => {
    const q = survey.questions[i];
    asked.add(i);
    const focused = hadFocus();
    if (!q) {
      const thanks = survey.thanks || words.thanks;
      api.send({ survey: survey.id, a: "done" });
      body.replaceChildren(el("p", { class: "done" }, thanks));
      status.textContent = thanks;
      if (focused) close.focus();
      setTimeout(finish, 2500);
      return;
    }
    const form = el("form");
    const name = `q${i}`;
    let field: HTMLElement;
    if (q.type === "text") {
      const box = el("textarea", { id: name, name, maxlength: "500", rows: "3" });
      box.required = !q.optional;
      field = el("div", {}, el("label", { class: "q", for: name }, q.text), box);
    } else if (q.type === "choice" || q.type === "multi") {
      const kind = q.type === "multi" ? "checkbox" : "radio";
      const options = (q.choices ?? []).map((c) => option(kind, name, c, c));
      if (q.other) options.push(option(kind, name, OTHER, words.other));
      field = el("fieldset", {}, el("legend", {}, q.text), el("div", { class: "list" }, ...options));
      if (q.other) field.append(el("textarea", { class: "other", name: `${name}o`, maxlength: "500", rows: "2", "aria-label": words.other, hidden: "" }));
    } else {
      const start = q.type === "nps" ? 0 : 1;
      const count = q.type === "nps" ? 11 : 5;
      const low = q.low || (q.type === "nps" ? words.low : "");
      const high = q.high || (q.type === "nps" ? words.high : "");
      // The ends' words are drawn for sighted readers; the first and last options say them to a screen reader.
      const options = Array.from({ length: count }, (_, k) => radio(name, String(start + k), k === 0 && low ? `${start}, ${low}` : k === count - 1 && high ? `${start + k}, ${high}` : undefined));
      const scale = el("div", { class: "scale" }, ...options);
      scale.style.gridTemplateColumns = `repeat(${count},minmax(0,1fr))`;
      field = el("fieldset", {}, el("legend", {}, q.text), scale, el("div", { class: "ends", "aria-hidden": "true" }, el("span", {}, low), el("span", {}, high)));
    }
    const go = el("button", { class: "go", type: "submit" }, alwaysEnds(survey.questions, i) ? words.send : words.next);
    const foot = el("div", { class: "foot" }, go);
    if (survey.questions.length > 1 && !routed) foot.prepend(el("span", { class: "step" }, `${i + 1} / ${survey.questions.length}`));
    form.append(field, foot);
    const boxes = () => Array.from(form.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    const otherBox = form.querySelector<HTMLTextAreaElement>(".other");
    const otherPicked = () => Boolean(form.querySelector<HTMLInputElement>(`input[value="${OTHER}"]:checked`));
    form.addEventListener("change", () => {
      boxes().forEach((b) => b.setCustomValidity(""));
      if (otherBox) otherBox.hidden = !otherPicked();
    });

    const submit = () => {
      // A group of checkboxes has no "required" of its own: the first one speaks for it.
      if (q.type === "multi" && !boxes().some((b) => b.checked)) boxes()[0]?.setCustomValidity(words.pick);
      if (!form.reportValidity()) return;
      const data = new FormData(form);
      const value = data.get(name);
      const written = data.get(`${name}o`);
      const props = answerProps(survey.id, q, q.type === "multi" ? data.getAll(name).map(String) : typeof value === "string" ? value.trim() : "", typeof written === "string" ? written : "");
      if (props) api.send(props);
      const next = nextIndex(survey.questions, i, props);
      // Validated when saved; a survey cached from before a fix still can't trap anyone.
      step(asked.has(next) ? survey.questions.length : next);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submit();
    });
    // With a pointer, picking an answer is enough. Arrow keys also "click" (detail 0) while moving through options: those wait for the button.
    // Multiple choice waits for the button, and "Other" for what they write.
    if (q.type !== "text" && q.type !== "multi") {
      form.addEventListener("click", (e) => {
        if (e.detail <= 0 || !(e.target instanceof HTMLInputElement)) return;
        if (e.target.value !== OTHER) submit();
        else if (otherBox) {
          otherBox.hidden = false;
          otherBox.focus();
        }
      });
    }

    body.replaceChildren(form);
    status.textContent = q.text;
    if (focused) (form.querySelector("input,textarea") as HTMLElement | null)?.focus();
  };

  step(0);
  api.send({ survey: survey.id, a: "shown" });
  (options.into ?? document.body).append(host);
  if (options.focus) (root.querySelector("input,textarea") as HTMLElement | null)?.focus();
}

let waiting: PublicSurvey[] = [];
let open = false;

/** The feedback tab: a button at the edge that opens the survey's card, and comes back when the card closes. */
function showTab(survey: PublicSurvey, tracker: SurveyBridge, focus = false) {
  const found = document.getElementById(TAB_ID);
  if (found?.getAttribute("data-survey") === survey.id) return;
  found?.remove();
  if (tracker.disabled) return;
  const host = document.createElement("mm-survey-tab");
  host.id = TAB_ID;
  for (const [k, v] of [["data-mm-ignore", ""], ["data-survey", survey.id]]) host.setAttribute(k, v);
  const dir = surveyDirection(survey.questions[0]?.text ?? "", document.documentElement.dir || document.body?.dir || "");
  host.dir = dir;
  if (pageIsDark()) host.setAttribute("data-dark", "");
  const root = host.attachShadow({ mode: "open" });
  applyStyles(root, TAB_CSS);
  const button = el("button", { type: "button", "aria-haspopup": "dialog" }, survey.tab || surveyWords(dir, document.documentElement.lang || navigator.language || "en").feedback);
  button.addEventListener("click", () => {
    // Someone asking to speak comes before a card that came up by itself.
    document.getElementById("mm-survey")?.remove();
    host.remove();
    open = true;
    mountSurvey(
      survey,
      {
        send: (props) => {
          tracker.surveyAnswer(props);
          const said = feedbackOf(props);
          if (said) tracker.feedback(said.message, said.rating);
        },
        done: (hadFocus) => {
          open = false;
          showTab(survey, tracker, hadFocus);
        },
      },
      { focus: true },
    );
  });
  root.append(button);
  document.body.append(host);
  if (focus) button.focus();
}

/**
 * Decides what to show from the surveys mm.js found on this page: the first that's due, without an event or whose event
 * has happened (on this page, or on one it targets that was left before it could appear). It counts as seen once it appears.
 */
export function runSurveys(surveys: PublicSurvey[], tracker: SurveyBridge) {
  const read = (): Record<string, number> => {
    try {
      return JSON.parse(tracker.store("local")?.getItem(SURVEY_KEY) ?? "{}");
    } catch {
      return {};
    }
  };
  const save = (state: Record<string, number>) => {
    try {
      tracker.store("local")?.setItem(SURVEY_KEY, JSON.stringify(state));
    } catch {}
  };
  const tab = surveys.find((s) => s.tab !== undefined);
  if (tab) {
    if (!document.getElementById("mm-survey")) showTab(tab, tracker);
  } else document.getElementById(TAB_ID)?.remove();
  waiting = surveysDue(surveys.filter((s) => s.tab === undefined), read());
  const next = () => {
    if (open || tracker.disabled) return;
    const state = read();
    const survey = waiting.find((s) => !s.event || tracker.fired.has(s.event) || state[`!${s.id}`]);
    if (!survey) return;
    open = true;
    const path = tracker.currentPath;
    setTimeout(() => {
      open = false;
      // Left the page in the meantime or opted out: it stays due for a page it applies to.
      if (tracker.disabled || path !== tracker.currentPath || document.visibilityState === "hidden") return;
      open = true;
      const now = Date.now();
      const latest = read();
      delete latest[`!${survey.id}`];
      save({ ...latest, [survey.id]: now, $: now });
      waiting = [];
      mountSurvey(survey, { send: (props) => tracker.surveyAnswer(props), done: () => void (open = false) });
    }, survey.delay * 1000);
  };
  tracker.onFired = (name) => {
    const hit = waiting.filter((s) => s.event === name);
    if (!hit.length) return;
    save({ ...read(), ...Object.fromEntries(hit.map((s) => [`!${s.id}`, Date.now()])) });
    next();
  };
  next();
}
