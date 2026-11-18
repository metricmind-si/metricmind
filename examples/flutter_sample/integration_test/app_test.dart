import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:metricmind/metricmind.dart';
import 'package:metricmind_sample/main.dart' as app;

// Drives the real app on a simulator or emulator; the events go to the local
// ingest, and the host checks what ClickHouse stored.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('a short visit', (tester) async {
    // The sample's error button throws on purpose: underneath the SDK's handler
    // (installed by app.main), keep the error from failing the test.
    final errors = <FlutterErrorDetails>[];
    final testHandler = FlutterError.onError;
    FlutterError.onError = errors.add;
    await app.main();
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('search')), 'Golf 7');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.tap(find.byKey(const Key('login')));
    await tester.tap(find.byKey(const Key('open-listing')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('contact')));
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open-sell')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('publish')));
    await tester.tap(find.byKey(const Key('break')));
    await tester.pump();
    // A campaign link while the app is open.
    await tester.binding.handlePushRoute('/listing?utm_source=newsletter&utm_campaign=sample');
    await tester.pumpAndSettle();
    FlutterError.onError = testHandler;
    await MetricMind.flush();
    expect(MetricMind.tracker!.pendingCount, 0);
    expect(errors, isNotEmpty);
  });
}
