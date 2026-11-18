# @metricmind/react-native

MetricMind for React Native and Expo: screens, sessions, custom events, users, errors and crashes, campaign deep
links, feature flags and JavaScript-thread performance. One TypeScript file and no native module, so it ships by
OTA update too.

```sh
npm install @metricmind/react-native @react-native-async-storage/async-storage
```

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { MetricMind } from "@metricmind/react-native";

MetricMind.init({ site: "YOUR_SITE_ID", appVersion: "2.4.1", build: "41", storage: AsyncStorage });
MetricMind.trackNavigation(navigationRef); // React Navigation: one screen view per route
MetricMind.track("purchase", { plan: "pro" });
```

Without `storage`, IDs and unsent events live in memory only. Consent: `init({ ..., enabled: false })` records
nothing until `MetricMind.optIn()`. Errors your own boundary swallows: `MetricMind.captureError(error)`.
Performance numbers are measured on the JavaScript thread and labelled so; turn them off with `performance: false`.

You can also vendor the single file `src/metricmind.ts` instead of installing the package.

MIT licensed. See the [repository README](https://github.com/metricmind-si/metricmind) for the privacy rules.
