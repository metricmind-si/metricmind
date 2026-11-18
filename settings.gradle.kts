// Root Gradle build: only the Android SDK library (packages/android), so JitPack can build it from a tag.
// The samples under examples/ are separate Gradle builds.
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "metricmind"
include(":android")
project(":android").projectDir = file("packages/android")
