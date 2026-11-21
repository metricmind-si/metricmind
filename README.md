# MetricMind client SDKs

[MetricMind](https://metricmind.si) is privacy-first web and app analytics with a built-in AI analyst.
This repository holds the open-source code that runs on your pages, in your apps and on your servers to send data to it.

## What's in this repository

| Package | What it is | Install |
|---|---|---|
| [`packages/tracker`](packages/tracker) | `mm.js`, the browser script: page views, custom events, Web Vitals, errors, outbound links, forms, feature flags, surveys | `<script>` tag, or npm `@metricmind/tracker` |
| [`packages/react-native`](packages/react-native) | React Native / Expo SDK, one TypeScript file, no native module | npm `@metricmind/react-native` |
| [`packages/ios`](packages/ios) | iOS SDK (Swift, UIKit/SwiftUI, MetricKit) | Swift Package Manager: this repository's URL |
| [`packages/android`](packages/android) | Android SDK (Kotlin, no dependencies besides the Android framework) | JitPack, or copy two files |
| [`packages/flutter`](packages/flutter) | Flutter SDK (pure Dart, no plugins) | git dependency (pub.dev to follow) |
| [`packages/server`](packages/server) | Server helpers: server-side events (`createTracker`), MCP tool-call analytics (`createMcpAnalytics`) and AI crawler reads (`trackCrawler`) | npm `@metricmind/server` |
| [`examples/`](examples) | Sample apps for Android (Gradle), iOS (XcodeGen `project.yml`) and Flutter; they send to a local endpoint, so set your own `site` and `endpoint` | |

## What's not in it

The hosted service is closed source: the ingest API that receives these events, storage, the dashboard,
the AI analyst, alerts and billing. These SDKs send to `https://in.metricmind.si` by default; every SDK
takes an `endpoint` option, but this repository contains no server to point it at.

## Install

The JavaScript packages are on npm. Flutter is not on pub.dev yet: until it is, use the git dependency shown under
Flutter below. The script tag, npm, Swift Package Manager and JitPack all work today.

**Website**

```html
<script src="https://cdn.metricmind.si/mm.js" data-site="YOUR_SITE_ID" defer></script>
```

Or from npm, to serve the file yourself: `npm install @metricmind/tracker` (the script is `dist/mm.js`).

**React Native**: `npm install @metricmind/react-native @react-native-async-storage/async-storage`, then
`MetricMind.init({ site: "YOUR_SITE_ID", appVersion: "1.0.0", storage: AsyncStorage })`.

**iOS**: in Xcode, File → Add Package Dependencies → `https://github.com/metricmind-si/metricmind`, then
`MetricMind.configure(site: "YOUR_SITE_ID")` at launch.

**Android**: add `maven { url = uri("https://jitpack.io") }` to your repositories and
`implementation("com.github.metricmind-si:metricmind:0.2.0")`, then
`MetricMind.init(this, site = "YOUR_SITE_ID")` in `Application.onCreate()`.

**Server** (Node 18+, Bun, Deno, edge): `npm install @metricmind/server`, then
`createTracker` from `@metricmind/server/events`, `createMcpAnalytics` from `@metricmind/server/mcp`, or the
crawler helper from `@metricmind/server/crawlers`.

**Flutter**: until the package is on pub.dev, add a git dependency to `pubspec.yaml`:

```yaml
dependencies:
  metricmind:
    git:
      url: https://github.com/metricmind-si/metricmind
      path: packages/flutter
      ref: "0.2.0"
```

then `await MetricMind.init(site: 'YOUR_SITE_ID', ...)`.

Each package's README has the details. Your site ID is in the MetricMind dashboard.

## Privacy: what the code does

These are properties of the code in this repository, which you can check:

- **No cookies.** The browser script never reads or writes `document.cookie`. It keeps a random visitor ID (renewed
  after 13 months at most) and a session ID in `localStorage`; with `data-storage="none"` it stores no IDs in the
  browser (only an explicit opt-out is remembered).
  The mobile SDKs keep a random install ID in the app's own storage, never an advertising ID.
- **Page path only.** Page views carry the URL path, not the query string or fragment. From the query string the
  script reads only `utm_*` campaign values, the name of the ad network behind a click ID (never the ID itself) and
  a site-search term (dropped when it looks like an e-mail address or phone number). The referrer is sent as the
  browser reports it.
- **Form labels, never values.** Form tracking sends the form's and fields' labels; it never reads what people type.
- **No IP address or user agent in the payload.** The browser and app SDKs don't put either in the events they send
  (the HTTP request itself reaches the server with them, as every request does; the hosted service says it doesn't
  store them, which this repository can't show). The crawler helper is the exception: it reports a crawler's user
  agent and IP address so the service can check the crawler is who it claims to be.
- **Opt-out.** `mm.optOut()` (web) and `MetricMind.optOut()` (apps) stop measurement in that browser or app; the app
  SDKs also have a consent mode (`enabled: false`) that records nothing until `optIn()`.
- **Page-side redaction.** A page can set `window.mmRedact` to rewrite or drop every path and text the script sends.

## Wire format

`packages/tracker/src/types.ts` is the format of `POST /v1/batch`. The mobile SDKs send the same format with an
extra batch-level `app` object (platform, version, build, OS version, device class). The format is defined and
versioned by MetricMind's ingest service, which is closed source; a change here has to match what ingest accepts,
so pull requests that change the format need a maintainer to change ingest first.

## Development

```sh
bun install && bun run test && bun run typecheck   # tracker, react-native, server
swift test                                          # iOS (from the repository root)
packages/android/test.sh                            # Android core (needs kotlinc); ./gradlew :android:assembleRelease builds the AAR
cd packages/flutter && flutter test                 # Flutter
```

This repository is exported from MetricMind's internal monorepo, which remains the source of truth; see
[CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
