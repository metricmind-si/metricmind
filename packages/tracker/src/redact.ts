// A page's own redaction, for apps whose URLs and text can hold their customers' data (record IDs, names, tokens).
// The page sets `window.mmRedact` before mm.js loads; nothing changes for pages that don't.
//
//   window.mmRedact = {
//     path: (p) => p.replace(/^\/orders\/[^/]+/, "/orders/[id]"),   // every path recorded or sent; null leaves the page out
//     value: (text, field) => (field.startsWith("error.") ? text.replace(/\d+/g, "…") : null),
//   };
//
// With `path`, page titles aren't sent and a referrer keeps only its origin (or, on the same site, the redacted path):
// both would repeat what the path hides. Whatever the hook does wrong (throws, returns something else), the result is
// redacted, never the original.
import type { TrackerEvent } from "./types";

export interface Redaction {
  /** Every page path the script records or sends (page views, events, errors, flags, surveys); null leaves the page out. */
  path?: (pathname: string) => string | null;
  /**
   * Every other text: error messages and stacks (field "error.message", "error.stack") and string event properties
   * ("<event>.<property>", e.g. "$rage.target"; click count labels are "$clicks.label"). null drops the property.
   */
  value?: (value: string, field: string) => string | null;
}

/** What a path becomes when the page's hook fails: never the path itself. */
export const REDACTED_PATH = "/[redacted]";
export const REDACTED_TEXT = "[redacted]";
const CLICKS = "$clicks";

/** The path to record for this page: the hook's answer, null to leave the page out, or the path itself without a hook. */
export function redactPath(r: Redaction | undefined, path: string): string | null {
  if (!r?.path) return path;
  try {
    const out = r.path(path);
    if (out === null) return null;
    return typeof out === "string" && out.startsWith("/") ? out.slice(0, 1000) : REDACTED_PATH;
  } catch {
    return REDACTED_PATH;
  }
}

/** The referrer to send. With a path hook: the same site's referrer gets the redacted path, any other only its origin. */
export function redactReferrer(r: Redaction | undefined, referrer: string, origin: string): string | undefined {
  if (!referrer) return undefined;
  if (!r?.path) return referrer;
  try {
    const u = new URL(referrer);
    if (u.origin !== origin) return `${u.origin}/`;
    return `${u.origin}${redactPath(r, u.pathname) ?? "/"}`;
  } catch {
    return undefined;
  }
}

/** One text through the hook; anything but a string back means drop it. */
function through(r: Redaction, value: string, field: string): string | null {
  try {
    const out = r.value!(value, field);
    return typeof out === "string" ? out : null;
  } catch {
    return null;
  }
}

/** An event with its error text and string properties passed through the page's `value` hook (unchanged without one). */
export function redactEvent<T extends Pick<TrackerEvent, "type" | "name" | "props" | "error">>(r: Redaction | undefined, e: T): T {
  if (!r?.value) return e;
  let out = e;
  if (e.error) {
    const message = through(r, e.error.message, "error.message") ?? REDACTED_TEXT;
    const stack = e.error.stack === undefined ? undefined : (through(r, e.error.stack, "error.stack") ?? undefined);
    out = { ...out, error: stack === undefined ? { message } : { message, stack } };
  }
  if (e.props) {
    const owner = e.name || e.type;
    const props: NonNullable<TrackerEvent["props"]> = {};
    for (const [key, value] of Object.entries(e.props)) {
      // Click counts are keyed by label: the label is the text. `$grid`/`$el` are coarse cells and stable keys.
      if (owner === CLICKS) {
        if (key.startsWith("$")) props[key] = value;
        else {
          const label = through(r, key, `${CLICKS}.label`);
          if (label !== null) props[label] = typeof value === "number" ? (Number(props[label]) || 0) + value : value;
        }
        continue;
      }
      if (typeof value !== "string") props[key] = value;
      else {
        const kept = through(r, value, `${owner}.${key}`);
        if (kept !== null) props[key] = kept;
      }
    }
    out = { ...out, props };
  }
  return out;
}
