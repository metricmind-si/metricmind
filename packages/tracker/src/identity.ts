// Cookieless identity: a random visitor ID that lasts 13 months and a session ID, both
// in localStorage so every tab of the site shares them. A session ends after
// 30 idle minutes (sessionStorage would start a new session per tab, and a
// link opened in a new tab would then count as a new "Direct" visit).

export const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * 13 months from the day the ID was made, never extended by a visit (CNIL's recommendation for audience
 * measurement). 393 days is the shortest 13 calendar months can be, so an ID never outlives them.
 */
export const VISITOR_LIFETIME_MS = 393 * 24 * 60 * 60 * 1000;
/**
 * IDs from before this rule carry no date. They count from the day it shipped: treating them as new at their next
 * visit would extend them, and expiring them at once would make every returning visitor look new.
 */
export const VISITOR_LEGACY_ISSUED = Date.UTC(2026, 10, 2);

const VISITOR_KEY = "mm_vid";
const VISITOR_AT_KEY = "mm_vid_at";
const SESSION_KEY = "mm_sid";
const SESSION_SEEN_KEY = "mm_seen";
const USER_KEY = "mm_uid";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // RFC 4122 v4 fallback for older browsers.
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16),
  );
}

function read(store: Store | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function remove(store: Store | undefined, key: string) {
  try {
    store?.removeItem(key);
  } catch {}
}

function write(store: Store | undefined, key: string, value: string) {
  try {
    store?.setItem(key, value);
  } catch {
    // Storage can be full or blocked; identity then lives only in memory.
  }
}

export function visitorId(local: Store | undefined, now = Date.now()): string {
  let id = read(local, VISITOR_KEY);
  if (id) {
    let issued = Number(read(local, VISITOR_AT_KEY));
    // No date, a broken one or one from the future: never a reason to keep an ID longer.
    if (!(issued > 0 && issued <= now)) {
      issued = VISITOR_LEGACY_ISSUED;
      write(local, VISITOR_AT_KEY, String(issued));
    }
    if (now - issued < VISITOR_LIFETIME_MS) return id;
    // A new visitor starts a new visit, or one visit would have two visitors.
    remove(local, SESSION_KEY);
  }
  id = uuid();
  write(local, VISITOR_KEY, id);
  write(local, VISITOR_AT_KEY, String(now));
  return id;
}

/**
 * The session as it stands, without counting as activity. What's reported on leaving a page
 * (engaged time, late vitals) belongs to the visit it describes, however long the page was read.
 */
export function currentSession(session: Store | undefined): string {
  return read(session, SESSION_KEY) ?? touchSession(session);
}

/** Returns the current session, rotating it after SESSION_IDLE_MS of inactivity. */
export function touchSession(session: Store | undefined, now = Date.now()): string {
  const seen = Number(read(session, SESSION_SEEN_KEY) ?? 0);
  let id = read(session, SESSION_KEY);
  if (!id || now - seen >= SESSION_IDLE_MS) {
    id = uuid();
    write(session, SESSION_KEY, id);
  }
  write(session, SESSION_SEEN_KEY, String(now));
  return id;
}

/** The site's own user ID from mm.identify(), if any. */
export function userId(local: Store | undefined): string | undefined {
  return read(local, USER_KEY) ?? undefined;
}

export function setUserId(local: Store | undefined, id: string | null) {
  if (id) write(local, USER_KEY, id);
  else remove(local, USER_KEY);
}

export function clearIdentity(local: Store | undefined, session: Store | undefined) {
  for (const [store, key] of [
    [local, VISITOR_KEY],
    [local, VISITOR_AT_KEY],
    [local, USER_KEY],
    [local, SESSION_KEY],
    [local, SESSION_SEEN_KEY],
    // Older tracker versions kept the session per tab.
    [session, SESSION_KEY],
    [session, SESSION_SEEN_KEY],
  ] as const) remove(store, key);
}
