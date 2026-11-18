# MetricMind for Flutter

Privacy-first analytics for Flutter apps on iOS and Android: screens, sessions, custom events, users,
Dart and Flutter errors, campaign deep links and feature flags. Pure Dart, no platform plugins.

```yaml
dependencies:
  metricmind: ^0.1.0
```

```dart
import 'package:metricmind/metricmind.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await MetricMind.init(site: 'YOUR_SITE_ID', appVersion: '2.4.1', build: '41');
  runApp(MaterialApp(navigatorObservers: [MetricMind.observer], home: const Home()));
}

MetricMind.screen('Checkout');                       // screens without a route name
MetricMind.track('purchase', props: {'plan': 'pro'});
```

Consent: `MetricMind.init(..., enabled: false)` records nothing until `MetricMind.optIn()`.

Native crashes and native app-start time are not measured (Dart errors are). The site ID comes from
your MetricMind dashboard. See the [repository README](https://github.com/metricmind-si/metricmind) for
what is sent and the privacy rules the code follows. MIT licensed.
