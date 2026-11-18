# Changelog

## 0.2.0 (2026-11-18)

- `@metricmind/server/mcp`: MCP tool-call analytics for servers built with the official TypeScript SDK.
  `createMcpAnalytics(options).observe(server)` (or `observeMcp(server, options)`) records each `tools/call`:
  tool, duration, success, result size, error category and message, server release, environment, client and
  session. Arguments and results are never sent. No runtime dependencies; `@modelcontextprotocol/sdk` is an
  optional peer.

## 0.1.0 (2026-11-18)

First open-source release, under the MIT licence.

- `@metricmind/tracker`: the browser script `mm.js` (cookieless page views, custom events, Web Vitals, errors,
  outbound links, downloads, forms, site search, rage and dead clicks, feature flags, surveys, storage-free mode,
  page-side redaction) and its wire format types.
- `@metricmind/react-native`: React Native / Expo SDK.
- iOS SDK (Swift Package Manager, from this repository's root).
- Android SDK (JitPack: `com.github.metricmind-si.metricmind:android`).
- `metricmind` for Flutter.
- `@metricmind/server`: server-side events (`createTracker`) and AI crawler reads (`trackCrawler`).
