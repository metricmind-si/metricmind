# @metricmind/tracker

`mm.js`, MetricMind's browser script: cookieless page views, custom events, Web Vitals, JavaScript errors,
outbound links, downloads, forms (labels only), site search, rage and dead clicks, feature flags and surveys.
About 12 KB gzip; the survey widget (`survey.js`, 5.5 KB) loads only when a survey is due.

## Use it

```html
<script src="https://cdn.metricmind.si/mm.js" data-site="YOUR_SITE_ID" defer></script>
```

Or serve the file yourself from this package (`dist/mm.js`), e.g.
`https://cdn.jsdelivr.net/npm/@metricmind/tracker@0.1.0/dist/mm.js`.

```js
mm.track("signup", { plan: "pro" });
mm.identify("user_123");            // after login; mm.reset() on logout
const { enabled, variant } = await mm.flag("new-checkout");
mm.optOut();                         // stop measuring in this browser
```

Calls made before the script loads can be queued in `window.mm.q` (`[["track", "signup"]]`).

Options are `data-*` attributes on the script tag: `api` (endpoint), `vitals`, `errors`, `outbound`, `clicks`,
`contacts`, `surveys` (`"false"` turns each off), `heatmap="true"`, `hash="true"` (count `#/route` pages),
`allow-local="true"`, `respect-gpc="true"` (Global Privacy Control / Do Not Track opt out), `storage="none"`
(nothing stored in the browser), `environment` (feature flag environment). `window.mmRedact = { path, value }`,
set before the script, rewrites or drops every path and text it sends (see `src/redact.ts`).

The wire format types are exported for TypeScript: `import type { Batch } from "@metricmind/tracker/types"`.

## Develop

```sh
bun test          # unit tests
bun run build     # dist/mm.js, dist/survey.js, dist/types.d.ts
```

MIT licensed. See the [repository README](https://github.com/metricmind-si/metricmind) for the privacy rules.
