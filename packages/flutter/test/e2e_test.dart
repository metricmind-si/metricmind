import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:metricmind/metricmind.dart';

// Sends real batches through HttpTransport. Run with a local ingest:
//   MM_E2E_ENDPOINT=http://localhost:3200/v1/batch MM_E2E_SITE=site_example flutter test test/e2e_test.dart
void main() {
  final endpoint = Platform.environment['MM_E2E_ENDPOINT'];
  test('delivers to ingest', () async {
    final t = Tracker(
      site: Platform.environment['MM_E2E_SITE'] ?? 'site_example',
      app: const AppContext(platform: 'android', version: '0.0.0-e2e', build: '1', osVersion: '14', device: 'phone'),
      transport: HttpTransport(),
      store: MemoryStore(),
      endpoint: endpoint!,
    );
    t.openUrl('myapp://home?utm_source=flutter-e2e');
    t.trackScreen('Home');
    t.track('e2e_event', props: {'ok': true});
    t.captureError(StateError('e2e error'), stack: StackTrace.current);
    await t.flush();
    expect(t.pendingCount, 0);
  }, skip: endpoint == null ? 'set MM_E2E_ENDPOINT' : false);
}
