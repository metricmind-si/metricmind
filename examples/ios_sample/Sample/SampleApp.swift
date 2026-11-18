// MetricMind native iOS sample. Launch with `-action tour` to run a scripted visit
// (xcrun simctl launch <device> si.metricmind.iossample -action tour).
import MetricMind
import SwiftUI

@main
struct SampleApp: App {
    init() {
        MetricMind.configure(site: "site_example", endpoint: URL(string: "http://localhost:3200/v1/batch")!)
    }

    var body: some Scene {
        WindowGroup { HomeView() }
    }
}

struct HomeView: View {
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Button("Open a listing") { path.append("listing") }
                Button("Publish") { MetricMind.track("listing_published", props: ["category": "cars"]) }
                Button("Contact on WhatsApp") { MetricMind.contact("WhatsApp") }
                Button("Report a handled error") { MetricMind.captureError(SampleError.priceMissing) }
            }
            .navigationTitle("Home")
            .trackScreen("Home")
            .navigationDestination(for: String.self) { _ in
                Text("Listing").trackScreen("Listing")
            }
        }
        .onOpenURL { MetricMind.open(url: $0) }
        .task {
            guard UserDefaults.standard.string(forKey: "action") == "tour" else { return }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            path.append("listing")
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            path.removeAll()
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            MetricMind.track("listing_published", props: ["category": "cars"])
            MetricMind.contact("WhatsApp")
            MetricMind.search("velo electrique")
            MetricMind.captureError(SampleError.priceMissing)
        }
    }
}

enum SampleError: Error { case priceMissing }
