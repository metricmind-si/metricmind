import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:metricmind/metricmind.dart';

import 'tracker_test.dart' show FakeTransport, app;

void main() {
  test('route names become screen paths without the link around them', () {
    expect(routeScreen('/listing?utm_source=qr'), '/listing');
    expect(routeScreen('mmsample:///sell?utm_source=qr&utm_medium=print'), '/sell');
    expect(routeScreen('https://example.com/app/sell#top'), '/app/sell');
    expect(routeScreen('myapp://'), '/');
    expect(routeScreen('Checkout'), 'Checkout');
    expect(routeScreen(''), isNull);
  });

  testWidgets('named routes become screens; deep links credit the campaign; background flushes', (tester) async {
    final t = FakeTransport();
    final tracker = Tracker(site: 'site_123', app: app, transport: t, store: MemoryStore());
    MetricMind.debugUse(tracker);
    addTearDown(() => MetricMind.debugUse(null));

    await tester.pumpWidget(MaterialApp(
      navigatorObservers: [MetricMind.observer],
      initialRoute: '/',
      // Like many routers, keeps the full link (query included) as the route name.
      onGenerateRoute: (settings) => MaterialPageRoute(settings: settings, builder: (_) => Text(settings.name ?? '')),
    ));
    final nav = tester.state<NavigatorState>(find.byType(Navigator));
    nav.pushNamed('/listing');
    await tester.pumpAndSettle();
    nav.pop();
    await tester.pumpAndSettle();
    await tester.binding.handlePushRoute('/listing?utm_source=newsletter');
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 2)); // past the campaign wait: nothing else is counted
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();

    final pageviews = t.events.where((e) => e['type'] == 'pageview').toList();
    // Each route got its time to initial display.
    expect(t.events.where((e) => e['name'] == 'SCREEN_LOAD').map((e) => e['path']), containsAll(['/', '/listing']));
    expect(pageviews.map((e) => e['path']).take(3), ['/', '/listing', '/']);
    // The link's screen is the campaign's entry (no extra view of the screen it replaced),
    // and the link's query never becomes part of a screen.
    expect(pageviews.map((e) => e['path']), ['/', '/listing', '/', '/listing']);
    expect((pageviews.last['utm'] as Map?)?['source'], 'newsletter');
    expect(t.events.every((e) => !(e['path'] as String).contains('?')), isTrue);
    expect(tracker.pendingCount, 0);
  });
}
