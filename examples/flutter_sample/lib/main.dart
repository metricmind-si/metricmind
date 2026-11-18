// MetricMind Flutter sample: three screens, events, a contact, a search, an
// error and a deep link. Sends to the local ingest by default:
//   flutter run --dart-define=MM_SITE=site_example
// (iOS simulator: localhost; Android emulator: 10.0.2.2.)
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:metricmind/metricmind.dart';

const site = String.fromEnvironment('MM_SITE', defaultValue: 'site_example');
const version = String.fromEnvironment('MM_VERSION', defaultValue: '1.0.0');
const endpointOverride = String.fromEnvironment('MM_ENDPOINT');

String get endpoint => endpointOverride.isNotEmpty ? endpointOverride : 'http://${Platform.isAndroid ? '10.0.2.2' : 'localhost'}:3200/v1/batch';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await MetricMind.init(site: site, appVersion: version, build: '1', endpoint: endpoint);
  runApp(const SampleApp());
}

class SampleApp extends StatelessWidget {
  const SampleApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'MetricMind sample',
        navigatorObservers: [MetricMind.observer],
        onGenerateRoute: (settings) {
          final path = Uri.parse(settings.name ?? '/').path;
          final page = switch (path) { '/listing' => const ListingPage(), '/sell' => const SellPage(), _ => const HomePage() };
          return MaterialPageRoute(settings: settings, builder: (_) => page);
        },
      );
}

class HomePage extends StatelessWidget {
  const HomePage({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Home')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          TextField(key: const Key('search'), decoration: const InputDecoration(labelText: 'Search'), onSubmitted: MetricMind.search),
          FilledButton(key: const Key('open-listing'), onPressed: () => Navigator.pushNamed(context, '/listing'), child: const Text('Open a listing')),
          FilledButton(key: const Key('open-sell'), onPressed: () => Navigator.pushNamed(context, '/sell'), child: const Text('Sell something')),
          OutlinedButton(key: const Key('login'), onPressed: () => MetricMind.identify('sample_user_1', traits: {'plan': 'pro'}), child: const Text('Log in')),
        ]),
      );
}

class ListingPage extends StatelessWidget {
  const ListingPage({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Listing')),
        body: Center(
          child: FilledButton(key: const Key('contact'), onPressed: () => MetricMind.contact('WhatsApp'), child: const Text('Contact the seller')),
        ),
      );
}

class SellPage extends StatelessWidget {
  const SellPage({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Sell')),
        body: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            FilledButton(key: const Key('publish'), onPressed: () => MetricMind.track('listing_published', props: {'category': 'cars'}), child: const Text('Publish')),
            OutlinedButton(key: const Key('break'), onPressed: () => throw StateError('price is missing'), child: const Text('Trigger an error')),
          ]),
        ),
      );
}
