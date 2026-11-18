// Site search terms (what visitors look for), from the search box's URL
// parameter. Only that parameter is read; terms that look like an email
// address or a phone number are never sent.

export const SEARCH_EVENT = "search";
const DEFAULT_PARAMS = ["q", "query", "search", "s", "keyword", "k", "term"];

/** Normalized search term from a query string, or null. `param` overrides the usual names; "off" disables. */
export function searchTerm(search: string, param?: string): string | null {
  if (param === "off") return null;
  const params = new URLSearchParams(search);
  const names = param ? [param] : DEFAULT_PARAMS;
  for (const name of names) {
    const raw = params.get(name);
    if (!raw) continue;
    const term = raw.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 100);
    if (!term) continue;
    if (/@/.test(term) || /\d[\d\s().-]{6,}\d/.test(term)) return null;
    return term;
  }
  return null;
}

/**
 * The number of results the page shows for the current search, when the site marks it with
 * `data-mm-results="12"` on any element (opt-in; a whole number ≥ 0), else null.
 */
export function searchResults(doc: Pick<Document, "querySelector" | "querySelectorAll">, fromText = true): number | null {
  const raw = doc.querySelector("[data-mm-results]")?.getAttribute("data-mm-results")?.trim();
  if (raw) return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
  return fromText ? resultsFromText(doc) : null;
}

// "41 résultats pour …", "41 نتيجة عن …", "12 results", or "Aucun résultat" / "No results" on the results page.
const COUNT_TEXT = /^\s*(\d{1,3}(?:[\s.,\u00a0\u202f]\d{3})+|\d{1,9})\s*(?:r[ée]sultats?|results?|resultados?|risultati|ergebnisse|treffer|نتيجة|نتائج)(?![\p{L}])(?!\s*(?:par|per|pro|por)\s+p)/iu;
const NONE_TEXT = /^\s*(?:aucun(?:e)?\s+(?:r[ée]sultat|annonce\s+(?:trouv|ne\s+correspond))|no\s+(?:results?|matches)|nothing\s+found|0\s+r[ée]sultat|sin\s+resultados|keine\s+(?:ergebnisse|treffer)|nessun\s+risultato|لا\s+توجد\s+نتائج|لا\s+نتائج)/iu;
// Autocomplete widgets and hidden templates say "5 results" or "No results" too; only visible page text counts.
const SKIP = "[hidden],[aria-hidden=true],[role=combobox],[role=listbox],[role=option],template";
function visible(el: Element): boolean {
  if (typeof el.closest === "function" && el.closest(SKIP)) return false;
  const e = el as Element & { checkVisibility?: () => boolean };
  if (typeof e.checkVisibility === "function") return e.checkVisibility();
  return typeof el.getClientRects === "function" ? el.getClientRects().length > 0 : true;
}

/** A result count stated in a short heading or line of the page, when it doesn't mark one with data-mm-results. */
function resultsFromText(doc: Pick<Document, "querySelector" | "querySelectorAll">): number | null {
  // The page's main content when it marks one, so headers and sidebars don't count.
  const root = doc.querySelector("main,[role=main]") ?? doc;
  const nodes = root.querySelectorAll("h1,h2,h3,h4,p,[role=status]");
  for (let i = 0; i < nodes.length && i < 300; i++) {
    const text = nodes[i].textContent ?? "";
    if (text.length > 120 || !visible(nodes[i])) continue;
    const m = COUNT_TEXT.exec(text);
    if (m) return Number(m[1].replace(/\D/g, ""));
    if (NONE_TEXT.test(text)) return 0;
  }
  return null;
}

export { feedbackText } from "./text";
