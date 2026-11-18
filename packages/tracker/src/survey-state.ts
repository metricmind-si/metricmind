// What mm.js needs to know about surveys. The widget itself is survey-widget.ts, in its own file (survey.js).

export const SURVEY_EVENT = "$survey";

export type SurveyQuestionType = "rating" | "nps" | "choice" | "multi" | "text";

export interface PublicQuestion {
  id: string;
  type: SurveyQuestionType;
  text: string;
  /** Single or multiple choice: the options. */
  choices?: string[];
  /** Adds an "Other" answer with a box to write in. */
  other?: boolean;
  /** Where to go after this question: a question's ID or "end". Without it, the next question. */
  next?: string;
  /** The same per answer: "detractor", "passive", "promoter" for NPS, "1" to "5" for a rating, the choice (or "$other") for single choice. */
  routes?: Record<string, string>;
  /** Words under the two ends of a rating or NPS scale. */
  low?: string;
  high?: string;
  /** A free text question that can be left empty. */
  optional?: boolean;
}

/** What the browser gets for a survey that matches: the questions and its timing, never the targeting. */
export interface PublicSurvey {
  id: string;
  questions: PublicQuestion[];
  /** Seconds on the page before it appears. */
  delay: number;
  /** Days since any survey in this browser before this one may appear. */
  wait: number;
  /** Days before it may appear again; 0 means once. */
  repeat: number;
  /** Comes up after this event, on a page it targets. */
  event?: string;
  thanks?: string;
  /** Present on a feedback tab: its label (empty for the widget's own word). It opens on a click, whenever someone wants. */
  tab?: string;
}

export type SurveyProps = Record<string, string | number | boolean>;

/** The tracker as survey.js sees it: the queue, and what it needs to decide when to show a survey. */
export interface SurveyBridge {
  surveyAnswer(props: SurveyProps): void;
  feedback(message: string, rating?: number): void;
  /** The page now. */
  currentPath: string;
  /** True once the visitor has opted out. */
  disabled: boolean;
  /** Events sent on this page so far. */
  fired: Set<string>;
  onFired?: (name: string) => void;
  store(kind: "local"): { getItem(key: string): string | null; setItem(key: string, value: string): void } | undefined;
}
export type SurveyMount = (surveys: PublicSurvey[], tracker: SurveyBridge) => void;

export const TAB_ID = "mm-survey-tab";
/** The stored answer for "Other". */
export const OTHER = "$other";
export const END = "end";

/** Which route an answer takes; multiple choice and free text have only the question's own "next". */
export function routeKey(q: PublicQuestion, answer: { n?: unknown; c?: unknown }): string | undefined {
  if (q.type === "nps" && typeof answer.n === "number") return answer.n <= 6 ? "detractor" : answer.n <= 8 ? "passive" : "promoter";
  if (q.type === "rating" && typeof answer.n === "number") return String(answer.n);
  if (q.type === "choice" && typeof answer.c === "string") return answer.c;
  return undefined;
}

/** The index a target points at: past the last question for "end", the next question when it no longer exists. */
const indexOf = (questions: PublicQuestion[], i: number, target: string | undefined) => {
  if (target === END) return questions.length;
  const at = target ? questions.findIndex((x) => x.id === target) : -1;
  return at < 0 ? i + 1 : at;
};

/** Where an answer leads; `answer` is null for a question left empty. */
export function nextIndex(questions: PublicQuestion[], i: number, answer: { n?: unknown; c?: unknown } | null): number {
  const q = questions[i];
  const key = answer ? routeKey(q, answer) : undefined;
  return indexOf(questions, i, (key !== undefined && q.routes?.[key]) || q.next);
}

const exits = (questions: PublicQuestion[], i: number) => [indexOf(questions, i, questions[i].next), ...Object.values(questions[i].routes ?? {}).map((t) => indexOf(questions, i, t))];

/** Whether every answer to this question ends the survey: its button then says Send. */
export const alwaysEnds = (questions: PublicQuestion[], i: number) => exits(questions, i).every((at) => at >= questions.length);

/** A question that routes can reach again, or null. Routing that loops would never let anyone finish. */
export function routingLoop(questions: PublicQuestion[]): PublicQuestion | null {
  const state: number[] = [];
  const visit = (i: number): PublicQuestion | null => {
    if (i >= questions.length || state[i] === 2) return null;
    if (state[i] === 1) return questions[i];
    state[i] = 1;
    for (const at of exits(questions, i)) {
      const found = visit(at);
      if (found) return found;
    }
    state[i] = 2;
    return null;
  };
  for (let i = 0; i < questions.length; i++) {
    const found = visit(i);
    if (found) return found;
  }
  return null;
}

// When each survey last appeared in this browser; only written once one has.
export const SURVEY_KEY = "mm_sv";

const DAY = 86_400_000;

/**
 * The surveys this browser may see now. `state` holds when each survey last appeared, under its ID, and when any did,
 * under "$". Dismissing doesn't reset that: a dismissed survey comes back only if it repeats, after its repeat period.
 */
export function surveysDue(list: PublicSurvey[], state: Record<string, number>, now = Date.now()): PublicSurvey[] {
  return list.filter((s) => {
    const seen = state[s.id];
    if (seen && !(s.repeat > 0 && now - seen >= s.repeat * DAY)) return false;
    return !(s.wait > 0 && state.$ && now - state.$ < s.wait * DAY);
  });
}
