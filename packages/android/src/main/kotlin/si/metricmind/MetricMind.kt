// MetricMind for Android: cookieless screens, sessions, events, users, errors
// and crashes. Copy Tracker.kt and MetricMind.kt into your app (package
// si.metricmind), then in Application.onCreate():
//
//   MetricMind.init(this, site = "YOUR_SITE_ID")          // version and build read from the package
//   MetricMind.screen("Checkout")                         // or automatic: one screen per Activity
//   MetricMind.track("purchase", mapOf("plan" to "pro"))
//
// Campaigns: app links that open an Activity with utm_source / utm_medium / utm_campaign
// start a session credited to that campaign (read automatically from the launch intent;
// from onNewIntent call MetricMind.openUrl(intent.data)).
//
// Jetpack Navigation: navController.addOnDestinationChangedListener { _, d, _ -> MetricMind.screen(d.label?.toString() ?: d.route ?: "unknown") }
//
// Consent: MetricMind.init(this, site = "…", enabled = false) records nothing until MetricMind.optIn().
//
// Privacy: a random install ID in the app's SharedPreferences (no advertising
// ID, no fingerprinting). The IP address is used for the country and never stored.
package si.metricmind

import android.annotation.TargetApi
import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.ViewTreeObserver
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

object MetricMind {
    @Volatile private var tracker: Tracker? = null
    private var executor: ScheduledExecutorService? = null

    /**
     * Starts measurement. Call once in Application.onCreate().
     * With [enabled] false nothing is stored or sent until [optIn] (e.g. after consent); the choice is remembered.
     * [autoScreens] records one screen view per Activity (turn off for single-Activity Compose apps and call [screen]).
     * [environment] names which feature flags apply (it matches a flag's environment exactly); without one, flags with no environment are served.
     */
    @JvmStatic
    @JvmOverloads
    @Synchronized
    fun init(context: Context, site: String, appVersion: String? = null, build: String? = null, endpoint: String = Tracker.DEFAULT_ENDPOINT, autoScreens: Boolean = true, crashes: Boolean = true, enabled: Boolean = true, environment: String? = null): Tracker {
        tracker?.let { return it }
        val app = context.applicationContext as Application
        val prefs = app.getSharedPreferences("metricmind", Context.MODE_PRIVATE)
        val t = Tracker(site, appContext(app, appVersion, build), endpoint, HttpTransport(), PrefsStore(prefs), enabled = enabled, environment = environment)
        val metrics = app.resources.displayMetrics
        t.viewport = "${(metrics.widthPixels / metrics.density).toInt()}x${(metrics.heightPixels / metrics.density).toInt()}"
        tracker = t
        val ex = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "metricmind").apply { isDaemon = true } }
        executor = ex
        ex.scheduleWithFixedDelay({ runCatching { t.flush() } }, 2, 10, TimeUnit.SECONDS)
        app.registerActivityLifecycleCallbacks(Lifecycle(t, autoScreens) { flushSoon() })
        if (Build.VERSION.SDK_INT >= 24) app.registerActivityLifecycleCallbacks(FrameCounter(t))
        if (crashes) installCrashHandler(t, prefs)
        t.startRun(android.os.Process.myPid())
        if (crashes && Build.VERSION.SDK_INT >= 30) ex.execute { runCatching { reportExits(app, t) } }
        return t
    }

    private fun appContext(app: Application, version: String?, build: String?): AppContext {
        val info = runCatching { app.packageManager.getPackageInfo(app.packageName, 0) }.getOrNull()
        @Suppress("DEPRECATION")
        val code = info?.let { if (Build.VERSION.SDK_INT >= 28) it.longVersionCode.toString() else it.versionCode.toString() }
        val tablet = app.resources.configuration.smallestScreenWidthDp >= 600
        fun clean(s: String) = s.filter { it.isLetterOrDigit() || it in ".+-_" }.take(32)
        return AppContext(
            platform = "android",
            version = clean(version ?: info?.versionName ?: "0").ifEmpty { "0" },
            build = (build ?: code)?.let(::clean),
            osVersion = clean(Build.VERSION.RELEASE ?: "0"),
            device = if (tablet) "tablet" else "phone",
        )
    }

    /** Crashes are saved synchronously before the app dies and sent on the next launch. */
    private fun installCrashHandler(t: Tracker, prefs: SharedPreferences) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching {
                t.captureError(error, fatal = true)
                prefs.edit().commit() // flush pending apply() writes to disk now
            }
            previous?.uncaughtException(thread, error)
        }
    }

    /**
     * ANRs, native crashes and low-memory kills in the foreground, from the OS's record of how earlier runs ended
     * (Android 11+, the same source as Play Console). Java crashes are already caught by the crash handler.
     */
    @TargetApi(30)
    private fun reportExits(app: Application, t: Tracker) {
        val am = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val exits = am.getHistoricalProcessExitReasons(null, 0, 16)
        val newest = exits.maxOfOrNull { it.timestamp } ?: System.currentTimeMillis()
        val seen = t.exitsSeenUntil
        if (seen == null) { t.exitsSeenUntil = newest; return } // first run: earlier history isn't ours to report
        for (e in exits.filter { it.timestamp > seen }.sortedBy { it.timestamp }) {
            val kind = when (e.reason) {
                ApplicationExitInfo.REASON_ANR -> "anr"
                ApplicationExitInfo.REASON_CRASH_NATIVE -> "native_crash"
                ApplicationExitInfo.REASON_LOW_MEMORY -> if (e.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) "low_memory" else null
                else -> null
            } ?: continue
            val message = when (kind) {
                "anr" -> "ANR: " + (e.description?.removePrefix("user request after error: ") ?: "app not responding")
                "native_crash" -> "Native crash" + (e.description?.let { ": $it" } ?: "")
                else -> "Killed for low memory while in the foreground"
            }
            t.captureExit(kind, message, if (kind == "anr") mainThreadTrace(e) else null, e.timestamp, e.pid)
        }
        t.exitsSeenUntil = maxOf(seen, newest)
        t.flush()
    }

    /** The main thread's stack from an ANR's thread dump. */
    @TargetApi(30)
    private fun mainThreadTrace(e: ApplicationExitInfo): String? = runCatching {
        val text = e.traceInputStream?.bufferedReader()?.use { it.readText().take(500_000) } ?: return null
        val main = text.indexOf("\"main\"")
        if (main < 0) null else text.substring(main).substringBefore("\n\n").take(4000)
    }.getOrNull()

    private fun flushSoon() {
        val t = tracker ?: return
        executor?.execute { runCatching { t.flush() } }
    }

    /** One screen view (Compose / single-Activity apps). */
    @JvmStatic @JvmOverloads fun screen(name: String, props: Map<String, Any?>? = null) { if (tracker?.trackScreen(name, props) == true) flushSoon() }
    /** A link opened the app: utm_* parameters credit the session to that campaign (launch intents are read automatically). */
    @JvmStatic fun openUrl(uri: android.net.Uri?) { if (uri != null) tracker?.openUrl(uri.toString()) }
    @JvmStatic @JvmOverloads fun track(name: String, props: Map<String, Any?>? = null) = tracker?.track(name, props)
    /** Call, WhatsApp, email or chat actions, counted as contacts like the website's automatic contact clicks. */
    @JvmStatic @JvmOverloads fun contact(channel: String, props: Map<String, Any?> = emptyMap()) = tracker?.contact(channel, props)
    /** What a user tells you (your feedback form), with an optional 1–5 rating. Emails and phone numbers are removed. */
    @JvmStatic @JvmOverloads fun feedback(message: String, rating: Int? = null) = tracker?.feedback(message, rating)
    /** What the user searched for. Emails and phone numbers are never sent. */
    @JvmStatic @JvmOverloads fun search(term: String, results: Int? = null, props: Map<String, Any?> = emptyMap()) = tracker?.search(term, results, props)
    /** After login. Call [reset] on logout. */
    @JvmStatic @JvmOverloads fun identify(id: String, traits: Map<String, Any?>? = null) = tracker?.identify(id, traits)
    @JvmStatic fun reset() = tracker?.reset()
    @JvmStatic @JvmOverloads fun captureError(error: Throwable, fatal: Boolean = false) = tracker?.captureError(error, fatal)
    /** Call when the current screen's content has loaded (its data is on screen): records time to full display. */
    @JvmStatic fun screenReady() = tracker?.screenReady()
    /** A feature flag (blocking network call the first time: use from a background thread or coroutine). */
    @JvmStatic fun flag(key: String): FlagResult = tracker?.flag(key) ?: FlagResult.OFF
    /** IDs for checkout metadata (mm_visitor, mm_session, mm_user), so Stripe/Paddle revenue is attributed. */
    @JvmStatic fun ids() = tracker?.ids
    @JvmStatic fun optOut() = tracker?.optOut()
    @JvmStatic fun optIn() = tracker?.optIn()
    /** Whether events are being recorded (false before consent with enabled = false, or after optOut). */
    @JvmStatic fun isEnabled() = tracker?.isEnabled ?: false
}

/**
 * Foreground/background from Activity callbacks; optional automatic screen per Activity. Timings end at the
 * Activity's first drawn frame: cold start (process start → first frame), warm start (the process was alive but
 * the app's screen had to be recreated) and each automatic screen's time to initial display.
 */
private class Lifecycle(private val t: Tracker, private val autoScreens: Boolean, private val onBackground: () -> Unit) : Application.ActivityLifecycleCallbacks {
    private var started = 0
    private var startReported = false
    private var processHasShown = false
    private class Pending(val createdAt: Long, val warm: Boolean)
    private val pending = java.util.WeakHashMap<Activity, Pending>()

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        // Only the time here: the window isn't set up yet, so it's touched at the first resume.
        pending[activity] = Pending(SystemClock.uptimeMillis(), warm = processHasShown && started == 0)
        // A fresh launch from a link (not a restore): before the screen view, so it carries the campaign.
        if (savedInstanceState == null) activity.intent?.data?.let { t.openUrl(it.toString()) }
    }
    override fun onActivityStarted(activity: Activity) {
        if (started++ == 0) t.foreground()
    }
    override fun onActivityResumed(activity: Activity) {
        if (autoScreens) t.trackScreen(activity.title?.toString()?.takeIf { it.isNotBlank() } ?: activity.javaClass.simpleName)
        val p = pending.remove(activity) ?: return
        onFirstDraw(activity) { at ->
            if (!startReported && Build.VERSION.SDK_INT >= 24) {
                startReported = true
                // Android 13+: from when the launch was requested (includes creating the process, like Play Console).
                val start = if (Build.VERSION.SDK_INT >= 33) android.os.Process.getStartRequestedUptimeMillis() else android.os.Process.getStartUptimeMillis()
                t.appStart(at - start)
            } else if (p.warm) {
                t.appWarmStart(at - p.createdAt)
            }
            processHasShown = true
            if (autoScreens) t.screenLoaded(at - p.createdAt)
        }
    }
    override fun onActivityStopped(activity: Activity) {
        if (--started <= 0 && !activity.isChangingConfigurations) {
            started = 0
            t.background()
            onBackground()
        }
    }
    override fun onActivityPaused(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) { pending.remove(activity) }

    private fun onFirstDraw(activity: Activity, block: (Long) -> Unit) {
        val view = activity.window?.decorView ?: return
        val listener = object : ViewTreeObserver.OnDrawListener {
            var done = false
            override fun onDraw() {
                if (done) return
                done = true
                val at = SystemClock.uptimeMillis()
                view.post { view.viewTreeObserver.removeOnDrawListener(this) } // can't be removed while drawing
                block(at)
            }
        }
        view.viewTreeObserver.addOnDrawListener(listener)
    }
}

/**
 * Counts frames per Activity while it's in the foreground (Android 7+, FrameMetrics) and adds them to the current
 * screen in small batches: slow = longer than one refresh interval, frozen = longer than 700 ms.
 */
@TargetApi(24)
private class FrameCounter(private val t: Tracker) : Application.ActivityLifecycleCallbacks {
    private val thread by lazy { android.os.HandlerThread("metricmind-frames").apply { start() } }
    private val handler by lazy { android.os.Handler(thread.looper) }

    /** Frame counts of one Activity visit, filled on the frames thread and emptied by whoever reports them. */
    private class Counts {
        val frames = java.util.concurrent.atomic.AtomicLong()
        val slow = java.util.concurrent.atomic.AtomicLong()
        val frozen = java.util.concurrent.atomic.AtomicLong()
        fun drainTo(t: Tracker) {
            val f = frames.getAndSet(0)
            if (f > 0) t.recordFrames(f, slow.getAndSet(0), frozen.getAndSet(0))
        }
    }
    private val active = java.util.WeakHashMap<Activity, Pair<android.view.Window.OnFrameMetricsAvailableListener, Counts>>()

    override fun onActivityResumed(activity: Activity) {
        val window = activity.window ?: return
        @Suppress("DEPRECATION")
        val hz = (if (Build.VERSION.SDK_INT >= 30) activity.display?.refreshRate else activity.windowManager.defaultDisplay.refreshRate)?.takeIf { it >= 30f } ?: 60f
        val budgetNs = (1_000_000_000.0 / hz).toLong()
        val counts = Counts()
        val listener = android.view.Window.OnFrameMetricsAvailableListener { _, metrics, _ ->
            if (metrics.getMetric(android.view.FrameMetrics.FIRST_DRAW_FRAME) == 1L) return@OnFrameMetricsAvailableListener
            val ns = metrics.getMetric(android.view.FrameMetrics.TOTAL_DURATION)
            if (ns > budgetNs) counts.slow.incrementAndGet()
            if (ns > 700_000_000L) counts.frozen.incrementAndGet()
            if (counts.frames.incrementAndGet() >= 120) counts.drainTo(t)
        }
        active[activity] = listener to counts
        runCatching { window.addOnFrameMetricsAvailableListener(listener, handler) }
    }
    override fun onActivityPaused(activity: Activity) {
        // On the main thread, before the screen's exit or the next screen: the rest belongs to this screen.
        val (listener, counts) = active.remove(activity) ?: return
        runCatching { activity.window?.removeOnFrameMetricsAvailableListener(listener) }
        counts.drainTo(t)
    }
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}
}

private class PrefsStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String?) {
        prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }
}

private class HttpTransport : Transport {
    override fun post(url: String, body: String): Int? = request(url, "POST", body)?.first
    override fun get(url: String): Pair<Int, String>? = request(url, "GET", null)

    private fun request(url: String, method: String, body: String?): Pair<Int, String>? = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 10_000
        conn.readTimeout = 15_000
        conn.setRequestProperty("User-Agent", "metricmind-android/0.1 (Android ${Build.VERSION.RELEASE})")
        if (body != null) {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }
        val code = conn.responseCode
        val text = (if (code < 400) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        conn.disconnect()
        code to text
    } catch (_: Exception) {
        null
    }
}
