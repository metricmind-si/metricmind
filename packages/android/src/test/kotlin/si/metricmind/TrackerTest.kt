package si.metricmind

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MemoryStore : KeyValueStore {
    val values = mutableMapOf<String, String>()
    override fun get(key: String) = values[key]
    override fun put(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
}

class FakeTransport(var status: Int? = 202) : Transport {
    val bodies = mutableListOf<String>()
    val gets = mutableListOf<String>()
    var flagsBody = """{"flags":{}}"""
    override fun post(url: String, body: String): Int? { if ((status ?: 999) < 300) bodies += body; return status }
    override fun get(url: String): Pair<Int, String> { gets += url; return 200 to flagsBody }
}

class Clock(var ms: Long = 1_760_000_000_000) { fun advance(d: Long) { ms += d } }

private val app = AppContext("android", "2.4.1", "41", "14", "phone")
private fun make(t: FakeTransport, s: MemoryStore, c: Clock) = Tracker("site_123", app, transport = t, store = s, now = { c.ms }, locale = { "fr-MA" }, timezone = { "Africa/Casablanca" })

/** Pulls `"key":value` pairs out of the serialized events, in order, for assertions. */
private fun field(body: String, key: String) = Regex("\"$key\":(\"(?:[^\"\\\\]|\\\\.)*\"|[^,}]+)").findAll(body).map { it.groupValues[1].trim('"') }.toList()

fun helpers() {
    assertEquals("/Checkout", screenPath("Checkout"))
    assertEquals("/Order-details", screenPath("Order details"))
    assertEquals("/Home/Feed", screenPath("/Home/Feed"))
    assertEquals("golf 7", searchTerm("  Golf 7 "))
    assertNull(searchTerm("jean@example.com"))
    assertNull(searchTerm("06 12 34 56 78"))
    assertEquals("\"a\\\"b\\nc\"", Json.str("a\"b\nc"))
    assertEquals(mapOf("x" to FlagResult(true, "on"), "y" to FlagResult(false, "off")), Json.parseFlags("""{"flags":{"x":{"enabled":true,"variant":"on"},"y":{"variant":"off","enabled":false}}}"""))
}

fun screensEventsAndOneBatch() {
    val t = FakeTransport(); val s = MemoryStore(); val c = Clock()
    val tr = make(t, s, c)
    tr.viewport = "393x852"
    tr.trackScreen("Home")
    c.advance(4000)
    tr.trackScreen("Checkout")
    tr.track("purchase", mapOf("plan" to "pro", "amount" to 49))
    tr.contact("WhatsApp")
    tr.search("velo electrique")
    tr.flush()
    assertEquals(1, t.bodies.size)
    val b = t.bodies[0]
    assertTrue(b.startsWith("""{"site":"site_123","app":{"platform":"android","version":"2.4.1","build":"41","os_version":"14","device":"phone"},"events":["""), b)
    assertEquals(listOf("pageview", "exit", "pageview", "event", "event", "event"), field(b, "type"))
    assertEquals(listOf("/Home", "/Home", "/Checkout", "/Checkout", "/Checkout", "/Checkout"), field(b, "path"))
    assertEquals(listOf("purchase", "contact", "search"), field(b, "name"))
    assertEquals(listOf("4000"), field(b, "value"))
    assertTrue(b.contains("\"props\":{\"channel\":\"whatsapp\"}"))
    assertTrue(b.contains("\"amount\":49"))
    assertEquals(1, field(b, "session").toSet().size)
    assertEquals("393x852", field(b, "viewport").first())
    assertEquals("fr-MA", field(b, "lang").first())
    java.util.UUID.fromString(field(b, "id").first()) // throws if not a UUID
}

fun contactsAndSearchesCarryContext() {
    val t = FakeTransport(); val s = MemoryStore(); val c = Clock()
    val tr = make(t, s, c)
    tr.trackScreen("listing/[id]")
    tr.contact("Phone", mapOf("category" to "cars", "channel" to "spoofed"))
    tr.search("Golf 7", 0, mapOf("category" to "cars"))
    tr.search("velo", -1)
    tr.flush()
    val b = t.bodies[0]
    assertTrue(b.contains("\"props\":{\"category\":\"cars\",\"channel\":\"phone\"}"), b)
    assertTrue(b.contains("\"props\":{\"category\":\"cars\",\"term\":\"golf 7\",\"results\":0}"), b)
    assertTrue(b.contains("\"props\":{\"term\":\"velo\"}"), b)
}

fun sessionsAndBackground() {
    val t = FakeTransport(); val s = MemoryStore(); val c = Clock()
    val tr = make(t, s, c)
    tr.trackScreen("Home")
    c.advance(10_000)
    tr.background()
    c.advance(31 * 60_000L)
    tr.foreground()
    tr.trackScreen("Search")
    tr.flush()
    val b = t.bodies.joinToString()
    // Engaged time is the sum of a screen's exits (same as the website tracker).
    assertEquals(10_000L, field(b, "value").sumOf { it.toLong() })
    val types = field(b, "type"); val sessions = field(b, "session")
    assertEquals(2, types.indices.filter { types[it] == "pageview" }.map { sessions[it] }.toSet().size)
}

fun offlineQueueSurvivesRelaunch() {
    val t = FakeTransport(503); val s = MemoryStore(); val c = Clock()
    val first = make(t, s, c)
    first.track("signup")
    first.flush()
    assertEquals(1, first.pendingCount)
    t.status = 202
    val relaunched = make(t, s, c)
    assertEquals(1, relaunched.pendingCount)
    relaunched.flush()
    assertEquals(listOf("signup"), field(t.bodies.joinToString(), "name"))
    assertEquals(0, relaunched.pendingCount)
}

fun identityIdentifyReset() {
    val t = FakeTransport(); val s = MemoryStore(); val c = Clock()
    val a = make(t, s, c)
    val visitor = a.ids.first
    a.identify("user_42", mapOf("plan" to "pro"))
    a.flush()
    val b = make(t, s, c)
    assertEquals(visitor, b.ids.first)
    assertEquals("user_42", b.ids.third)
    b.reset()
    assertNotEquals(visitor, b.ids.first)
    assertNull(b.ids.third)
    assertTrue(t.bodies[0].contains("\"user\":\"user_42\""))
    assertTrue(t.bodies[0].contains("\"name\":\"\$identify\""))
}

fun crashesAndOptOut() {
    val t = FakeTransport(); val s = MemoryStore(); val c = Clock()
    val tr = make(t, s, c)
    tr.captureError(IllegalStateException("cart is null"), fatal = true)
    tr.flush()
    assertTrue(t.bodies[0].contains("\"props\":{\"fatal\":true}"))
    assertTrue(t.bodies[0].contains("\"message\":\"IllegalStateException: cart is null\""))
    tr.optOut()
    tr.track("after")
    tr.flush()
    assertEquals(1, t.bodies.size)
    assertEquals("1", s.values["mm_optout"])
    assertNull(s.values["mm_visitor"])
}

fun flagsNameTheEnvironmentOnlyWhenOneIsSet() {
    val t = FakeTransport(); val c = Clock()
    make(t, MemoryStore(), c).flags()
    Tracker("site_123", app, transport = t, store = MemoryStore(), now = { c.ms }, environment = "").flags()
    Tracker("site_123", app, transport = t, store = MemoryStore(), now = { c.ms }, environment = "staging").flags()
    assertEquals(3, t.gets.size)
    assertFalse(t.gets[0].contains("env="), t.gets[0])
    assertFalse(t.gets[1].contains("env="), t.gets[1])
    assertTrue(t.gets[2].endsWith("&env=staging"), t.gets[2])
}

fun flagsWithOneExposure() {
    val t = FakeTransport(); val s = MemoryStore(); val c = Clock()
    t.flagsBody = """{"flags":{"new-checkout":{"enabled":true,"variant":"on"}}}"""
    val tr = make(t, s, c)
    assertEquals(FlagResult(true, "on"), tr.flag("new-checkout"))
    assertEquals(FlagResult(true, "on"), tr.flag("new-checkout"))
    assertEquals(FlagResult.OFF, tr.flag("unknown"))
    tr.flush()
    assertEquals(1, t.gets.size)
    assertTrue(t.gets[0].startsWith("https://in.metricmind.si/v1/flags?site=site_123"), t.gets[0])
    assertTrue(t.gets[0].contains("platform=android"))
    assertEquals(1, field(t.bodies.joinToString(), "name").count { it == "\$flag" })
}

fun appStartVital() {
    val t = FakeTransport(); val s = MemoryStore(); val c = Clock()
    val tr = make(t, s, c)
    tr.appStart(1840)
    tr.appStart(-5)
    tr.appStart(500_000)
    tr.flush()
    val b = t.bodies.joinToString()
    assertEquals(listOf("vital"), field(b, "type"))
    assertEquals(listOf("APP_START"), field(b, "name"))
    assertEquals(listOf("1840"), field(b, "value"))
}

fun campaigns() {
    assertEquals(Campaign("newsletter", "email", "Spring sale"), Campaign.from("myapp://listing/42?utm_source=newsletter&utm_medium=email&utm_campaign=Spring%20sale#top"))
    assertEquals(Campaign("producthunt"), Campaign.from("https://example.com/app?ref=producthunt"))
    assertEquals(null, Campaign.from("myapp://home?id=4"))
    assertEquals(null, Campaign.from("myapp://home"))
    assertEquals(Campaign(medium = "cpc"), Campaign.from("myapp://x?utm_source=%E0%A4%A&utm_medium=cpc"))

    // The link's screen takes the campaign; the delayed recount then does nothing.
    val later = mutableListOf<() -> Unit>()
    val t = FakeTransport(); val c = Clock()
    val tr = Tracker("site_123", app, transport = t, store = MemoryStore(), now = { c.ms }, locale = { "fr-MA" }, timezone = { "Africa/Casablanca" }, schedule = { _, task -> later += task })
    tr.trackScreen("Home")
    c.advance(3000)
    tr.openUrl("myapp://home?id=1")
    tr.openUrl("myapp://listing/42?utm_source=instagram&utm_campaign=launch")
    tr.trackScreen("Listing")
    later.forEach { it() }
    tr.flush()
    val b = t.bodies.joinToString()
    assertEquals(listOf("pageview", "exit", "pageview"), field(b, "type"))
    assertEquals(listOf("/Home", "/Home", "/Listing"), field(b, "path"))
    assertTrue(b.contains("\"utm\":{\"source\":\"instagram\",\"campaign\":\"launch\"}"))
    val sessions = field(b, "session")
    assertEquals(sessions[0], sessions[1]); assertTrue(sessions[2] != sessions[0])

    // A link to the screen already shown: counted again once the wait is over.
    val later3 = mutableListOf<() -> Unit>()
    val t3 = FakeTransport()
    val tr3 = Tracker("site_123", app, transport = t3, store = MemoryStore(), now = { c.ms }, schedule = { _, task -> later3 += task })
    tr3.trackScreen("Home")
    tr3.openUrl("myapp://home?utm_source=qr")
    later3.forEach { it() }
    tr3.flush()
    assertEquals(listOf("/Home", "/Home", "/Home"), field(t3.bodies.joinToString(), "path"))
    assertTrue(t3.bodies.joinToString().contains("\"utm\":{\"source\":\"qr\"}"))

    val t2 = FakeTransport(); val tr2 = make(t2, MemoryStore(), Clock())
    tr2.openUrl("myapp://x?utm_source=qr&utm_medium=print")
    tr2.trackScreen("Home")
    tr2.flush()
    assertTrue(t2.bodies[0].contains("\"utm\":{\"source\":\"qr\",\"medium\":\"print\"}"))
}

fun backgroundTwiceEndsOnce() {
    val t = FakeTransport(); val c = Clock()
    val tr = make(t, MemoryStore(), c)
    tr.trackScreen("Home")
    c.advance(5000)
    tr.background()
    tr.background()
    tr.flush()
    assertEquals(listOf("5000"), field(t.bodies.joinToString(), "value"))
}

fun resumeWhileCountingKeepsTime() {
    val t = FakeTransport(); val c = Clock()
    val tr = make(t, MemoryStore(), c)
    tr.trackScreen("Home")
    c.advance(6000)
    tr.foreground()
    c.advance(1000)
    tr.background()
    tr.flush()
    assertEquals(listOf("7000"), field(t.bodies.joinToString(), "value"))
}

fun queuedEventsKeepTheirRelease() {
    val t = FakeTransport(); val s = MemoryStore(); val c = Clock()
    t.status = 503
    val old = make(t, s, c)
    old.captureError("NullPointerException", fatal = true)
    old.flush()
    t.status = 202
    val updated = Tracker("site_123", AppContext(version = "2.4.2", build = "42"), transport = t, store = s, now = { c.ms })
    updated.trackScreen("Home")
    updated.flush()
    assertEquals(2, t.bodies.size)
    assertTrue(t.bodies[0].contains("\"version\":\"2.4.1\"") && t.bodies[0].contains("\"type\":\"error\""))
    assertTrue(t.bodies[1].contains("\"version\":\"2.4.2\"") && t.bodies[1].contains("\"type\":\"pageview\""))
    assertTrue(t.bodies.none { '\t' in it })
    // A queue saved by an older SDK (no app part) still sends, with the current release.
    val s2 = MemoryStore(); s2.put("mm_queue", "{\"id\":\"x\",\"type\":\"event\",\"name\":\"legacy\"}")
    val t2 = FakeTransport()
    Tracker("site_123", app, transport = t2, store = s2).flush()
    assertTrue(t2.bodies.single().contains("\"name\":\"legacy\"") && t2.bodies.single().contains("\"version\":\"2.4.1\""))
}

fun consentMode() {
    val t = FakeTransport(); val s = MemoryStore(); val c = Clock()
    fun waiting() = Tracker("site_123", app, transport = t, store = s, now = { c.ms }, enabled = false)
    val tr = waiting()
    assertTrue(!tr.isEnabled)
    tr.trackScreen("Home"); tr.track("before_consent"); tr.reset()
    tr.flush()
    assertTrue(t.bodies.isEmpty())
    assertTrue(s.get("mm_visitor") == null && s.get("mm_queue").isNullOrEmpty())
    tr.optIn()
    tr.track("after_consent")
    tr.flush()
    assertEquals(listOf("after_consent"), field(t.bodies.joinToString(), "name"))
    val relaunched = waiting()
    assertTrue(relaunched.isEnabled)
    relaunched.optOut()
    assertTrue(!waiting().isEnabled)
}

fun mobileSessions() {
    val t = FakeTransport(); val s = MemoryStore(); val c = Clock()
    val tr = make(t, s, c)
    tr.trackScreen("Home")
    c.advance(2000); tr.background(); c.advance(10_000); tr.foreground()
    c.advance(2000); tr.background(); c.advance(45_000); tr.foreground()
    tr.track("after_return")
    tr.flush()
    val b = t.bodies.joinToString()
    assertEquals(listOf("pageview", "exit", "exit", "pageview", "event"), field(b, "type"))
    val sessions = field(b, "session")
    assertEquals(sessions[0], sessions[2]); assertTrue(sessions[3] != sessions[0]); assertEquals(sessions[3], sessions[4])
    // Relaunch within 30 s continues, later starts a new session.
    val t2 = FakeTransport(); val s2 = MemoryStore(); val c2 = Clock()
    make(t2, s2, c2).apply { trackScreen("Home"); background(); flush() }
    c2.advance(5000); make(t2, s2, c2).apply { trackScreen("Home"); flush() }
    c2.advance(60_000); make(t2, s2, c2).apply { foreground(); trackScreen("Home"); flush() } // Android: foreground arrives before the first screen
    val b2 = t2.bodies.joinToString(); val types = field(b2, "type"); val ss = field(b2, "session")
    val views = types.indices.filter { types[it] == "pageview" }.map { ss[it] }
    assertEquals(views[0], views[1]); assertTrue(views[2] != views[0])
}

fun exitsCountAgainstTheRunThatEnded() {
    val t = FakeTransport(); val s = MemoryStore(); val c = Clock()
    // Run 1: release 2.4.1, pid 4242, a session, then the OS kills it with an ANR.
    val run1 = make(t, s, c)
    run1.startRun(4242)
    run1.trackScreen("Messages")
    run1.flush()
    val anrAt = c.ms + 5000
    c.advance(60_000)
    // Run 2, after an update to 2.4.2: the OS reports run 1's ANR.
    val run2 = Tracker("site_123", AppContext(version = "2.4.2", build = "42"), transport = t, store = s, now = { c.ms })
    run2.startRun(5151)
    run2.captureExit("anr", "ANR: Input dispatching timed out", "\"main\" prio=5", anrAt, 4242)
    run2.trackScreen("Home")
    run2.flush()
    val anrBatch = t.bodies.first { it.contains("\"kind\":\"anr\"") }
    assertTrue(anrBatch.contains("\"version\":\"2.4.1\""))
    assertTrue(anrBatch.contains("\"fatal\":true"))
    assertTrue(anrBatch.contains("\"ts\":$anrAt"))
    val firstSession = field(t.bodies[0], "session").first()
    assertEquals(firstSession, field(anrBatch, "session").first()) // the session that hung, not today's
    assertTrue(anrBatch.contains("\"path\":\"/Messages\"")) // the screen it hung on
    // An exit from an unknown process still counts, with the current release.
    run2.captureExit("native_crash", "Native crash: SIGSEGV", null, c.ms - 1000, 1)
    run2.flush()
    assertTrue(t.bodies.last().contains("\"version\":\"2.4.2\"") && t.bodies.last().contains("native_crash"))
}

fun screenTimings() {
    val t = FakeTransport(); val c = Clock()
    val tr = make(t, MemoryStore(), c)
    tr.trackScreen("Listing")
    tr.screenLoaded(180)
    tr.screenLoaded(999) // once per screen view
    c.advance(1200)
    tr.screenReady()
    tr.screenReady()
    tr.appWarmStart(640)
    tr.trackScreen("Home")
    c.advance(70_000)
    tr.screenReady() // implausible: dropped
    tr.flush()
    val b = t.bodies.joinToString()
    val types = field(b, "type"); val names = field(b, "name"); val values = field(b, "value"); val paths = field(b, "path")
    val vitals = types.indices.filter { types[it] == "vital" }.map { Triple(names.getOrNull(names.size - types.size + it) ?: "", 0, paths[it]) }
    assertTrue(b.contains("\"name\":\"SCREEN_LOAD\"") && b.contains("\"value\":180"))
    assertTrue(b.contains("\"name\":\"SCREEN_READY\"") && b.contains("\"value\":1200"))
    assertTrue(b.contains("\"name\":\"APP_WARM_START\"") && b.contains("\"value\":640"))
    assertEquals(1, Regex("SCREEN_LOAD").findAll(b).count())
    assertEquals(1, Regex("SCREEN_READY").findAll(b).count())
    assertTrue(vitals.all { it.third == "/Listing" })
}

fun feedbackMessages() {
    assertEquals("Call me on [phone] or [email] please", feedbackText("Call me on 06 12 34 56 78 or jean.dupont@example.com  please"))
    assertEquals(null, feedbackText("   "))
    val t = FakeTransport()
    val tr = make(t, MemoryStore(), Clock())
    tr.trackScreen("Sell")
    tr.feedback("Publishing keeps failing", rating = 2)
    tr.feedback("Bad rating ignored", rating = 9)
    tr.flush()
    val b = t.bodies.joinToString()
    assertTrue(b.contains("\"name\":\"\$feedback\"") && b.contains("\"message\":\"Publishing keeps failing\"") && b.contains("\"rating\":2"))
    assertTrue(!b.contains("\"rating\":9"))
}

fun installIdExpires() {
    val t = FakeTransport(); val s = MemoryStore(); val c = Clock()
    val a = make(t, s, c)
    val visitor = a.ids.first
    assertTrue(s.get("mm_visitor_at") != null)
    c.advance(Tracker.VISITOR_LIFETIME_MS - 1000)
    val b = make(t, s, c) // use doesn't extend it
    b.track("still")
    assertEquals(visitor, b.ids.first)
    c.advance(1000)
    b.track("later") // a run that stays open past the limit changes too
    b.flush()
    assertNotEquals(visitor, b.ids.first)
    assertEquals(b.ids.first, s.get("mm_visitor"))
    val sent = field(t.bodies.joinToString(), "visitor")
    assertEquals(listOf(visitor, b.ids.first), sent)
    val sessions = field(t.bodies.joinToString(), "session")
    assertNotEquals(sessions[0], sessions[1])
    // An ID from before the rule keeps going, counted from the day it shipped, and a relaunch doesn't extend it.
    val old = MemoryStore(); old.put("mm_visitor", "old-id")
    val clock = Clock(Tracker.VISITOR_LEGACY_ISSUED + 86_400_000)
    assertEquals("old-id", make(t, old, clock).ids.first)
    assertEquals(Tracker.VISITOR_LEGACY_ISSUED.toString(), old.get("mm_visitor_at"))
    clock.ms = Tracker.VISITOR_LEGACY_ISSUED + Tracker.VISITOR_LIFETIME_MS
    assertNotEquals("old-id", make(t, old, clock).ids.first)
}

fun framesOnExit() {
    val t = FakeTransport(); val c = Clock()
    val tr = make(t, MemoryStore(), c)
    tr.trackScreen("Listing")
    tr.recordFrames(120, 6, 0)
    tr.recordFrames(30, 4, 1)
    c.advance(3000)
    tr.trackScreen("Home") // ends Listing with its frame totals
    c.advance(1000)
    tr.background() // Home: no frames recorded, no frame props
    tr.flush()
    val b = t.bodies.joinToString()
    assertTrue(b.contains("\"props\":{\"frames\":150,\"slow\":10,\"frozen\":1}"))
    assertEquals(1, Regex("\"frames\"").findAll(b).count())
}

fun main() {
    val tests = listOf(::installIdExpires, ::framesOnExit, ::feedbackMessages, ::screenTimings, ::exitsCountAgainstTheRunThatEnded, ::mobileSessions, ::consentMode, ::queuedEventsKeepTheirRelease, ::resumeWhileCountingKeepsTime, ::backgroundTwiceEndsOnce, ::campaigns, ::appStartVital, ::helpers, ::screensEventsAndOneBatch, ::contactsAndSearchesCarryContext, ::sessionsAndBackground, ::offlineQueueSurvivesRelaunch, ::identityIdentifyReset, ::crashesAndOptOut, ::flagsWithOneExposure, ::flagsNameTheEnvironmentOnlyWhenOneIsSet)
    var failed = 0
    for (t in tests) {
        try { t(); println("pass ${t.name}") } catch (e: Throwable) { failed++; println("FAIL ${t.name}: ${e.message}") }
    }
    println("${tests.size - failed} passed, $failed failed")
    if (failed > 0) kotlin.system.exitProcess(1)
}
