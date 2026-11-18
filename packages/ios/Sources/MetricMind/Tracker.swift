// The platform-independent core: identity, sessions, screens, the event queue
// and delivery. UIKit/SwiftUI/MetricKit glue lives in MetricMind.swift.
import Foundation

/// A property value: string, number, bool or null (same as the website tracker).
public enum PropValue: Codable, Equatable, Sendable, ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral {
    case string(String), number(Double), bool(Bool), null

    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else { self = .string(try c.decode(String.self)) }
    }
}

public typealias Props = [String: PropValue]

public struct FlagResult: Codable, Equatable, Sendable {
    public let enabled: Bool
    public let variant: String
    public static let off = FlagResult(enabled: false, variant: "off")
}

/// Sent once per batch: which app and release the events come from.
public struct AppContext: Codable, Equatable, Sendable {
    public var platform: String // "ios" | "android"
    public var version: String
    public var build: String?
    public var os_version: String?
    public var device: String? // "phone" | "tablet"
}

struct WireError: Codable, Equatable { var message: String; var stack: String? }

struct WireEvent: Codable, Equatable {
    var id: String
    var type: String
    var ts: Int64
    var visitor: String
    var session: String
    var user: String?
    var path: String
    var title: String?
    var name: String?
    var value: Double?
    var props: Props?
    var error: WireError?
    var utm: Campaign?
    /// The release that recorded it, kept on the device (nil, so not encoded, when sent).
    var app: AppContext?
    var lang: String?
    var tz: String?
    var viewport: String?
}

/// A link's utm_* campaign (ref= counts as the source, like on the website).
public struct Campaign: Codable, Equatable, Sendable {
    public var source: String?
    public var medium: String?
    public var campaign: String?

    /// The campaign of a deep, universal or app link, or nil when it has none.
    public init?(url: URL) {
        guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        func value(_ name: String) -> String? {
            guard let v = items.first(where: { $0.name == name })?.value?.trimmingCharacters(in: .whitespaces), !v.isEmpty else { return nil }
            return String(v.prefix(200))
        }
        source = value("utm_source") ?? value("ref")
        medium = value("utm_medium")
        campaign = value("utm_campaign")
        if source == nil && medium == nil && campaign == nil { return nil }
    }
}

struct Batch: Codable { var site: String; var app: AppContext; var events: [WireEvent] }

/// Where events are sent. The default posts JSON with URLSession.
public protocol Transport: Sendable {
    func post(_ url: URL, body: Data) async -> Int? // HTTP status, nil on network failure
    func get(_ url: URL) async -> (Int, Data)?
}

/// Key/value storage for IDs and unsent events. The default is UserDefaults.
public protocol KeyValueStore: AnyObject, Sendable {
    func string(_ key: String) -> String?
    func set(_ value: String?, _ key: String)
}

public final class UserDefaultsStore: KeyValueStore, @unchecked Sendable {
    private let defaults: UserDefaults
    public init(_ defaults: UserDefaults = .standard) { self.defaults = defaults }
    public func string(_ key: String) -> String? { defaults.string(forKey: key) }
    public func set(_ value: String?, _ key: String) { defaults.set(value, forKey: key) }
}

public struct URLSessionTransport: Transport {
    public init() {}
    public func post(_ url: URL, body: Data) async -> Int? {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        req.timeoutInterval = 15
        guard let (_, res) = try? await URLSession.shared.data(for: req) else { return nil }
        return (res as? HTTPURLResponse)?.statusCode
    }
    public func get(_ url: URL) async -> (Int, Data)? {
        guard let (data, res) = try? await URLSession.shared.data(from: url) else { return nil }
        return ((res as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}

extension NSLock {
    /// Runs `body` while holding the lock (NSLocking.withLock needs newer OS versions).
    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}

enum Keys {
    static let visitor = "mm_visitor", visitorAt = "mm_visitor_at", session = "mm_session", user = "mm_user", queue = "mm_queue", optOut = "mm_optout", optIn = "mm_optin", exposed = "mm_exposed", builds = "mm_builds", screen = "mm_screen"
}

/// "Checkout" → "/Checkout"; spaces become dashes (same rule as the React Native SDK).
public func screenPath(_ name: String) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let dashed = trimmed.split(whereSeparator: { $0.isWhitespace }).joined(separator: "-")
    let clean = String(dashed.drop(while: { $0 == "/" }).prefix(200))
    return "/" + (clean.isEmpty ? "unknown" : clean)
}

/// A search term worth recording, or nil: emails and phone numbers are never sent.
public func searchTerm(_ raw: String) -> String? {
    let term = String(raw.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased().prefix(100))
    if term.isEmpty || term.contains("@") { return nil }
    if term.range(of: #"\d[\d\s().-]{6,}\d"#, options: .regularExpression) != nil { return nil }
    return term
}

/// A feedback message ready to send: at most 500 characters, emails and phone numbers replaced.
public func feedbackText(_ raw: String) -> String? {
    var text = raw.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    text = text.replacingOccurrences(of: #"[^\s@]+@[^\s@]+\.[^\s@]+"#, with: "[email]", options: .regularExpression)
    text = text.replacingOccurrences(of: #"\+?\d[\d\s().-]{6,}\d"#, with: "[phone]", options: .regularExpression)
    let capped = String(text.prefix(500))
    return capped.isEmpty ? nil : capped
}

/// The measurement core. Thread-safe; all state changes happen under one lock.
public final class Tracker: @unchecked Sendable {
    public static let defaultEndpoint = URL(string: "https://in.metricmind.si/v1/batch")!
    static let sessionIdle: TimeInterval = 30 * 60
    /// Back after this long in the background (or relaunched after it): a new session, as in the store consoles.
    static let backgroundSession: TimeInterval = 30
    static let maxBatch = 20
    static let maxQueue = 300

    private let site: String
    private let endpoint: URL
    /// Which feature flags apply; nil or empty serves flags without an environment.
    private let environment: String?
    private let transport: Transport
    private let store: KeyValueStore
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    var app: AppContext
    var viewport: String?
    /// How long a campaign link waits for the screen it opens before the current screen is counted again.
    var campaignWait: TimeInterval = 1

    private var visitor: String
    private var visitorAt: Date
    private var session: (id: String, last: Date)?
    private var backgroundAt: Date?
    // From the previous run, for reports the OS delivers on the next launch (MetricKit crashes and hangs).
    private var previousSession: String?
    private var previousScreen: String?
    private var builds: [String: AppContext] = [:]
    private var screenOpenedAt: Date?
    private var screenReadySent = false
    private var frames: (total: Int, slow: Int, frozen: Int) = (0, 0, 0)
    private var user: String?
    private var queue: [WireEvent]
    private var disabled: Bool
    private var exposed: Set<String>
    private var screen: (path: String, title: String, since: Date?, engaged: TimeInterval)?
    private var flushing = false
    private var flagsCache: [String: FlagResult]?
    private var pendingCampaign: Campaign?

    public init(site: String, app: AppContext, endpoint: URL = Tracker.defaultEndpoint, transport: Transport = URLSessionTransport(), store: KeyValueStore = UserDefaultsStore(), now: @escaping @Sendable () -> Date = { Date() }, enabled: Bool = true, environment: String? = nil) {
        self.site = site
        self.environment = environment
        self.app = app
        self.endpoint = endpoint
        self.transport = transport
        self.store = store
        self.now = now
        // enabled: false waits for consent: nothing is stored or sent until optIn(), which is remembered.
        disabled = store.string(Keys.optOut) == "1" || (!enabled && store.string(Keys.optIn) != "1")
        visitor = store.string(Keys.visitor) ?? UUID().uuidString.lowercased()
        // No date, a broken one or one from the future: never a reason to keep an ID longer.
        if store.string(Keys.visitor) == nil {
            visitorAt = now()
        } else if let at = store.string(Keys.visitorAt).flatMap({ Double($0) }), at > 0, at <= now().timeIntervalSince1970 {
            visitorAt = Date(timeIntervalSince1970: at)
        } else {
            visitorAt = Date(timeIntervalSince1970: Tracker.visitorLegacyIssued)
        }
        user = store.string(Keys.user)
        if let raw = store.string(Keys.session), let data = raw.data(using: .utf8), let s = try? JSONDecoder().decode([String: Double].self, from: data), let last = s["last"], let id = store.string(Keys.session + "_id") {
            session = (id, Date(timeIntervalSince1970: last))
            backgroundAt = session?.last // a launch is a return from the background
        }
        previousSession = session?.id
        previousScreen = store.string(Keys.screen)
        builds = (store.string(Keys.builds)?.data(using: .utf8)).flatMap { try? JSONDecoder().decode([String: AppContext].self, from: $0) } ?? [:]
        // Events a previous launch couldn't send (offline, killed before flushing).
        queue = (store.string(Keys.queue).flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode([WireEvent].self, from: $0) }) ?? []
        exposed = Set((store.string(Keys.exposed).flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode([String].self, from: $0) }) ?? [])
        if !expireVisitor(), !disabled { saveVisitor() }
    }

    // MARK: Identity

    /// An install ID lasts 13 months from the day it was made, never extended by use (CNIL's recommendation for
    /// audience measurement; 393 days is the shortest 13 calendar months can be).
    static let visitorLifetime: TimeInterval = 393 * 86_400
    /// IDs from before this rule carry no date and count from the day it shipped (2026-11-02 UTC).
    static let visitorLegacyIssued: TimeInterval = 1_793_577_600

    private func saveVisitor() {
        store.set(visitor, Keys.visitor)
        store.set(String(visitorAt.timeIntervalSince1970), Keys.visitorAt)
    }

    /// A new install ID once the old one is 13 months old; it starts a new session, or one session would have two IDs.
    @discardableResult private func expireVisitor() -> Bool {
        let at = now()
        guard at.timeIntervalSince(visitorAt) >= Tracker.visitorLifetime else { return false }
        visitor = UUID().uuidString.lowercased()
        visitorAt = at
        session = nil
        flagsCache = nil
        if !disabled { saveVisitor() }
        return true
    }

    /// Session ID, rotated after 30 idle minutes (same rule as the website tracker).
    private func touchSession(_ at: Date) -> String {
        let away = backgroundAt.map { at.timeIntervalSince($0) >= Tracker.backgroundSession } ?? false
        backgroundAt = nil
        if let s = session, !away, at.timeIntervalSince(s.last) <= Tracker.sessionIdle {
            session = (s.id, at)
        } else {
            session = (UUID().uuidString.lowercased(), at)
        }
        store.set(session!.id, Keys.session + "_id")
        store.set(#"{"last":\#(at.timeIntervalSince1970)}"#, Keys.session)
        return session!.id
    }

    public var ids: (visitor: String, session: String?, user: String?) {
        lock.locked { (visitor, session?.id, user) }
    }

    // MARK: Events

    private func emit(type: String, path: String? = nil, title: String? = nil, name: String? = nil, value: Double? = nil, props: Props? = nil, error: WireError? = nil, utm: Campaign? = nil, at: Date? = nil, release: AppContext? = nil, sessionID: String? = nil) {
        guard !disabled else { return }
        expireVisitor()
        let ts = at ?? now()
        if utm != nil { session = nil } // a campaign visit is a new session
        let tz = TimeZone.current.identifier
        let e = WireEvent(id: UUID().uuidString.lowercased(), type: type, ts: Int64(ts.timeIntervalSince1970 * 1000), visitor: visitor, session: sessionID ?? touchSession(ts), user: user, path: path ?? screen?.path ?? "/", title: title, name: name, value: value, props: props, error: error, utm: utm, app: release ?? app, lang: Locale.preferredLanguages.first.map { String($0.prefix(35)) }, tz: String(tz.prefix(64)), viewport: viewport)
        queue.append(e)
        if queue.count > Tracker.maxQueue { queue.removeFirst(queue.count - Tracker.maxQueue) }
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(queue) { store.set(String(data: data, encoding: .utf8), Keys.queue) }
    }

    var pendingCount: Int { lock.locked { queue.count } }

    /// One screen view; ends the previous screen with its engaged time.
    public func trackScreen(_ name: String, props: Props? = nil) {
        let path = screenPath(name)
        let full: Bool = lock.locked {
            if screen?.path == path { return false }
            endScreenLocked()
            screen = (path, String(name.prefix(512)), now(), 0)
            screenOpenedAt = now()
            screenReadySent = false
            if !disabled { store.set(path, Keys.screen) } // the screen a report about this run will point to
            emit(type: "pageview", path: path, title: screen!.title, props: props, utm: pendingCampaign)
            pendingCampaign = nil
            return queue.count >= Tracker.maxBatch
        }
        if full { Task { await flush() } }
    }

    /// A link opened the app. With utm_* parameters it starts a new session credited to
    /// that campaign, whose entry is the screen the link opens. If no screen follows within
    /// a second (a link to the screen already shown), the current screen is counted again.
    public func open(url: URL) {
        guard let c = Campaign(url: url) else { return }
        let showing: Bool = lock.locked {
            pendingCampaign = c
            return screen != nil
        }
        guard showing else { return }
        DispatchQueue.global().asyncAfter(deadline: .now() + campaignWait) { [weak self] in
            guard let self else { return }
            let title: String? = self.lock.locked {
                guard self.pendingCampaign == c, let s = self.screen else { return nil } // the link's screen took it
                self.endScreenLocked()
                self.screen = nil
                return s.title
            }
            if let title { self.trackScreen(title) }
        }
    }

    private func endScreenLocked() {
        guard let s = screen, s.since != nil || s.engaged > 0 else { return } // already closed
        let engaged = s.engaged + (s.since.map { now().timeIntervalSince($0) } ?? 0)
        // Display refreshes while the screen was shown: slow (a refresh missed) and frozen (over 700 ms).
        let props: Props? = frames.total > 0 ? ["frames": .number(Double(frames.total)), "slow": .number(Double(frames.slow)), "frozen": .number(Double(frames.frozen))] : nil
        emit(type: "exit", path: s.path, value: min(engaged * 1000, 86_400_000).rounded(), props: props)
        frames = (0, 0, 0)
        screen = (s.path, s.title, nil, 0)
    }

    /// App went to the background: close the screen's engaged time (the caller flushes).
    public func background() {
        lock.locked {
            endScreenLocked()
            if backgroundAt == nil { backgroundAt = now() }
        }
    }

    /// Back in the foreground: the current screen keeps counting.
    public func foreground() {
        lock.locked {
            let at = now()
            if let s = screen, let away = backgroundAt, at.timeIntervalSince(away) >= Tracker.backgroundSession {
                // Back after 30 s or more: a new session, whose entry is the screen the app returns to.
                screen = (s.path, s.title, at, 0)
                emit(type: "pageview", path: s.path, title: s.title)
                return
            }
            guard let s = screen else { return } // launching: the first event decides whether it's a new session
            backgroundAt = nil
            if s.since == nil { screen = (s.path, s.title, at, 0) }
        }
    }

    public func track(_ name: String, props: Props? = nil) {
        guard !name.isEmpty else { return }
        lock.locked { emit(type: "event", name: String(name.prefix(120)), props: props) }
    }

    /// Contact actions (call, WhatsApp, email, chat): counted like the website's automatic contact clicks.
    /// What a user tells you (your feedback form), with an optional 1–5 rating; linked to the session and release.
    public func feedback(_ message: String, rating: Int? = nil) {
        guard let text = feedbackText(message) else { return }
        var props: Props = ["message": .string(text)]
        if let rating, (1...5).contains(rating) { props["rating"] = .number(Double(rating)) }
        track("$feedback", props: props)
    }

    /// Props say what was contacted (["category": "cars"]); never the number or address.
    public func contact(_ channel: String, props: Props = [:]) {
        track("contact", props: props.merging(["channel": .string(String(channel.lowercased().prefix(40)))]) { _, new in new })
    }

    /// What the user searched for. Emails and phone numbers are never sent.
    /// `results`: how many results the search found, so searches that find nothing stand out.
    public func search(_ term: String, results: Int? = nil, props: Props = [:]) {
        guard let t = searchTerm(term) else { return }
        var p = props.filter { $0.key != "results" }
        p["term"] = .string(t)
        if let results, results >= 0 { p["results"] = .number(Double(results)) }
        track("search", props: p)
    }

    /// Links this install to your user ID (after login). Traits are sent once; only pass what your privacy policy covers.
    public func identify(_ id: String, traits: Props? = nil) {
        guard !id.isEmpty else { return }
        lock.locked {
            let u = String(id.prefix(128))
            let changed = u != user
            user = u
            store.set(u, Keys.user)
            if changed { flagsCache = nil }
            if changed || traits != nil { emit(type: "event", name: "$identify", props: traits) }
        }
    }

    /// Forgets the user (call on logout): new anonymous install ID and session.
    public func reset() {
        lock.locked {
            user = nil
            visitor = UUID().uuidString.lowercased()
            visitorAt = now()
            session = nil
            flagsCache = nil
            store.set(nil, Keys.user)
            if !disabled { saveVisitor() } // never stored without consent
            store.set(nil, Keys.session)
            store.set(nil, Keys.session + "_id")
        }
    }

    /// Cold start: process launch to the first screen, in milliseconds (sent once per launch by the glue).
    public func appStart(milliseconds: Double) {
        guard milliseconds > 0, milliseconds < 120_000 else { return }
        lock.locked { emit(type: "vital", name: "APP_START", value: milliseconds.rounded()) }
    }

    /// An error you caught, or a crash (fatal).
    /// Adds display frames to the current screen (sent as totals with its exit).
    func recordFrames(_ total: Int, slow: Int, frozen: Int) {
        lock.locked {
            guard screen != nil else { return }
            frames = (frames.total + total, frames.slow + slow, frames.frozen + frozen)
        }
    }

    /// Time to full display: call when the current screen's content has loaded (once per screen view).
    public func screenReady() {
        lock.locked {
            guard let s = screen, let opened = screenOpenedAt, !screenReadySent else { return }
            let ms = now().timeIntervalSince(opened) * 1000
            guard ms >= 0, ms < 60_000 else { return }
            screenReadySent = true
            emit(type: "vital", path: s.path, name: "SCREEN_READY", value: ms.rounded())
        }
    }

    /// Remembers this launch's release by build number, so reports the OS delivers later map back to it.
    func recordRun() {
        lock.locked {
            guard !disabled else { return }
            let key = app.build ?? app.version
            while builds.count >= 8, let old = builds.keys.first(where: { $0 != key }) { builds[old] = nil }
            builds[key] = app
            if let data = try? JSONEncoder().encode(builds) { store.set(String(data: data, encoding: .utf8), Keys.builds) }
        }
    }

    /// A crash or hang the OS reported about an earlier run (MetricKit): counted against that run's release
    /// (by build number), its last screen and session, at the time the report covers.
    func captureReport(_ message: String, stack: String?, fatal: Bool, kind: String, durationMs: Double? = nil, build: String?, at: Date?) {
        lock.locked {
            var props: Props = ["fatal": .bool(fatal), "kind": .string(kind)]
            if let durationMs { props["duration_ms"] = .number(durationMs.rounded()) }
            let release = build.flatMap { builds[$0] } ?? app
            emit(type: "error", path: previousScreen, props: props, error: WireError(message: String(message.prefix(500)), stack: stack.map { String($0.prefix(4000)) }), at: at.map { min($0, now()) }, release: release, sessionID: previousSession ?? UUID().uuidString.lowercased())
        }
    }

    public func captureError(_ message: String, stack: String? = nil, fatal: Bool = false) {
        lock.locked { emit(type: "error", props: ["fatal": .bool(fatal)], error: WireError(message: String(message.prefix(500)), stack: stack.map { String($0.prefix(4000)) })) }
    }

    public func optOut() {
        lock.locked {
            disabled = true
            queue = []
            for k in [Keys.queue, Keys.visitor, Keys.visitorAt, Keys.session, Keys.session + "_id", Keys.user] { store.set(nil, k) }
            store.set(nil, Keys.optIn)
            store.set("1", Keys.optOut)
        }
    }

    /// Starts (or resumes) measurement, e.g. after the user consents. Remembered across launches.
    public func optIn() {
        lock.locked {
            disabled = false
            store.set(nil, Keys.optOut)
            store.set("1", Keys.optIn)
            saveVisitor()
        }
    }

    /// Whether events are being recorded (false before consent with enabled: false, or after optOut).
    public var isEnabled: Bool { lock.locked { !disabled } }

    // MARK: Delivery

    /// Sends queued events; failed batches stay queued (and stored) for the next try.
    public func flush() async {
        let site = self.site
        while true {
            let next: (Data, Int)? = lock.locked {
                guard !disabled, !flushing, !queue.isEmpty else { return nil }
                flushing = true
                // One release per batch: a crash saved before an update is sent with the version that crashed.
                let batchApp = queue[0].app ?? app
                let batch = Array(queue.prefix(Tracker.maxBatch).prefix { ($0.app ?? app) == batchApp })
                let events = batch.map { e -> WireEvent in var copy = e; copy.app = nil; return copy }
                guard let body = try? JSONEncoder().encode(Batch(site: site, app: batchApp, events: events)) else { flushing = false; return nil }
                return (body, batch.count)
            }
            guard let (body, count) = next else { return }
            let status = await transport.post(endpoint, body: body)
            let keepGoing: Bool = lock.locked {
                flushing = false
                // Network errors, 429 and 5xx: keep for later. Other 4xx: drop, retrying won't help.
                guard let status, status < 500, status != 429 else { return false }
                queue.removeFirst(min(count, queue.count))
                persist()
                return true
            }
            if !keepGoing { return }
        }
    }

    // MARK: Feature flags

    /// All flags for this install, evaluated by MetricMind's servers (cached until identify/reset).
    public func flags() async -> [String: FlagResult] {
        let state: (cached: [String: FlagResult]?, visitor: String, user: String?, path: String, disabled: Bool) = lock.locked { (self.flagsCache, self.visitor, self.user, self.screen?.path ?? "/", self.disabled) }
        if state.disabled { return [:] }
        if let cached = state.cached { return cached }
        let visitor = state.visitor, user = state.user, path = state.path
        var comps = URLComponents(url: endpoint.deletingLastPathComponent().appendingPathComponent("flags"), resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "site", value: site), URLQueryItem(name: "visitor", value: visitor), URLQueryItem(name: "path", value: path), URLQueryItem(name: "platform", value: app.platform)]
        if let user { items.append(URLQueryItem(name: "user", value: user)) }
        if let environment, !environment.isEmpty { items.append(URLQueryItem(name: "env", value: environment)) }
        comps.queryItems = items
        guard let url = comps.url, let (status, data) = await transport.get(url), status == 200,
              let body = try? JSONDecoder().decode([String: [String: FlagResult]].self, from: data) else { return [:] }
        let flags = body["flags"] ?? [:]
        lock.locked { flagsCache = flags }
        return flags
    }

    /// One flag; off when unknown or unreachable. Records an exposure once so the dashboard can compare variants.
    public func flag(_ key: String) async -> FlagResult {
        let all = await flags()
        guard let result = all[key] else { return .off }
        let marker = "\(key)=\(result.variant)"
        let isNew = lock.locked { exposed.insert(marker).inserted }
        if isNew {
            if let data = try? JSONEncoder().encode(Array(lock.locked { exposed }).suffix(50)) { store.set(String(data: data, encoding: .utf8), Keys.exposed) }
            track("$flag", props: ["flag": .string(key), "variant": .string(result.variant)])
        }
        return result
    }
}
