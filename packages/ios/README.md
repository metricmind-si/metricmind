# MetricMind for iOS

Swift package: cookieless screens, sessions, events, users, errors, crashes and hangs (MetricKit), app start
time, campaign deep links and feature flags. iOS 14+.

Add `https://github.com/metricmind-si/metricmind` with Swift Package Manager (the `Package.swift` is at the
repository root) and use the `MetricMind` library:

```swift
import MetricMind

MetricMind.configure(site: "YOUR_SITE_ID")   // version and build read from Info.plist
MetricMind.screen("Checkout")                // or Text("Checkout").trackScreen("Checkout") in SwiftUI
MetricMind.track("purchase", props: ["plan": "pro"])
// .onOpenURL { MetricMind.open(url: $0) } credits campaign links
```

Consent: `configure(site:, enabled: false)` records nothing until `MetricMind.optIn()`. The package ships a
privacy manifest (`PrivacyInfo.xcprivacy`).

Tests: `swift test` from the repository root. MIT licensed.
