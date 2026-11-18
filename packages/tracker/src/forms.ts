// Form starts, submits and abandonment, without ever reading what people type: only the form's label and
// the labels of the fields touched (name, id, aria-label or <label> text, numbers masked).
import type { Emit } from "./clicks";

export const FORM_START = "$form_start";
export const FORM_SUBMIT = "$form_submit";
export const FORM_ABANDON = "$form_abandon";

const short = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().replace(/\d{3,}/g, "…").slice(0, 40);

export function formLabel(form: Element): string {
  const action = form.getAttribute("action");
  return short(form.getAttribute("aria-label") || form.getAttribute("name") || form.id || (action && action.startsWith("/") ? action.split("?")[0] : "")) || "form";
}

export function fieldLabel(field: Element): string {
  const id = field.id;
  const label = (id && typeof document === "object" ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : null) || field.closest("label")?.textContent;
  return short(field.getAttribute("aria-label") || label || field.getAttribute("name") || id || field.getAttribute("placeholder")) || field.tagName.toLowerCase();
}

const IGNORED = new Set(["hidden", "submit", "button", "reset", "image"]);

/** A search box isn't a form someone fills in: typing in it and moving on is not abandoning, sending it is not converting. */
export function isSearchForm(form: Element): boolean {
  return form.matches("[role=search]") || /search|recherche|\u0628\u062d\u062b/i.test(form.getAttribute("action") ?? "") || !!form.querySelector("input[type=search], input[name=q], input[name=query], input[name=search]");
}

const SAME_SENDING_MS = 2000;
const CHOICE_TYPES = new Set(["checkbox", "radio", "number", "range"]);

/** Typing means someone is filling the form in. A sort menu, a filter tick or a cart quantity is using the page, and leaving it isn't giving up. */
export function isTypedField(field: Element): boolean {
  if (field.tagName === "SELECT") return false;
  return !CHOICE_TYPES.has((field.getAttribute("type") ?? "").toLowerCase());
}

/** Whether the browser would send this form: valid, or set to skip validation. */
function isSendable(form: Element): boolean {
  const f = form as HTMLFormElement;
  return f.noValidate || f.checkValidity?.() !== false;
}

/** Watches forms; returns a function that reports forms started and not submitted (call when the page is left). */
export function watchForms(emit: Emit): () => void {
  const started = new Map<Element, { typed: boolean; fields: Set<string>; last: string; lastField: Element | null }>();
  const reported = new WeakMap<Element, number>();
  // Sign-in forms stay in the forms report but are neither a conversion nor a form left unsent.
  const base = (form: Element) => ({ form: formLabel(form), ...(form.querySelector("input[type=password]") ? { auth: true } : {}) });
  const submitted = (form: Element) => {
    // The click on the submit button and the submit event are one sending.
    if (Date.now() - (reported.get(form) ?? 0) < SAME_SENDING_MS) return;
    reported.set(form, Date.now());
    emit(FORM_SUBMIT, { ...base(form), fields: started.get(form)?.fields.size ?? 0 });
    started.delete(form);
  };
  // Started means something was entered: tapping a field and leaving it isn't starting a form.
  document.addEventListener(
    "input",
    (e) => {
      const field = e.target instanceof Element ? e.target.closest("input, textarea, select") : null;
      if (!field || IGNORED.has((field.getAttribute("type") ?? "").toLowerCase())) return;
      const form = field.closest("form");
      if (!form || isSearchForm(form)) return;
      let s = started.get(form);
      if (!s) started.set(form, (s = { typed: false, fields: new Set(), last: "", lastField: null }));
      if (!s.typed && isTypedField(field)) {
        s.typed = true;
        emit(FORM_START, base(form));
      }
      if (s.lastField === field) return;
      s.lastField = field;
      s.last = fieldLabel(field);
      s.fields.add(s.last);
    },
    true,
  );
  // A real sending counts even with nothing typed (a one-button form); search forms stay out.
  document.addEventListener("submit", (e) => e.target instanceof Element && !isSearchForm(e.target) && isSendable(e.target) && submitted(e.target), true);
  // Forms sent with JavaScript (no submit event): a click on their submit button counts as sending.
  document.addEventListener(
    "click",
    (e) => {
      const button = e.target instanceof Element ? e.target.closest("button, input[type=submit]") : null;
      const form = button?.closest("form");
      // Only a form already being filled in: a click on an invalid form's button sends nothing.
      if (button && form && started.has(form) && isSendable(form) && (button.tagName === "INPUT" || (button.getAttribute("type") ?? "submit") === "submit")) submitted(form);
    },
    true,
  );
  return () => {
    for (const [form, s] of started) if (s.typed) emit(FORM_ABANDON, { ...base(form), last_field: s.last, fields: s.fields.size });
    started.clear();
  };
}
