// mm.flagOverride(key, variant): a developer's test of a flag in one browser. Nothing leaves the browser: the
// server's answer is still fetched, and no exposure is sent for a flag that's overridden.

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;
type Result = { enabled: boolean; variant: string; payload?: unknown };

const KEY = "mm_fo";

export function readOverrides(store: Store): Record<string, string> {
  try {
    return JSON.parse(store?.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

/** A variant key, "on" or "off"; null clears it. */
export function setOverride(store: Store, key: string, variant: string | null) {
  const all = readOverrides(store);
  if (variant === null) delete all[key];
  else all[key] = String(variant);
  try {
    if (Object.keys(all).length) store?.setItem(KEY, JSON.stringify(all));
    else store?.removeItem(KEY);
  } catch {}
}

/** The server's answer with this browser's overrides on top; a payload stays only on the variant it belongs to. */
export function withOverrides<T extends Result>(flags: Record<string, T>, overrides: Record<string, string>): Record<string, Result> {
  const out: Record<string, Result> = { ...flags };
  for (const [key, variant] of Object.entries(overrides)) {
    out[key] = { enabled: variant !== "off", variant, ...(flags[key]?.variant === variant && flags[key].payload !== undefined ? { payload: flags[key].payload } : {}) };
  }
  return out;
}
