// The platform-independent core of the MetricMind Android SDK: identity,
// sessions, screens, the event queue and delivery. No Android imports, so it
// runs (and is tested) on the plain JVM; Android glue lives in MetricMind.kt.
package si.metricmind

import java.util.UUID
import kotlin.math.min
import kotlin.math.roundToLong

/** Sends HTTP requests. The Android default uses HttpURLConnection on a background thread. */
interface Transport {
    /** POSTs JSON; returns the HTTP status, or null on network failure. */
    fun post(url: String, body: String): Int?
    fun get(url: String): Pair<Int, String>?
}

/** Key/value storage for IDs and unsent events (SharedPreferences on Android). */
interface KeyValueStore {
    fun get(key: String): String?
    fun put(key: String, value: String?)
}

data class FlagResult(val enabled: Boolean, val variant: String) {
    companion object { val OFF = FlagResult(false, "off") }
}

/** Sent once per batch: which app and release the events come from. */
data class AppContext(val platform: String = "android", val version: String, val build: String? = null, val osVersion: String? = null, val device: String? = null)

/** "Checkout" → "/Checkout"; spaces become dashes (same rule as the other SDKs). */
fun screenPath(name: String): String {
    val clean = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString("-").trimStart('/').take(200)
    return "/" + clean.ifEmpty { "unknown" }
}

/** A link's utm_* campaign (ref= counts as the source, like on the website). */
data class Campaign(val source: String? = null, val medium: String? = null, val campaign: String? = null) {
    companion object {
        /** The campaign of a deep or app link, or null when it has none. */
        fun from(url: String): Campaign? {
            val query = url.substringBefore('#').substringAfter('?', "").ifEmpty { return null }
            val q = HashMap<String, String>()
            for (pair in query.split('&')) {
                val k = pair.substringBefore('='); val v = pair.substringAfter('=', "")
                runCatching { q.putIfAbsent(java.net.URLDecoder.decode(k, "UTF-8"), java.net.URLDecoder.decode(v, "UTF-8").trim().take(200)) }
            }
            fun value(name: String) = q[name]?.takeIf { it.isNotEmpty() }
            val c = Campaign(value("utm_source") ?: value("ref"), value("utm_medium"), value("utm_campaign"))
            return if (c.source == null && c.medium == null && c.campaign == null) null else c
        }
    }
}

/** A search term worth recording, or null: emails and phone numbers are never sent. */
fun searchTerm(raw: String): String? {
    val term = raw.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ").lowercase().take(100)
    if (term.isEmpty() || '@' in term || Regex("\\d[\\d\\s().-]{6,}\\d").containsMatchIn(term)) return null
    return term
}

/** A feedback message ready to send: at most 500 characters, emails and phone numbers replaced. */
fun feedbackText(raw: String): String? {
    val text = raw.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        .replace(Regex("[^\\s@]+@[^\\s@]+\\.[^\\s@]+"), "[email]")
        .replace(Regex("\\+?\\d[\\d\\s().-]{6,}\\d"), "[phone]")
        .take(500)
    return text.ifEmpty { null }
}

/** Minimal JSON writing: the SDK has no dependencies. */
internal object Json {
    fun str(s: String): String {
        val b = StringBuilder("\"")
        for (c in s) when {
            c == '"' -> b.append("\\\"")
            c == '\\' -> b.append("\\\\")
            c == '\n' -> b.append("\\n")
            c == '\r' -> b.append("\\r")
            c == '\t' -> b.append("\\t")
            c < ' ' -> b.append(String.format("\\u%04x", c.code))
            else -> b.append(c)
        }
        return b.append('"').toString()
    }

    fun value(v: Any?): String = when (v) {
        null -> "null"
        is Boolean -> v.toString()
        is Int, is Long -> v.toString()
        is Number -> v.toDouble().let { if (it.isFinite()) (if (it == it.roundToLong().toDouble()) it.roundToLong().toString() else it.toString()) else "null" }
        else -> str(v.toString())
    }

    fun obj(fields: Map<String, Any?>): String = fields.entries.filter { it.value != null }.joinToString(",", "{", "}") { (k, v) -> str(k) + ":" + (if (v is RawJson) v.json else value(v)) }

    /** Parses {"flags":{"key":{"enabled":true,"variant":"on"},…}}, the shape /v1/flags returns. */
    fun parseFlags(body: String): Map<String, FlagResult> {
        val out = mutableMapOf<String, FlagResult>()
        val entry = Regex("\"((?:[^\"\\\\]|\\\\.)*)\"\\s*:\\s*\\{([^{}]*)\\}")
        val flagsAt = body.indexOf("\"flags\"")
        if (flagsAt < 0) return out
        for (m in entry.findAll(body, flagsAt)) {
            val inner = m.groupValues[2]
            val enabled = Regex("\"enabled\"\\s*:\\s*(true|false)").find(inner)?.groupValues?.get(1) ?: continue
            val variant = Regex("\"variant\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(inner)?.groupValues?.get(1) ?: continue
            out[m.groupValues[1]] = FlagResult(enabled == "true", variant)
        }
        return out
    }
}

/** Already-serialized JSON inside Json.obj. */
internal class RawJson(val json: String)

private object Keys {
    const val VISITOR = "mm_visitor"; const val VISITOR_AT = "mm_visitor_at"; const val SESSION = "mm_session"; const val USER = "mm_user"
    const val QUEUE = "mm_queue"; const val OPT_OUT = "mm_optout"; const val OPT_IN = "mm_optin"; const val EXPOSED = "mm_exposed"
    const val RUNS = "mm_runs"; const val EXITS_SEEN = "mm_exits_seen"; const val SCREEN = "mm_screen"
}

/** The measurement core. Thread-safe: all state changes happen under one lock. */
class Tracker(
    private val site: String,
    @Volatile var app: AppContext,
    private val endpoint: String = DEFAULT_ENDPOINT,
    private val transport: Transport,
    private val store: KeyValueStore,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val locale: () -> String? = { java.util.Locale.getDefault().toLanguageTag() },
    private val timezone: () -> String? = { java.util.TimeZone.getDefault().id },
    /** Runs a task later (the campaign wait); a daemon timer by default. */
    private val schedule: (delayMs: Long, task: () -> Unit) -> Unit = { delay, task -> scheduler.schedule(object : java.util.TimerTask() { override fun run() { task() } }, delay) },
    /** false: record and store nothing until [optIn] (e.g. after consent); the choice is remembered. */
    enabled: Boolean = true,
    /** Which feature flags apply; null or empty serves flags without an environment. */
    private val environment: String? = null,
) {
    companion object {
        const val DEFAULT_ENDPOINT = "https://in.metricmind.si/v1/batch"
        const val SESSION_IDLE_MS = 30 * 60 * 1000L
        /** Back after this long in the background (or relaunched after it): a new session, as in the store consoles. */
        const val BACKGROUND_SESSION_MS = 30 * 1000L
        const val MAX_BATCH = 20
        const val MAX_QUEUE = 300
        /** How long a campaign link waits for the screen it opens before the current screen is counted again. */
        const val CAMPAIGN_WAIT_MS = 1000L
        /**
         * An install ID lasts 13 months from the day it was made, never extended by use (CNIL's recommendation for
         * audience measurement; 393 days is the shortest 13 calendar months can be).
         */
        const val VISITOR_LIFETIME_MS = 393 * 86_400_000L
        /** IDs from before this rule carry no date and count from the day it shipped (2026-11-02 UTC). */
        const val VISITOR_LEGACY_ISSUED = 1_793_577_600_000L
        private val scheduler by lazy { java.util.Timer("metricmind-campaign", true) }
    }

    private val lock = Any()
    @Volatile var viewport: String? = null
    private var visitor: String = store.get(Keys.VISITOR) ?: uuid()
    // No date, a broken one or one from the future: never a reason to keep an ID longer.
    private var visitorAt: Long = if (store.get(Keys.VISITOR) == null) now() else store.get(Keys.VISITOR_AT)?.toLongOrNull()?.takeIf { it in 1..now() } ?: VISITOR_LEGACY_ISSUED
    private var sessionId: String? = store.get(Keys.SESSION)?.substringBefore('|')
    private var sessionLast: Long = store.get(Keys.SESSION)?.substringAfter('|', "0")?.toLongOrNull() ?: 0
    // A launch is a return from the background.
    private var backgroundAt: Long? = if (sessionId != null) sessionLast else null
    private var user: String? = store.get(Keys.USER)
    // enabled = false waits for consent: nothing is stored or sent until optIn(), which is remembered.
    private var disabled = store.get(Keys.OPT_OUT) == "1" || (!enabled && store.get(Keys.OPT_IN) != "1")
    // Events a previous launch couldn't send, already serialized (one JSON object per line).
    private val queue: ArrayDeque<String> = ArrayDeque(store.get(Keys.QUEUE)?.lines()?.filter { it.isNotBlank() } ?: emptyList())
    private val exposed: MutableSet<String> = store.get(Keys.EXPOSED)?.split('\n')?.filter { it.isNotBlank() }?.toMutableSet() ?: mutableSetOf()
    private var screen: Screen? = null
    private var flushing = false
    private var flagsCache: Map<String, FlagResult>? = null
    private var pendingCampaign: Campaign? = null

    // Recent runs ("pid|startedAt|appJson"), so the OS's reports about an earlier run (ANRs, native
    // crashes, low-memory kills) are counted against the release and session that were running.
    private val runs: List<Triple<Int, Long, String>> = store.get(Keys.RUNS)?.lines()?.mapNotNull { line ->
        val parts = line.split('|', limit = 3)
        val pid = parts.getOrNull(0)?.toIntOrNull(); val at = parts.getOrNull(1)?.toLongOrNull(); val json = parts.getOrNull(2)
        if (pid != null && at != null && json != null) Triple(pid, at, json) else null
    } ?: emptyList()
    private val previousSession: String? = sessionId
    private val previousScreen: String? = store.get(Keys.SCREEN)

    private data class Screen(val path: String, val title: String, var since: Long?, var engaged: Long, val openedAt: Long = since ?: 0, var loaded: Boolean = false, var ready: Boolean = false, var frames: Long = 0, var slowFrames: Long = 0, var frozenFrames: Long = 0)

    init {
        if (!expireVisitor() && !disabled) saveVisitor()
    }

    private fun saveVisitor() {
        store.put(Keys.VISITOR, visitor)
        store.put(Keys.VISITOR_AT, visitorAt.toString())
    }

    /** A new install ID once the old one is 13 months old; it starts a new session, or one session would have two IDs. */
    private fun expireVisitor(): Boolean {
        val at = now()
        if (at - visitorAt < VISITOR_LIFETIME_MS) return false
        visitor = uuid()
        visitorAt = at
        sessionId = null
        flagsCache = null
        if (!disabled) saveVisitor()
        return true
    }

    private fun uuid() = UUID.randomUUID().toString()

    /** Session ID, rotated after 30 idle minutes (same rule as the website tracker). */
    private fun touchSession(at: Long): String {
        val away = backgroundAt?.let { at - it >= BACKGROUND_SESSION_MS } ?: false
        backgroundAt = null
        val id = sessionId?.takeIf { !away && at - sessionLast <= SESSION_IDLE_MS } ?: uuid()
        sessionId = id
        sessionLast = at
        store.put(Keys.SESSION, "$id|$at")
        return id
    }

    val ids: Triple<String, String?, String?> get() = synchronized(lock) { Triple(visitor, sessionId, user) }
    val pendingCount: Int get() = synchronized(lock) { queue.size }

    private fun emit(type: String, path: String? = null, title: String? = null, name: String? = null, value: Long? = null, props: Map<String, Any?>? = null, errorMessage: String? = null, errorStack: String? = null, utm: Campaign? = null, at: Long? = null, release: String? = null, session: String? = null) {
        if (disabled) return
        expireVisitor()
        val ts = at ?: now()
        if (utm != null) sessionId = null // a campaign visit is a new session
        val event = Json.obj(linkedMapOf(
            "id" to uuid(), "type" to type, "ts" to ts, "visitor" to visitor, "session" to (session ?: touchSession(ts)), "user" to user,
            "path" to (path ?: screen?.path ?: "/"), "title" to title, "name" to name, "value" to value,
            "props" to props?.let { RawJson(Json.obj(it.mapValues { (_, v) -> if (v == null) RawJson("null") else v })) },
            "error" to errorMessage?.let { RawJson(Json.obj(linkedMapOf("message" to it.take(500), "stack" to errorStack?.take(4000)))) },
            "utm" to utm?.let { RawJson(Json.obj(linkedMapOf("source" to it.source, "medium" to it.medium, "campaign" to it.campaign))) },
            "lang" to locale()?.take(35), "tz" to timezone()?.take(64), "viewport" to viewport,
        ))
        // Each queued line keeps the release that recorded it ("<app json>\t<event json>"; JSON escapes tabs),
        // so a crash saved before an update is still sent with the version that crashed.
        queue.addLast((release ?: appJson(app)) + "\t" + event)
        while (queue.size > MAX_QUEUE) queue.removeFirst()
        persist()
    }

    private fun appJson(a: AppContext) = Json.obj(linkedMapOf("platform" to a.platform, "version" to a.version, "build" to a.build, "os_version" to a.osVersion, "device" to a.device))

    private fun persist() = store.put(Keys.QUEUE, queue.joinToString("\n"))

    /** One screen view; ends the previous screen with its engaged time. Returns true when a batch is full. */
    fun trackScreen(name: String, props: Map<String, Any?>? = null): Boolean = synchronized(lock) {
        val path = screenPath(name)
        if (screen?.path == path) return@synchronized false
        endScreenLocked()
        screen = Screen(path, name.take(512), now(), 0)
        if (!disabled) store.put(Keys.SCREEN, path) // the screen an exit report of this run will point to
        emit("pageview", path = path, title = screen!!.title, props = props, utm = pendingCampaign)
        pendingCampaign = null
        queue.size >= MAX_BATCH
    }

    /**
     * A link opened the app. With utm_* parameters it starts a new session credited to
     * that campaign, whose entry is the screen the link opens. If no screen follows within
     * a second (a link to the screen already shown), the current screen is counted again.
     */
    fun openUrl(url: String) {
        val c = Campaign.from(url) ?: return
        val showing = synchronized(lock) {
            pendingCampaign = c
            screen != null
        }
        if (!showing) return
        schedule(CAMPAIGN_WAIT_MS) {
            val title = synchronized(lock) {
                val s = screen
                if (pendingCampaign !== c || s == null) return@synchronized null // the link's screen took it
                endScreenLocked()
                screen = null
                s.title
            }
            if (title != null) trackScreen(title)
        }
    }

    private fun endScreenLocked() {
        val s = screen ?: return
        if (s.since == null && s.engaged == 0L) return // already closed
        val engaged = s.engaged + (s.since?.let { now() - it } ?: 0)
        // Frames drawn while the screen was shown: slow (over one refresh interval) and frozen (over 700 ms).
        val frames = if (s.frames > 0) mapOf("frames" to s.frames, "slow" to s.slowFrames, "frozen" to s.frozenFrames) else null
        emit("exit", path = s.path, value = min(engaged, 86_400_000L), props = frames)
        s.since = null
        s.engaged = 0
        s.frames = 0; s.slowFrames = 0; s.frozenFrames = 0
    }

    /** App went to the background: close the screen's engaged time (the caller flushes). */
    fun background() = synchronized(lock) {
        endScreenLocked()
        if (backgroundAt == null) backgroundAt = now()
    }

    /** Back in the foreground: the current screen keeps counting. */
    fun foreground() = synchronized(lock) {
        val at = now()
        val s = screen
        val away = backgroundAt
        if (s != null && away != null && at - away >= BACKGROUND_SESSION_MS) {
            // Back after 30 s or more: a new session, whose entry is the screen the app returns to.
            s.since = at
            s.engaged = 0
            emit("pageview", path = s.path, title = s.title)
            return@synchronized
        }
        if (s == null) return@synchronized // launching: the first event decides whether it's a new session
        backgroundAt = null
        if (s.since == null) s.since = at
    }

    fun track(name: String, props: Map<String, Any?>? = null) {
        if (name.isEmpty()) return
        synchronized(lock) { emit("event", name = name.take(120), props = props) }
    }

    /** What a user tells you (your feedback form), with an optional 1–5 rating; linked to the session and release. */
    fun feedback(message: String, rating: Int? = null) {
        val text = feedbackText(message) ?: return
        track("\$feedback", if (rating != null && rating in 1..5) mapOf("message" to text, "rating" to rating) else mapOf("message" to text))
    }

    /** Call, WhatsApp, email or chat actions, counted like the website's automatic contact clicks. */
    /** [props] say what was contacted (mapOf("category" to "cars")); never the number or address. */
    fun contact(channel: String, props: Map<String, Any?> = emptyMap()) = track("contact", props + ("channel" to channel.lowercase().take(40)))

    /** What the user searched for. Emails and phone numbers are never sent. */
    /** [results]: how many results the search found, so searches that find nothing stand out. */
    fun search(term: String, results: Int? = null, props: Map<String, Any?> = emptyMap()) {
        val t = searchTerm(term) ?: return
        track("search", (props - "results") + ("term" to t) + (if (results != null && results >= 0) mapOf("results" to results) else emptyMap()))
    }

    /** Links this install to your user ID (after login). Traits are sent once; only pass what your privacy policy covers. */
    fun identify(id: String, traits: Map<String, Any?>? = null) {
        if (id.isEmpty()) return
        synchronized(lock) {
            val u = id.take(128)
            val changed = u != user
            user = u
            store.put(Keys.USER, u)
            if (changed) flagsCache = null
            if (changed || traits != null) emit("event", name = "\$identify", props = traits)
        }
    }

    /** Forgets the user (call on logout): new anonymous install ID and session. */
    fun reset() = synchronized(lock) {
        user = null
        visitor = uuid()
        visitorAt = now()
        sessionId = null
        flagsCache = null
        store.put(Keys.USER, null)
        if (!disabled) saveVisitor() // never stored without consent
        store.put(Keys.SESSION, null)
    }

    /** Records this run (call once per process) so later OS exit reports map back to this release. */
    fun startRun(pid: Int) = synchronized(lock) {
        if (disabled) return@synchronized
        val lines = (runs.map { "${it.first}|${it.second}|${it.third}" } + "$pid|${now()}|${appJson(app)}").takeLast(8)
        store.put(Keys.RUNS, lines.joinToString("\n"))
    }

    /**
     * An app exit the OS reported for an earlier run: an ANR, a native crash, or a low-memory kill while in the
     * foreground. Counted as a crash of the release that was running, at the time it happened, in that run's
     * session when it was the previous run.
     */
    fun captureExit(kind: String, message: String, stack: String?, atMs: Long, pid: Int) = synchronized(lock) {
        val run = runs.lastOrNull { it.first == pid && it.second <= atMs }
        val previous = run != null && run == runs.lastOrNull()
        val session = if (previous && previousSession != null) previousSession else uuid()
        emit("error", path = if (previous) previousScreen else null, props = mapOf("fatal" to true, "kind" to kind), errorMessage = message, errorStack = stack, at = atMs, release = run?.third, session = session)
    }

    /** Exit reports newer than this were already handled (the first run only records where history starts). */
    var exitsSeenUntil: Long?
        get() = store.get(Keys.EXITS_SEEN)?.toLongOrNull()
        set(value) = store.put(Keys.EXITS_SEEN, value?.toString())

    /** Cold start: process launch to the first screen, in milliseconds (sent once per launch by the glue). */
    fun appStart(milliseconds: Long) {
        if (milliseconds <= 0 || milliseconds >= 120_000) return
        synchronized(lock) { emit("vital", name = "APP_START", value = milliseconds) }
    }

    /** Warm start: the app's process was alive but its screen had to be recreated (sent by the glue). */
    fun appWarmStart(milliseconds: Long) {
        if (milliseconds <= 0 || milliseconds >= 60_000) return
        synchronized(lock) { emit("vital", name = "APP_WARM_START", value = milliseconds) }
    }

    /** Time to initial display of the current screen: opened to first frame drawn (once per screen view). */
    fun screenLoaded(milliseconds: Long) = synchronized(lock) {
        val s = screen ?: return@synchronized
        if (s.loaded || milliseconds < 0 || milliseconds >= 60_000) return@synchronized
        s.loaded = true
        emit("vital", name = "SCREEN_LOAD", value = milliseconds, path = s.path)
    }

    /** Adds rendered frames to the current screen (sent as totals with its exit). */
    fun recordFrames(frames: Long, slow: Long, frozen: Long) = synchronized(lock) {
        val s = screen ?: return@synchronized
        s.frames += frames; s.slowFrames += slow; s.frozenFrames += frozen
    }

    /** Time to full display: call when the current screen's content has loaded (once per screen view). */
    fun screenReady() = synchronized(lock) {
        val s = screen ?: return@synchronized
        val ms = now() - s.openedAt
        if (s.ready || ms < 0 || ms >= 60_000) return@synchronized
        s.ready = true
        emit("vital", name = "SCREEN_READY", value = ms, path = s.path)
    }

    /** An error you caught, or a crash (fatal). */
    fun captureError(message: String, stack: String? = null, fatal: Boolean = false) = synchronized(lock) {
        emit("error", props = mapOf("fatal" to fatal), errorMessage = message, errorStack = stack)
    }

    fun captureError(error: Throwable, fatal: Boolean = false) =
        captureError("${error.javaClass.simpleName}: ${error.message ?: ""}".trimEnd(':', ' '), error.stackTraceToString(), fatal)

    fun optOut() = synchronized(lock) {
        disabled = true
        queue.clear()
        listOf(Keys.QUEUE, Keys.VISITOR, Keys.VISITOR_AT, Keys.SESSION, Keys.USER).forEach { store.put(it, null) }
        store.put(Keys.OPT_IN, null)
        store.put(Keys.OPT_OUT, "1")
    }

    /** Starts (or resumes) measurement, e.g. after the user consents. Remembered across launches. */
    fun optIn() = synchronized(lock) {
        disabled = false
        store.put(Keys.OPT_OUT, null)
        store.put(Keys.OPT_IN, "1")
        saveVisitor()
    }

    /** Whether events are being recorded (false before consent with enabled = false, or after optOut). */
    val isEnabled: Boolean get() = synchronized(lock) { !disabled }

    /** Sends queued events (blocking: call off the main thread). Failed batches stay queued for the next try. */
    fun flush() {
        while (true) {
            val next = synchronized(lock) {
                if (disabled || flushing || queue.isEmpty()) return
                flushing = true
                // One release per batch. Lines from older SDK versions have no app part: the current release.
                fun appOf(line: String) = if ('\t' in line) line.substringBefore('\t') else appJson(app)
                val batchApp = appOf(queue.first())
                val batch = queue.take(MAX_BATCH).takeWhile { appOf(it) == batchApp }
                Pair("{\"site\":${Json.str(site)},\"app\":$batchApp,\"events\":[${batch.joinToString(",") { it.substringAfter('\t') }}]}", batch.size)
            }
            val status = try { transport.post(endpoint, next.first) } catch (_: Exception) { null }
            val keepGoing = synchronized(lock) {
                flushing = false
                // Network errors, 429 and 5xx: keep for later. Other 4xx: drop, retrying won't help.
                if (status == null || status >= 500 || status == 429) return@synchronized false
                repeat(min(next.second, queue.size)) { queue.removeFirst() }
                persist()
                true
            }
            if (!keepGoing) return
        }
    }

    /** All flags for this install, evaluated by MetricMind's servers (blocking; cached until identify/reset). */
    fun flags(): Map<String, FlagResult> {
        val (cached, query) = synchronized(lock) {
            if (disabled) return emptyMap()
            val q = buildList {
                add("site" to site); add("visitor" to visitor); add("path" to (screen?.path ?: "/")); add("platform" to app.platform)
                user?.let { add("user" to it) }
                if (!environment.isNullOrEmpty()) add("env" to environment)
            }.joinToString("&") { (k, v) -> "$k=${java.net.URLEncoder.encode(v, "UTF-8")}" }
            Pair(flagsCache, q)
        }
        if (cached != null) return cached
        val res = try { transport.get(endpoint.removeSuffix("/batch") + "/flags?" + query) } catch (_: Exception) { null }
        if (res == null || res.first != 200) return emptyMap()
        val flags = Json.parseFlags(res.second)
        synchronized(lock) { flagsCache = flags }
        return flags
    }

    /** One flag; off when unknown or unreachable. Records an exposure once so the dashboard can compare variants. */
    fun flag(key: String): FlagResult {
        val result = flags()[key] ?: return FlagResult.OFF
        val marker = "$key=${result.variant}"
        val isNew = synchronized(lock) { exposed.add(marker).also { if (it) store.put(Keys.EXPOSED, exposed.toList().takeLast(50).joinToString("\n")) } }
        if (isNew) track("\$flag", mapOf("flag" to key, "variant" to result.variant))
        return result
    }
}
