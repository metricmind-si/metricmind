// MetricMind for Android as a library (JitPack: com.github.metricmind-si.metricmind:android:<tag>).
// The sources are two plain Kotlin files with no dependencies besides the Android framework;
// you can also copy src/main/kotlin/si/metricmind/*.kt into your app instead.
plugins {
    id("com.android.library")
    `maven-publish`
}

group = "com.github.metricmind-si"
version = "0.1.0"

android {
    namespace = "si.metricmind"
    compileSdk = 36
    defaultConfig {
        minSdk = 24
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // src/test/kotlin/si/metricmind/TrackerTest.kt is a plain main() runner for the JVM core; it runs
    // through test.sh (kotlinc), not as a Gradle unit test.
    sourceSets.getByName("main") {
        manifest.srcFile("AndroidManifest.xml")
    }
    sourceSets.getByName("test") {
        java.setSrcDirs(emptyList<String>())
        kotlin.setSrcDirs(emptyList<String>())
    }
    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}


afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                artifactId = "android"
                pom {
                    name.set("MetricMind for Android")
                    description.set("Privacy-first app analytics for Android: screens, sessions, events, errors and crashes.")
                    url.set("https://github.com/metricmind-si/metricmind")
                    licenses { license { name.set("MIT"); url.set("https://opensource.org/licenses/MIT") } }
                }
            }
        }
    }
}
