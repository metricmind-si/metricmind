// Browser entry for mm.js. Usage:
//   <script src="https://cdn.metricmind.si/mm.js" data-site="SITE_ID" defer></script>
//   mm.track("signup", { plan: "pro" })
//   mm.identify("user_123", { email: "a@b.co" }) after login, mm.reset() on logout
//   const { enabled, variant } = await mm.flag("new-checkout")
//   mm.ids() → { visitor, session, user } for Stripe/Paddle checkout metadata
//   mm.feedback("The filters are confusing", 3) from your own feedback form (emails and phone numbers removed)
// Options (data-*): api, vitals, errors, outbound ("false" to disable),
// clicks ("false": no click counts and no heatmap), heatmap ("true": adds the coarse grid and element keys to click counts), surveys ("false": never show one),
// allow-local ("true" to track on localhost), respect-gpc ("true": Global Privacy Control / Do Not Track opt out),
// storage ("none": nothing stored in the browser; visitors counted with a daily-rotating server-side hash).
// window.mmRedact, set before this script: the page's own redaction of paths and text (redact.ts).
import type { Redaction } from "./redact";
import type { SurveyMount } from "./survey-state";
import { Tracker } from "./tracker";

type Method = "track" | "feedback" | "identify" | "reset" | "optOut" | "optIn" | "flag" | "flags" | "flagOverride" | "ids";
type Call = [method: Method, ...args: unknown[]];

declare global {
  interface Window {
    mm?: { q?: Call[] } & Partial<Pick<Tracker, Method>>;
    /** Sites this page already measures: the snippet pasted twice (theme and plugin) mustn't count twice. */
    mmSites?: string[];
    /** Set by survey.js, loaded only when a survey is due. */
    mmSurveyUI?: SurveyMount;
    /** Set by the page before mm.js loads: its own redaction of paths and text (see redact.ts). */
    mmRedact?: Redaction;
  }
}

const DEFAULT_ENDPOINT = "https://in.metricmind.si/v1/batch";

const script = document.currentScript as HTMLScriptElement | null;
const data = script?.dataset ?? {};

if (data.site && window.mmSites?.includes(data.site)) {
  console.warn("[MetricMind] This site's script is on the page twice; the second one does nothing.");
} else if (data.site) {
  (window.mmSites ??= []).push(data.site);
  const tracker = new Tracker({
    site: data.site,
    endpoint: data.api ?? DEFAULT_ENDPOINT,
    vitals: data.vitals !== "false",
    errors: data.errors !== "false",
    outbound: data.outbound !== "false",
    clicks: data.clicks !== "false",
    heatmap: data.heatmap === "true",
    surveys: data.surveys !== "false",
    hash: data.hash === "true",
    contacts: data.contacts !== "false",
    search: data.search,
    allowBots: data.allowBots === "true",
    allowLocal: data.allowLocal === "true",
    environment: data.environment,
    respectGpc: data.respectGpc === "true",
    storage: data.storage === "none" ? "none" : undefined,
    redact: window.mmRedact,
  });

  // "Exclude my visits" link: ?mm_optout=1 stops tracking in this browser, ?mm_optout=0 resumes.
  const optParam = new URLSearchParams(location.search).get("mm_optout");
  if (optParam === "1") tracker.optOut();
  else if (optParam === "0") tracker.optIn();

  // Replay calls made before the script loaded (window.mm.q stub pattern).
  const pending = window.mm?.q ?? [];
  window.mm = {
    track: tracker.track.bind(tracker),
    feedback: tracker.feedback.bind(tracker),
    optOut: tracker.optOut.bind(tracker),
    optIn: tracker.optIn.bind(tracker),
    identify: tracker.identify.bind(tracker),
    reset: tracker.reset.bind(tracker),
    flag: tracker.flag.bind(tracker),
    flags: tracker.flags.bind(tracker),
    flagOverride: tracker.flagOverride.bind(tracker),
    ids: tracker.ids.bind(tracker),
  };
  // Consent and identity first, so an opt-out queued before load stops the first pageview too, and the
  // first pageview already carries the user ID.
  const early: Method[] = ["optOut", "optIn", "identify"];
  for (const [method, ...args] of pending.filter(([m]) => early.includes(m))) (window.mm[method] as (...a: unknown[]) => void)?.(...args);
  tracker.start();
  for (const [method, ...args] of pending.filter(([m]) => !early.includes(m))) {
    (window.mm[method] as (...a: unknown[]) => void)?.(...args);
  }
} else {
  console.warn("[MetricMind] Missing data-site on the script tag.");
}
