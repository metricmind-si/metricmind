// MetricMind for iOS: cookieless screens, sessions, events, users, errors and
// crashes. Add the package, then call `MetricMind.configure(site:)` at launch.
//
//   MetricMind.configure(site: "YOUR_SITE_ID")          // app version and build read from Info.plist
//   Text("Checkout").trackScreen("Checkout")            // SwiftUI
//   MetricMind.screen("Checkout")                       // UIKit (viewDidAppear)
//   MetricMind.track("purchase", props: ["plan": "pro"])
//   .onOpenURL { MetricMind.open(url: $0) }              // campaigns: links with utm_* start a credited session
//
// Consent: MetricMind.configure(site:, enabled: false) records nothing until MetricMind.optIn().
//
// Privacy: a random install ID in the app's own storage (no IDFA, no
// fingerprinting). The IP address is used for the country and never stored.
import Foundation
#if canImport(UIKit)
import UIKit
#endif
#if canImport(SwiftUI)
import SwiftUI
#endif
#if canImport(MetricKit) && os(iOS)
import MetricKit
#endif

public enum MetricMind {
    nonisolated(unsafe) private static var tracker: Tracker?
    private static let setupLock = NSLock()

    /// Starts measurement. Call once, as early as possible (App init or application(_:didFinishLaunchingWithOptions:)).
    @discardableResult
    /// With `enabled: false` nothing is stored or sent until `optIn()` (e.g. after consent); the choice is remembered.
    /// `environment` names which feature flags apply (it matches a flag's environment exactly); without one, flags with no environment are served.
    public static func configure(site: String, appVersion: String? = nil, build: String? = nil, endpoint: URL = Tracker.defaultEndpoint, crashes: Bool = true, enabled: Bool = true, environment: String? = nil) -> Tracker {
        setupLock.locked {
            if let tracker { return tracker }
            let info = Bundle.main.infoDictionary ?? [:]
            let version = appVersion ?? info["CFBundleShortVersionString"] as? String ?? "0"
            let buildNumber = build ?? info["CFBundleVersion"] as? String
            let t = Tracker(site: site, app: currentApp(version: version, build: buildNumber), endpoint: endpoint, enabled: enabled, environment: environment)
            tracker = t
            t.recordRun()
            Lifecycle.install(t, crashes: crashes)
            Task { await t.flush() } // anything a previous launch couldn't send
            return t
        }
    }

    static func currentApp(version: String, build: String?) -> AppContext {
        func clean(_ s: String) -> String { String(s.filter { $0.isLetter || $0.isNumber || ".+-_".contains($0) }.prefix(32)) }
        #if canImport(UIKit) && !os(watchOS)
        let device = UIDevice.current
        return AppContext(platform: "ios", version: clean(version).isEmpty ? "0" : clean(version), build: build.map(clean), os_version: clean(device.systemVersion), device: device.userInterfaceIdiom == .pad ? "tablet" : "phone")
        #else
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return AppContext(platform: "ios", version: clean(version).isEmpty ? "0" : clean(version), build: build.map(clean), os_version: "\(v.majorVersion).\(v.minorVersion)", device: "phone")
        #endif
    }

    nonisolated(unsafe) private static var startReported = false

    /// One screen view. SwiftUI: prefer `.trackScreen("Name")`.
    public static func screen(_ name: String, props: Props? = nil) {
        guard let tracker else { return }
        #if canImport(UIKit) && !os(watchOS)
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                if tracker.viewport == nil { readViewport(tracker) }
                FrameMonitor.drain() // frames so far belong to the screen being left
            }
        }
        #endif
        tracker.trackScreen(name, props: props)
        // The first screen of a launch: report the cold start (process launch → first screen).
        if !startReported, let started = processStart() {
            startReported = true
            tracker.appStart(milliseconds: Date().timeIntervalSince(started) * 1000)
        }
    }

    /// When the process was launched, from the kernel (no private API).
    static func processStart() -> Date? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return nil }
        let t = info.kp_proc.p_un.__p_starttime
        return Date(timeIntervalSince1970: Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000)
    }
    public static func track(_ name: String, props: Props? = nil) { tracker?.track(name, props: props) }
    /// Call when the current screen's content has loaded (its data is on screen): records time to full display.
    public static func screenReady() { tracker?.screenReady() }
    /// A link opened the app (SwiftUI `.onOpenURL`, `scene(_:openURLContexts:)` or a universal link's `webpageURL`).
    /// With utm_source / utm_medium / utm_campaign the session is credited to that campaign.
    public static func open(url: URL) { tracker?.open(url: url) }
    /// Call, WhatsApp, email or chat actions, counted as contacts like the website's automatic contact clicks.
    /// Props say what was contacted, e.g. `["category": "cars"]`, so contacts break down by it.
    public static func contact(_ channel: String, props: Props = [:]) { tracker?.contact(channel, props: props) }
    /// What a user tells you (your feedback form), with an optional 1–5 rating. Emails and phone numbers are removed.
    public static func feedback(_ message: String, rating: Int? = nil) { tracker?.feedback(message, rating: rating) }
    /// What the user searched for. Emails and phone numbers are never sent.
    /// Pass `results` once known, so searches that find nothing stand out.
    public static func search(_ term: String, results: Int? = nil, props: Props = [:]) { tracker?.search(term, results: results, props: props) }
    /// After login. Call `reset()` on logout.
    public static func identify(_ id: String, traits: Props? = nil) { tracker?.identify(id, traits: traits) }
    public static func reset() { tracker?.reset() }
    public static func captureError(_ error: Error, fatal: Bool = false) {
        tracker?.captureError(errorMessage(error), stack: Thread.callStackSymbols.joined(separator: "\n"), fatal: fatal)
    }

    /// Readable and groupable: "SampleError.priceMissing" for Swift's own errors (their localizedDescription
    /// is only Apple's generic "The operation couldn't be completed"), "NSURLErrorDomain -1001: The request
    /// timed out." for system errors, and the description of LocalizedError types.
    static func errorMessage(_ error: Error) -> String {
        let type = String(describing: Swift.type(of: error))
        if let localized = (error as? LocalizedError)?.errorDescription { return "\(type): \(localized)" }
        let ns = error as NSError
        if ns.domain == String(reflecting: Swift.type(of: error)) { return "\(type).\(error)" }
        let code = "\(ns.domain) \(ns.code)"
        if let text = ns.userInfo[NSLocalizedDescriptionKey] as? String { return "\(code): \(text)" }
        return code
    }
    public static func flag(_ key: String) async -> FlagResult { await tracker?.flag(key) ?? .off }
    /// IDs for checkout metadata (mm_visitor, mm_session, mm_user), so Stripe/Paddle revenue is attributed.
    public static var ids: (visitor: String, session: String?, user: String?)? { tracker?.ids }
    public static func optOut() { tracker?.optOut() }
    public static func optIn() { tracker?.optIn() }
    public static func flush() async { await tracker?.flush() }
}

// MARK: - App lifecycle and crashes

enum Lifecycle {
    nonisolated(unsafe) static var observers: [NSObjectProtocol] = []
    #if canImport(MetricKit) && os(iOS)
    nonisolated(unsafe) static var crashSubscriber: AnyObject?
    #endif

    static func install(_ t: Tracker, crashes: Bool) {
        #if canImport(UIKit) && !os(watchOS)
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { FrameMonitor.pause() }
            t.background()
            MainActor.assumeIsolated { BackgroundFlush.start(t) }
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
            t.foreground()
            MainActor.assumeIsolated { FrameMonitor.resume() }
        })
        DispatchQueue.main.async { MainActor.assumeIsolated { FrameMonitor.start(t) } }
        // Screen size from the app's window scene (UIScreen.main is deprecated since iOS 26); screen() retries.
        DispatchQueue.main.async { MainActor.assumeIsolated { readViewport(t) } }
        #endif
        guard crashes else { return }
        #if canImport(MetricKit) && os(iOS)
        // MetricKit delivers every kind of crash (signals, Swift traps, exceptions) on the next launch, safely.
        let subscriber = CrashSubscriber(tracker: t)
        MXMetricManager.shared.add(subscriber)
        crashSubscriber = subscriber
        #endif
    }
}

#if canImport(UIKit) && !os(watchOS)
/// Sends what's queued before iOS suspends the app. Apple's rules: request the time while the app is
/// entering the background (not later), and end the task when done or when time runs out, otherwise
/// the system terminates the app. Unsent events stay on disk for the next launch.
@MainActor
func readViewport(_ t: Tracker) {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first else { return }
    let size = scene.screen.bounds.size
    t.viewport = "\(Int(size.width))x\(Int(size.height))"
}

/// Counts display refreshes on the main thread (CADisplayLink) while the app is in the foreground: slow when a
/// refresh took over 1.5× the expected interval (a frame was missed), frozen when it took over 700 ms.
@MainActor
final class FrameMonitor: NSObject {
    private static var shared: FrameMonitor?
    private let tracker: Tracker
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private var counts = (total: 0, slow: 0, frozen: 0)

    private init(tracker: Tracker) { self.tracker = tracker }

    static func start(_ t: Tracker) {
        guard shared == nil else { return }
        let monitor = FrameMonitor(tracker: t)
        let link = CADisplayLink(target: monitor, selector: #selector(step(_:)))
        link.add(to: .main, forMode: .common)
        monitor.link = link
        shared = monitor
    }
    static func pause() { shared?.link?.isPaused = true; shared?.last = 0; drain() }
    static func resume() { shared?.link?.isPaused = false }
    static func drain() {
        guard let m = shared, m.counts.total > 0 else { return }
        m.tracker.recordFrames(m.counts.total, slow: m.counts.slow, frozen: m.counts.frozen)
        m.counts = (0, 0, 0)
    }

    @objc private func step(_ link: CADisplayLink) {
        defer { last = link.timestamp }
        guard last > 0 else { return }
        let duration = link.timestamp - last
        let expected = link.targetTimestamp > link.timestamp ? link.targetTimestamp - link.timestamp : link.duration
        counts.total += 1
        if expected > 0, duration > expected * 1.5 { counts.slow += 1 }
        if duration > 0.7 { counts.frozen += 1 }
        if counts.total >= 600 { FrameMonitor.drain() }
    }
}

@MainActor
enum BackgroundFlush {
    private static var task: UIBackgroundTaskIdentifier = .invalid

    static func start(_ t: Tracker) {
        guard task == .invalid else { return }
        task = UIApplication.shared.beginBackgroundTask(withName: "MetricMind flush") { end() }
        Task {
            await t.flush()
            end()
        }
    }

    static func end() {
        guard task != .invalid else { return }
        UIApplication.shared.endBackgroundTask(task)
        task = .invalid
    }
}
#endif

#if canImport(MetricKit) && os(iOS)
final class CrashSubscriber: NSObject, MXMetricManagerSubscriber {
    let tracker: Tracker
    init(tracker: Tracker) { self.tracker = tracker }

    /// Crash and hang reports about earlier runs (on the next launch from iOS 15, daily on iOS 14), counted
    /// against the build that produced them.
    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                let type = crash.exceptionType.map { "exception \($0)" } ?? crash.signal.map { "signal \($0)" } ?? "crash"
                let reason = crash.terminationReason ?? crash.virtualMemoryRegionInfo ?? ""
                tracker.captureReport("Crash (\(type))\(reason.isEmpty ? "" : ": \(reason)")", stack: String(data: crash.callStackTree.jsonRepresentation(), encoding: .utf8), fatal: true, kind: "crash", build: crash.metaData.applicationBuildVersion, at: payload.timeStampEnd)
            }
            for hang in payload.hangDiagnostics ?? [] {
                let ms = hang.hangDuration.converted(to: .milliseconds).value
                tracker.captureReport(String(format: "App hang (%.1f s)", ms / 1000), stack: String(data: hang.callStackTree.jsonRepresentation(), encoding: .utf8), fatal: false, kind: "hang", durationMs: ms, build: hang.metaData.applicationBuildVersion, at: payload.timeStampEnd)
            }
        }
        Task { await tracker.flush() }
    }
}
#endif

// MARK: - SwiftUI

#if canImport(SwiftUI)
@available(iOS 14.0, macOS 12.0, *)
public extension View {
    /// Records a screen view when this view appears.
    func trackScreen(_ name: String, props: Props? = nil) -> some View {
        onAppear { MetricMind.screen(name, props: props) }
    }
}
#endif
