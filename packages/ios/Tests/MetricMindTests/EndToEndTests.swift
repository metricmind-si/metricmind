import Foundation
import XCTest
@testable import MetricMind

/// Against a running ingest: MM_E2E_ENDPOINT=http://localhost:3200/v1/batch MM_E2E_SITE=site_example swift test
final class EndToEndTests: XCTestCase {
    func testRealIngest() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let endpoint = env["MM_E2E_ENDPOINT"].flatMap(URL.init(string:)), let site = env["MM_E2E_SITE"] else { throw XCTSkip("set MM_E2E_ENDPOINT and MM_E2E_SITE") }
        let tracker = Tracker(site: site, app: AppContext(platform: "ios", version: "9.9.9-e2e", build: "2", os_version: "18.1", device: "phone"), endpoint: endpoint, store: MemoryStore())
        tracker.trackScreen("E2E Home")
        tracker.track("e2e_signup", props: ["plan": "pro"])
        tracker.captureError("Crash (signal 11)", fatal: true)
        await tracker.flush()
        XCTAssertEqual(tracker.pendingCount, 0, "ingest accepted the batch")
    }
}
