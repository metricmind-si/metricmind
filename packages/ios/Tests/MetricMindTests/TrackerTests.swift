import Foundation
import XCTest
@testable import MetricMind

final class MemoryStore: KeyValueStore, @unchecked Sendable {
    var values: [String: String] = [:]
    func string(_ key: String) -> String? { values[key] }
    func set(_ value: String?, _ key: String) { values[key] = value }
}

final class FakeTransport: Transport, @unchecked Sendable {
    var status: Int? = 202
    var batches: [[String: Any]] = []
    var gets: [URL] = []
    var flags: [String: Any] = [:]
    func post(_ url: URL, body: Data) async -> Int? {
        if let status, status < 300 { batches.append(try! JSONSerialization.jsonObject(with: body) as! [String: Any]) }
        return status
    }
    func get(_ url: URL) async -> (Int, Data)? {
        gets.append(url)
        return (200, try! JSONSerialization.data(withJSONObject: ["flags": flags]))
    }
    var events: [[String: Any]] { batches.flatMap { $0["events"] as! [[String: Any]] } }
}

final class Clock: @unchecked Sendable {
    var date = Date(timeIntervalSince1970: 1_760_000_000)
    func advance(_ s: TimeInterval) { date = date.addingTimeInterval(s) }
}

final class TrackerTests: XCTestCase {
    let app = AppContext(platform: "ios", version: "3.0.0", build: "7", os_version: "18.1", device: "phone")

    func make(_ transport: FakeTransport, _ store: MemoryStore, _ clock: Clock) -> Tracker {
        Tracker(site: "site_123", app: app, transport: transport, store: store, now: { clock.date })
    }

    func testHelpers() {
        XCTAssertEqual(screenPath("Checkout"), "/Checkout")
        XCTAssertEqual(screenPath("Order details"), "/Order-details")
        XCTAssertEqual(screenPath("/Home/Feed"), "/Home/Feed")
        XCTAssertEqual(searchTerm("  Golf 7 "), "golf 7")
        XCTAssertNil(searchTerm("jean@example.com"))
        XCTAssertNil(searchTerm("06 12 34 56 78"))
    }

    func testScreensEventsAndOneBatchWithAppContext() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.viewport = "393x852"
        tracker.trackScreen("Home")
        c.advance(4)
        tracker.trackScreen("Checkout")
        tracker.track("purchase", props: ["plan": "pro", "amount": 49])
        tracker.contact("WhatsApp")
        tracker.search("velo electrique")
        await tracker.flush()
        XCTAssertEqual(t.batches.count, 1)
        let batch = t.batches[0]
        XCTAssertEqual(batch["site"] as? String, "site_123")
        XCTAssertEqual(batch["app"] as? [String: String], ["platform": "ios", "version": "3.0.0", "build": "7", "os_version": "18.1", "device": "phone"])
        let rows = t.events.map { [$0["type"] as! String, $0["path"] as! String, ($0["name"] as? String) ?? ""] }
        XCTAssertEqual(rows, [["pageview", "/Home", ""], ["exit", "/Home", ""], ["pageview", "/Checkout", ""], ["event", "/Checkout", "purchase"], ["event", "/Checkout", "contact"], ["event", "/Checkout", "search"]])
        XCTAssertEqual(t.events[1]["value"] as? Double, 4000)
        XCTAssertEqual((t.events[4]["props"] as? [String: String])?["channel"], "whatsapp")
        XCTAssertEqual(Set(t.events.compactMap { $0["session"] as? String }).count, 1)
        XCTAssertEqual(t.events[0]["viewport"] as? String, "393x852")
        // Event IDs are UUIDs in the wire format ingest validates.
        XCTAssertNotNil(UUID(uuidString: t.events[0]["id"] as! String))
    }

    func testContactsAndSearchesCarryContext() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.trackScreen("listing/[id]")
        tracker.contact("Phone", props: ["category": "cars", "channel": "spoofed"])
        tracker.search("Golf 7", results: 0, props: ["category": "cars"])
        tracker.search("velo", results: -1)
        await tracker.flush()
        let ev = t.events.filter { $0["type"] as? String == "event" }.map { $0["props"] as! [String: Any] }
        XCTAssertEqual(ev[0]["channel"] as? String, "phone")
        XCTAssertEqual(ev[0]["category"] as? String, "cars")
        XCTAssertEqual(ev[1]["term"] as? String, "golf 7")
        XCTAssertEqual(ev[1]["results"] as? Double, 0)
        XCTAssertEqual(ev[1]["category"] as? String, "cars")
        XCTAssertNil(ev[2]["results"])
    }

    func testNewSessionAfterThirtyIdleMinutesAndBackgroundEndsEngagedTime() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.trackScreen("Home")
        c.advance(10)
        tracker.background()
        c.advance(31 * 60)
        tracker.foreground()
        tracker.trackScreen("Search")
        await tracker.flush()
        XCTAssertEqual(t.events.first { $0["type"] as? String == "exit" }?["value"] as? Double, 10_000)
        let sessions = Set(t.events.filter { $0["type"] as? String == "pageview" }.compactMap { $0["session"] as? String })
        XCTAssertEqual(sessions.count, 2)
    }

    func testResumeWhileCountingKeepsTheTime() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.trackScreen("Home")
        c.advance(6)
        tracker.foreground()
        c.advance(1)
        tracker.background()
        await tracker.flush()
        XCTAssertEqual(t.events.filter { $0["type"] as? String == "exit" }.compactMap { $0["value"] as? Double }, [7000])
    }

    func testBackgroundTwiceEndsTheScreenOnce() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.trackScreen("Home")
        c.advance(5)
        tracker.background()
        tracker.background()
        await tracker.flush()
        XCTAssertEqual(t.events.filter { $0["type"] as? String == "exit" }.compactMap { $0["value"] as? Double }, [5000])
    }

    func testShortBackgroundContinuesAndThirtySecondsStartsANewSession() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.trackScreen("Home")
        c.advance(2)
        tracker.background()
        c.advance(10)
        tracker.foreground()
        c.advance(2)
        tracker.background()
        c.advance(45)
        tracker.foreground()
        tracker.track("after_return")
        await tracker.flush()
        let rows = t.events.map { [$0["type"] as! String, $0["path"] as! String] }
        XCTAssertEqual(rows, [["pageview", "/Home"], ["exit", "/Home"], ["exit", "/Home"], ["pageview", "/Home"], ["event", "/Home"]])
        let sessions = t.events.map { $0["session"] as! String }
        XCTAssertEqual(sessions[2], sessions[0])
        XCTAssertNotEqual(sessions[3], sessions[0])
        XCTAssertEqual(sessions[4], sessions[3])
    }

    func testRelaunchWithinThirtySecondsContinuesTheSession() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let first = make(t, s, c)
        first.trackScreen("Home")
        first.background()
        await first.flush()
        c.advance(5)
        let quick = make(t, s, c)
        quick.trackScreen("Home")
        await quick.flush()
        c.advance(60)
        let later = make(t, s, c)
        later.foreground() // a foreground notification can arrive before the first screen
        later.trackScreen("Home")
        await later.flush()
        let views = t.events.filter { $0["type"] as? String == "pageview" }.map { $0["session"] as! String }
        XCTAssertEqual(views[1], views[0])
        XCTAssertNotEqual(views[2], views[0])
    }

    func testFailedSendsStayQueuedAndSurviveRelaunch() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        t.status = 503
        let first = make(t, s, c)
        first.track("signup")
        await first.flush()
        XCTAssertEqual(first.pendingCount, 1)
        t.status = 202
        let relaunched = make(t, s, c)
        XCTAssertEqual(relaunched.pendingCount, 1)
        await relaunched.flush()
        XCTAssertEqual(t.events.compactMap { $0["name"] as? String }, ["signup"])
        XCTAssertEqual(relaunched.pendingCount, 0)
    }

    func testEventsQueuedBeforeAnUpdateKeepTheirRelease() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        t.status = 503
        let old = make(t, s, c)
        old.captureError("EXC_CRASH", fatal: true)
        await old.flush()
        t.status = 202
        let updated = Tracker(site: "site_123", app: AppContext(platform: "ios", version: "3.0.1", build: "8", os_version: "18.1", device: "phone"), transport: t, store: s, now: { c.date })
        updated.trackScreen("Home")
        await updated.flush()
        XCTAssertEqual(t.batches.map { ($0["app"] as! [String: String])["version"]! }, ["3.0.0", "3.0.1"])
        XCTAssertEqual(t.batches[0]["events"].map { ($0 as! [[String: Any]]).map { $0["type"] as! String } }, ["error"])
        XCTAssertTrue(t.events.allSatisfy { $0["app"] == nil })
    }

    func testInstallIdExpires13MonthsAfterItWasMade() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let a = make(t, s, c)
        let visitor = a.ids.visitor
        XCTAssertNotNil(s.string("mm_visitor_at"))
        c.advance(Tracker.visitorLifetime - 1)
        let b = make(t, s, c) // use doesn't extend it
        b.track("still")
        XCTAssertEqual(b.ids.visitor, visitor)
        c.advance(1)
        b.track("later") // a run that stays open past the limit changes too
        await b.flush()
        XCTAssertNotEqual(b.ids.visitor, visitor)
        XCTAssertEqual(s.string("mm_visitor"), b.ids.visitor)
        let still = t.events.first { $0["name"] as? String == "still" }, later = t.events.first { $0["name"] as? String == "later" }
        XCTAssertEqual(still?["visitor"] as? String, visitor)
        XCTAssertEqual(later?["visitor"] as? String, b.ids.visitor)
        XCTAssertNotEqual(still?["session"] as? String, later?["session"] as? String)
    }

    func testInstallIdWithoutADateCountsFromTheDayTheRuleShipped() {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        s.set("old-id", "mm_visitor")
        c.date = Date(timeIntervalSince1970: Tracker.visitorLegacyIssued + 86_400)
        XCTAssertEqual(make(t, s, c).ids.visitor, "old-id")
        XCTAssertEqual(s.string("mm_visitor_at").flatMap { Double($0) }, Tracker.visitorLegacyIssued)
        c.date = Date(timeIntervalSince1970: Tracker.visitorLegacyIssued + Tracker.visitorLifetime)
        XCTAssertNotEqual(make(t, s, c).ids.visitor, "old-id")
    }

    func testInstallIdSurvivesRelaunchIdentifyAndReset() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let a = make(t, s, c)
        let visitor = a.ids.visitor
        a.identify("user_42", traits: ["plan": "pro"])
        await a.flush()
        let b = make(t, s, c)
        XCTAssertEqual(b.ids.visitor, visitor)
        XCTAssertEqual(b.ids.user, "user_42")
        b.reset()
        XCTAssertNotEqual(b.ids.visitor, visitor)
        XCTAssertNil(b.ids.user)
        let identify = t.events.first { $0["name"] as? String == "$identify" }
        XCTAssertEqual(identify?["user"] as? String, "user_42")
    }

    func testCrashesAreFatalAndOptOutStopsEverything() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.captureError("EXC_BAD_ACCESS", fatal: true)
        await tracker.flush()
        XCTAssertEqual(t.events[0]["type"] as? String, "error")
        XCTAssertEqual((t.events[0]["props"] as? [String: Bool])?["fatal"], true)
        tracker.optOut()
        tracker.track("after")
        await tracker.flush()
        XCTAssertEqual(t.batches.count, 1)
        XCTAssertEqual(s.values["mm_optout"], "1")
        XCTAssertNil(s.values["mm_visitor"])
    }

    func testDisabledUntilConsentStoresAndSendsNothing() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        func waiting() -> Tracker { Tracker(site: "site_123", app: app, transport: t, store: s, now: { c.date }, enabled: false) }
        let tracker = waiting()
        XCTAssertFalse(tracker.isEnabled)
        tracker.trackScreen("Home")
        tracker.track("before_consent")
        await tracker.flush()
        XCTAssertTrue(t.batches.isEmpty)
        XCTAssertTrue(s.values.isEmpty)
        tracker.optIn()
        tracker.track("after_consent")
        await tracker.flush()
        XCTAssertEqual(t.events.compactMap { $0["name"] as? String }, ["after_consent"])
        let relaunched = waiting()
        XCTAssertTrue(relaunched.isEnabled)
        relaunched.optOut()
        XCTAssertFalse(waiting().isEnabled)
    }

    func testFlagsAreServerSideWithOneExposure() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        t.flags = ["new-checkout": ["enabled": true, "variant": "on"]]
        let tracker = make(t, s, c)
        let first = await tracker.flag("new-checkout")
        let again = await tracker.flag("new-checkout")
        let unknown = await tracker.flag("unknown")
        XCTAssertEqual(first, FlagResult(enabled: true, variant: "on"))
        XCTAssertEqual(again, first)
        XCTAssertEqual(unknown, .off)
        await tracker.flush()
        XCTAssertEqual(t.gets.count, 1)
        XCTAssertTrue(t.gets[0].absoluteString.hasPrefix("https://in.metricmind.si/v1/flags?site=site_123"))
        XCTAssertTrue(t.gets[0].absoluteString.contains("platform=ios"))
        XCTAssertEqual(t.events.filter { $0["name"] as? String == "$flag" }.count, 1)
    }

    func testFlagsNameTheEnvironmentOnlyWhenOneIsSet() async {
        let t = FakeTransport(), c = Clock()
        _ = await make(t, MemoryStore(), c).flags()
        _ = await Tracker(site: "site_123", app: app, transport: t, store: MemoryStore(), now: { c.date }, environment: "").flags()
        _ = await Tracker(site: "site_123", app: app, transport: t, store: MemoryStore(), now: { c.date }, environment: "staging").flags()
        XCTAssertEqual(t.gets.count, 3)
        func env(_ url: URL) -> String? { URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "env" }?.value }
        XCTAssertFalse(t.gets[0].absoluteString.contains("env="))
        XCTAssertFalse(t.gets[1].absoluteString.contains("env="))
        XCTAssertEqual(env(t.gets[2]), "staging")
    }

    func testAppStartIsAVitalAndImplausibleValuesAreDropped() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.appStart(milliseconds: 1840.4)
        tracker.appStart(milliseconds: -5)
        tracker.appStart(milliseconds: 500_000)
        await tracker.flush()
        XCTAssertEqual(t.events.count, 1)
        XCTAssertEqual(t.events[0]["type"] as? String, "vital")
        XCTAssertEqual(t.events[0]["name"] as? String, "APP_START")
        XCTAssertEqual(t.events[0]["value"] as? Double, 1840)
    }

    func testProcessStartIsInThePast() {
        let start = MetricMind.processStart()
        XCTAssertNotNil(start)
        XCTAssertLessThan(start!.timeIntervalSinceNow, 0)
    }

    func testCampaignFromLinks() {
        XCTAssertEqual(Campaign(url: URL(string: "myapp://listing/42?utm_source=newsletter&utm_medium=email&utm_campaign=Spring%20sale")!), try! JSONDecoder().decode(Campaign.self, from: #"{"source":"newsletter","medium":"email","campaign":"Spring sale"}"#.data(using: .utf8)!))
        XCTAssertEqual(Campaign(url: URL(string: "https://example.com/app?ref=producthunt")!)?.source, "producthunt")
        XCTAssertNil(Campaign(url: URL(string: "myapp://home?id=4")!))
        XCTAssertNil(Campaign(url: URL(string: "myapp://home")!))
    }

    func testCampaignLinkCreditsTheScreenItOpens() async throws {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.campaignWait = 0.01
        tracker.trackScreen("Home")
        c.advance(3)
        tracker.open(url: URL(string: "myapp://home?id=1")!)
        tracker.open(url: URL(string: "myapp://listing/42?utm_source=instagram&utm_campaign=launch")!)
        tracker.trackScreen("Listing")
        try await Task.sleep(nanoseconds: 100_000_000)
        await tracker.flush()
        let rows = t.events.map { [$0["type"] as! String, $0["path"] as! String, (($0["utm"] as? [String: String])?["source"]) ?? ""] }
        XCTAssertEqual(rows, [["pageview", "/Home", ""], ["exit", "/Home", ""], ["pageview", "/Listing", "instagram"]])
        let sessions = t.events.map { $0["session"] as! String }
        XCTAssertEqual(sessions[0], sessions[1])
        XCTAssertNotEqual(sessions[2], sessions[0])
    }

    func testCampaignLinkToTheShownScreenCountsItAgain() async throws {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.campaignWait = 0.01
        tracker.trackScreen("Home")
        tracker.open(url: URL(string: "myapp://home?utm_source=qr")!)
        try await Task.sleep(nanoseconds: 100_000_000)
        await tracker.flush()
        let rows = t.events.map { [$0["type"] as! String, $0["path"] as! String, (($0["utm"] as? [String: String])?["source"]) ?? ""] }
        XCTAssertEqual(rows, [["pageview", "/Home", ""], ["exit", "/Home", ""], ["pageview", "/Home", "qr"]])
    }

    func testColdStartLinkCreditsTheFirstScreen() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.open(url: URL(string: "myapp://x?utm_source=qr&utm_medium=print")!)
        tracker.trackScreen("Home")
        await tracker.flush()
        XCTAssertEqual(t.events[0]["utm"] as? [String: String], ["source": "qr", "medium": "print"])
    }

    enum CheckoutError: Error { case priceMissing }
    struct Readable: LocalizedError { var errorDescription: String? { "Card declined" } }

    func testErrorMessagesAreReadable() {
        XCTAssertEqual(MetricMind.errorMessage(CheckoutError.priceMissing), "CheckoutError.priceMissing")
        XCTAssertEqual(MetricMind.errorMessage(Readable()), "Readable: Card declined")
        XCTAssertEqual(MetricMind.errorMessage(NSError(domain: NSURLErrorDomain, code: -1001, userInfo: [NSLocalizedDescriptionKey: "The request timed out."])), "NSURLErrorDomain -1001: The request timed out.")
        XCTAssertEqual(MetricMind.errorMessage(URLError(.timedOut)), "NSURLErrorDomain -1001")
    }

    func testOSReportsCountAgainstTheRunThatProducedThem() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        // Run 1: build 7 (3.0.0), on the Checkout screen.
        let run1 = make(t, s, c)
        run1.recordRun()
        run1.trackScreen("Checkout")
        await run1.flush()
        let session1 = t.events[0]["session"] as! String
        c.advance(600)
        // Run 2, after an update to 3.0.1 (8): MetricKit delivers run 1's hang and crash.
        let run2 = Tracker(site: "site_123", app: AppContext(platform: "ios", version: "3.0.1", build: "8", os_version: "18.1", device: "phone"), transport: t, store: s, now: { c.date })
        run2.recordRun()
        run2.captureReport("App hang (2.4 s)", stack: "{}", fatal: false, kind: "hang", durationMs: 2412.6, build: "7", at: c.date.addingTimeInterval(-300))
        run2.captureReport("Crash (signal 11)", stack: nil, fatal: true, kind: "crash", build: "7", at: nil)
        run2.trackScreen("Home")
        await run2.flush()
        let reported = t.batches.last { ($0["events"] as! [[String: Any]]).contains { $0["type"] as? String == "error" } }!
        XCTAssertEqual((reported["app"] as! [String: String])["version"], "3.0.0")
        let errors = (reported["events"] as! [[String: Any]]).filter { $0["type"] as? String == "error" }
        XCTAssertEqual(errors.count, 2)
        XCTAssertEqual(errors.map { $0["path"] as! String }, ["/Checkout", "/Checkout"])
        XCTAssertEqual(errors.map { $0["session"] as! String }, [session1, session1])
        XCTAssertEqual((errors[0]["props"] as! [String: Any])["duration_ms"] as? Double, 2413)
        XCTAssertEqual((errors[0]["props"] as! [String: Any])["kind"] as? String, "hang")
        XCTAssertEqual(t.batches.last.flatMap { ($0["app"] as? [String: String])?["version"] }, "3.0.1") // today's screen
    }

    func testScreenReadyOncePerScreenView() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.trackScreen("Listing")
        c.advance(1.2)
        tracker.screenReady()
        tracker.screenReady()
        await tracker.flush()
        let vitals = t.events.filter { $0["type"] as? String == "vital" }
        XCTAssertEqual(vitals.count, 1)
        XCTAssertEqual(vitals[0]["name"] as? String, "SCREEN_READY")
        XCTAssertEqual(vitals[0]["value"] as? Double, 1200)
        XCTAssertEqual(vitals[0]["path"] as? String, "/Listing")
    }

    func testFeedback() async {
        XCTAssertEqual(feedbackText("Call me on 06 12 34 56 78 or jean.dupont@example.com  please"), "Call me on [phone] or [email] please")
        XCTAssertNil(feedbackText("   "))
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.trackScreen("Sell")
        tracker.feedback("Publishing keeps failing", rating: 2)
        tracker.feedback("Out of range rating", rating: 9)
        await tracker.flush()
        let fb = t.events.filter { $0["name"] as? String == "$feedback" }
        XCTAssertEqual(fb.count, 2)
        XCTAssertEqual((fb[0]["props"] as? [String: Any])?["rating"] as? Double, 2)
        XCTAssertNil((fb[1]["props"] as? [String: Any])?["rating"])
        XCTAssertEqual(fb[0]["path"] as? String, "/Sell")
    }

    func testFramesTravelWithTheScreenExit() async {
        let t = FakeTransport(), s = MemoryStore(), c = Clock()
        let tracker = make(t, s, c)
        tracker.trackScreen("Listing")
        tracker.recordFrames(600, slow: 12, frozen: 1)
        c.advance(5)
        tracker.trackScreen("Home")
        c.advance(1)
        tracker.background()
        await tracker.flush()
        let exits = t.events.filter { $0["type"] as? String == "exit" }
        XCTAssertEqual(exits[0]["props"] as? [String: Double], ["frames": 600, "slow": 12, "frozen": 1])
        XCTAssertNil(exits[1]["props"])
    }
}
