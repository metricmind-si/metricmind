// Native Android sample: compiles the SDK straight from packages/android (no copy).
// Release under test: ./gradlew installDebug -PappVersion=2.0.1 -PappBuild=4
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "si.metricmind.sample"
    compileSdk = 36
    defaultConfig {
        applicationId = "si.metricmind.sample"
        minSdk = 24
        targetSdk = 36
        versionName = (project.findProperty("appVersion") as String?) ?: "2.0.0"
        versionCode = ((project.findProperty("appBuild") as String?) ?: "3").toInt()
    }
    sourceSets["main"].java.srcDir("../../../packages/android/src/main/kotlin")
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}
