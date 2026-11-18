#!/usr/bin/env bash
# Runs the JVM tests for the core and, when ANDROID_JAR points at an
# android.jar (platforms/android-34), compiles the Android glue against it.
# Needs kotlinc (brew install kotlin).
set -euo pipefail
cd "$(dirname "$0")"
BIN="$(dirname "$(readlink -f "$(command -v kotlinc)")")"
KLIB="$BIN/../lib"; [ -f "$KLIB/kotlin-test.jar" ] || KLIB="$BIN/../libexec/lib"
OUT="$(mktemp -d)"
kotlinc src/main/kotlin/si/metricmind/Tracker.kt src/test/kotlin/si/metricmind/TrackerTest.kt -cp "$KLIB/kotlin-test.jar" -include-runtime -d "$OUT/test.jar" 2>&1 | grep -v '^warning' || true
java -cp "$OUT/test.jar:$KLIB/kotlin-test.jar" si.metricmind.TrackerTestKt
if [ -n "${ANDROID_JAR:-}" ]; then
  kotlinc src/main/kotlin/si/metricmind/*.kt -cp "$ANDROID_JAR" -d "$OUT/android" && echo "Android glue compiles against $ANDROID_JAR"
fi
