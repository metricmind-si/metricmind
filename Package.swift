// swift-tools-version:5.9
// MetricMind for iOS (and macOS for tests). Add https://github.com/metricmind-si/metricmind in Xcode or:
//   .package(url: "https://github.com/metricmind-si/metricmind", from: "0.1.0")
// Sources live in packages/ios; the rest of this repository is ignored by SwiftPM.
import PackageDescription

let package = Package(
    name: "MetricMind",
    platforms: [.iOS(.v14), .macOS(.v12)],
    products: [.library(name: "MetricMind", targets: ["MetricMind"])],
    targets: [
        .target(
            name: "MetricMind",
            path: "packages/ios/Sources/MetricMind",
            resources: [.copy("PrivacyInfo.xcprivacy")]
        ),
        .testTarget(
            name: "MetricMindTests",
            dependencies: ["MetricMind"],
            path: "packages/ios/Tests/MetricMindTests"
        ),
    ]
)
