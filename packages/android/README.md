# MetricMind for Android

Kotlin: cookieless screens (one per Activity by default), sessions, events, users, errors, crashes, ANRs,
app start time, campaign app links and feature flags. No dependencies besides the Android framework; minSdk 24.

With JitPack:

```kotlin
// settings.gradle.kts
dependencyResolutionManagement { repositories { google(); mavenCentral(); maven { url = uri("https://jitpack.io") } } }
// app/build.gradle.kts
dependencies { implementation("com.github.metricmind-si.metricmind:android:0.1.0") }
```

Or copy `src/main/kotlin/si/metricmind/Tracker.kt` and `MetricMind.kt` into your app (package `si.metricmind`);
the app needs the `INTERNET` permission.

```kotlin
MetricMind.init(this, site = "YOUR_SITE_ID")   // in Application.onCreate(); version and build read from the package
MetricMind.track("purchase", mapOf("plan" to "pro"))
```

Consent: `MetricMind.init(this, site = "…", enabled = false)` records nothing until `MetricMind.optIn()`.

Tests: `./test.sh` runs the JVM core's tests with `kotlinc`; set `ANDROID_JAR` to an `android.jar` to
compile-check the Android glue too. `./gradlew :android:assembleRelease` (repository root) builds the AAR.
MIT licensed.
