import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:metricmind/metricmind_tracker.dart';

class FakeTransport implements Transport {
  int? status = 202;
  final List<Map<String, dynamic>> batches = [];
  final List<Uri> gets = [];
  String flagsBody = '{"flags":{}}';

  @override
  Future<int?> post(Uri url, String body) async {
    if ((status ?? 999) < 300) batches.add(jsonDecode(body) as Map<String, dynamic>);
    return status;
  }

  @override
  Future<(int, String)?> get(Uri url) async {
    gets.add(url);
    return (200, flagsBody);
  }

  List<Map<String, dynamic>> get events => [for (final b in batches) ...(b['events'] as List).cast<Map<String, dynamic>>()];
}

class Clock {
  int ms = 1760000000000;
  void advance(int d) => ms += d;
}

const app = AppContext(platform: 'android', version: '2.4.1', build: '41', osVersion: '14', device: 'phone');

Tracker make(FakeTransport t, MemoryStore s, Clock c) =>
    Tracker(site: 'site_123', app: app, transport: t, store: s, now: () => c.ms, locale: () => 'fr-MA', timezone: () => 'Africa/Casablanca', campaignWait: const Duration(milliseconds: 10));

List<List<Object?>> rows(FakeTransport t) => [for (final e in t.events) [e['type'], e['path'], e['name'] ?? '']];

void main() {
  test('helpers', () {
    expect(screenPath('Checkout'), '/Checkout');
    expect(screenPath('Order details'), '/Order-details');
    expect(screenPath('/Home/Feed'), '/Home/Feed');
    expect(screenPath('/'), '/');
    expect(screenPath('  '), '/unknown');
    expect(searchTerm('  Golf 7 '), 'golf 7');
    expect(searchTerm('jean@example.com'), isNull);
    expect(searchTerm('06 12 34 56 78'), isNull);
    expect(uuid(), matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')));
  });

  test('contacts and searches carry context: category, number of results', () async {
    final t = FakeTransport(), s = MemoryStore(), c = Clock();
    final tr = make(t, s, c);
    tr.trackScreen('listing/[id]');
    tr.contact('Phone', props: {'category': 'cars', 'channel': 'spoofed'});
    tr.search('Golf 7', results: 0, props: {'category': 'cars'});
    tr.search('velo', results: -1);
    await tr.flush();
    final ev = t.events.where((e) => e['type'] == 'event').map((e) => e['props']).toList();
    expect(ev, [
      {'category': 'cars', 'channel': 'phone'},
      {'category': 'cars', 'term': 'golf 7', 'results': 0},
      {'term': 'velo'},
    ]);
  });

  test('screens, engaged time, events and one batch with app context', () async {
    final t = FakeTransport(), s = MemoryStore(), c = Clock();
    final tr = make(t, s, c)..viewport = '393x852';
    tr.trackScreen('Home');
    c.advance(4000);
    tr.trackScreen('Checkout');
    tr.track('purchase', props: {'plan': 'pro', 'amount': 49});
    tr.contact('WhatsApp');
    tr.search('velo electrique');
    await tr.flush();
    expect(t.batches.length, 1);
    expect(t.batches[0]['site'], 'site_123');
    expect(t.batches[0]['app'], {'platform': 'android', 'version': '2.4.1', 'build': '41', 'os_version': '14', 'device': 'phone'});
    expect(rows(t), [
      ['pageview', '/Home', ''],
      ['exit', '/Home', ''],
      ['pageview', '/Checkout', ''],
      ['event', '/Checkout', 'purchase'],
      ['event', '/Checkout', 'contact'],
      ['event', '/Checkout', 'search'],
    ]);
    expect(t.events[1]['value'], 4000);
    expect(t.events[4]['props'], {'channel': 'whatsapp'});
    expect(t.events[3]['props'], {'plan': 'pro', 'amount': 49});
    expect(t.events.map((e) => e['session']).toSet().length, 1);
    expect(t.events[0]['viewport'], '393x852');
    expect(t.events[0]['lang'], 'fr-MA');
  });

  test('new session after 30 idle minutes; background ends engaged time', () async {
    final t = FakeTransport(), s = MemoryStore(), c = Clock();
    final tr = make(t, s, c);
    tr.trackScreen('Home');
    c.advance(10000);
    await tr.background();
    c.advance(31 * 60000);
    tr.foreground();
    tr.trackScreen('Search');
    await tr.flush();
    expect(t.events.where((e) => e['type'] == 'exit').map((e) => e['value'] as int).fold(0, (a, b) => a + b), 10000);
    expect(t.events.where((e) => e['type'] == 'pageview').map((e) => e['session']).toSet().length, 2);
  });

  test('going to the background twice (hidden, then paused) ends the screen once', () async {
    final t = FakeTransport(), c = Clock();
    final tr = make(t, MemoryStore(), c);
    tr.trackScreen('Home');
    c.advance(5000);
    await tr.background();
    await tr.background();
    expect(t.events.where((e) => e['type'] == 'exit').map((e) => e['value']), [5000]);
  });

  test('a resume without a background keeps the time already counted', () async {
    final t = FakeTransport(), c = Clock();
    final tr = make(t, MemoryStore(), c);
    tr.trackScreen('Home');
    c.advance(6000);
    tr.foreground(); // inactive -> resumed (a link arriving, a system dialog)
    c.advance(1000);
    await tr.background();
    expect(t.events.where((e) => e['type'] == 'exit').map((e) => e['value']), [7000]);
  });

  test('sessions: a short trip to the background continues, 30 s or more starts a new one with the screen as entry', () async {
    final t = FakeTransport(), s = MemoryStore(), c = Clock();
    final tr = make(t, s, c);
    tr.trackScreen('Home');
    c.advance(2000);
    await tr.background();
    c.advance(10 * 1000); // 10 s away: same session
    tr.foreground();
    c.advance(2000);
    await tr.background();
    c.advance(45 * 1000); // 45 s away: new session
    tr.foreground();
    tr.track('after_return');
    await tr.flush();
    expect(rows(t), [
      ['pageview', '/Home', ''],
      ['exit', '/Home', ''],
      ['exit', '/Home', ''],
      ['pageview', '/Home', ''],
      ['event', '/Home', 'after_return'],
    ]);
    final sessions = t.events.map((e) => e['session']).toList();
    expect(sessions[2], sessions[0]);
    expect(sessions[3], isNot(sessions[0]));
    expect(sessions[4], sessions[3]);
  });

  test('sessions: a relaunch within 30 s continues, later starts a new one', () async {
    final t = FakeTransport(), s = MemoryStore(), c = Clock();
    final first = make(t, s, c)..trackScreen('Home');
    await first.background();
    c.advance(5000);
    make(t, s, c).trackScreen('Home'); // quick relaunch (e.g. after a crash)
    c.advance(60 * 1000);
    make(t, s, c)
      ..foreground() // a lifecycle "resumed" can arrive before the first screen
      ..trackScreen('Home');
    await make(t, s, c).flush();
    final views = t.events.where((e) => e['type'] == 'pageview').map((e) => e['session']).toList();
    expect(views[1], views[0]);
    expect(views[2], isNot(views[0]));
  });

  test('screen timings: initial display and full display, once per screen view', () async {
    final t = FakeTransport(), c = Clock();
    final tr = make(t, MemoryStore(), c);
    tr.trackScreen('Listing');
    tr.screenLoaded(180);
    tr.screenLoaded(999);
    c.advance(1200);
    tr.screenReady();
    tr.screenReady();
    await tr.flush();
    final vitals = t.events.where((e) => e['type'] == 'vital').map((e) => [e['name'], e['value'], e['path']]).toList();
    expect(vitals, [['SCREEN_LOAD', 180, '/Listing'], ['SCREEN_READY', 1200, '/Listing']]);
  });

  test('feedback: emails and phone numbers removed, ratings outside 1–5 dropped', () async {
    expect(feedbackText('Call me on 06 12 34 56 78 or jean.dupont@example.com  please'), 'Call me on [phone] or [email] please');
    expect(feedbackText('   '), isNull);
    final t = FakeTransport();
    final tr = make(t, MemoryStore(), Clock())..trackScreen('Sell');
    tr.feedback('Publishing keeps failing', rating: 2);
    tr.feedback('Out of range', rating: 9);
    await tr.flush();
    final fb = t.events.where((e) => e['name'] == r'$feedback').toList();
    expect(fb.map((e) => e['props']), [{'message': 'Publishing keeps failing', 'rating': 2}, {'message': 'Out of range'}]);
    expect(fb[0]['path'], '/Sell');
  });

  test('frames travel with the screen exit', () async {
    final t = FakeTransport(), c = Clock();
    final tr = make(t, MemoryStore(), c)..trackScreen('Listing');
    tr.recordFrames(150, slow: 10, frozen: 1);
    c.advance(3000);
    tr.trackScreen('Home');
    await tr.background();
    final exits = t.events.where((e) => e['type'] == 'exit').toList();
    expect(exits[0]['props'], {'frames': 150, 'slow': 10, 'frozen': 1});
    expect(exits[1].containsKey('props'), isFalse);
  });

  test('failed sends stay queued and survive a relaunch', () async {
    final t = FakeTransport()..status = 503;
    final s = MemoryStore(), c = Clock();
    final first = make(t, s, c)..track('signup');
    await first.flush();
    expect(first.pendingCount, 1);
    t.status = 202;
    final relaunched = make(t, s, c);
    expect(relaunched.pendingCount, 1);
    await relaunched.flush();
    expect(t.events.map((e) => e['name']), ['signup']);
    expect(relaunched.pendingCount, 0);
  });

  test('events queued before an app update are sent with the release that recorded them', () async {
    final t = FakeTransport()..status = 503;
    final s = MemoryStore(), c = Clock();
    final old = make(t, s, c)..captureError(StateError('crash'), fatal: true);
    await old.flush(); // offline: the crash stays on the device
    t.status = 202;
    final updated = Tracker(site: 'site_123', app: const AppContext(platform: 'android', version: '2.4.2', build: '42'), transport: t, store: s, now: () => c.ms);
    updated.trackScreen('Home');
    await updated.flush();
    expect(t.batches.map((b) => (b['app'] as Map)['version']), ['2.4.1', '2.4.2']);
    expect((t.batches[0]['events'] as List).single['type'], 'error');
    expect((t.batches[1]['events'] as List).single['type'], 'pageview');
    expect(t.events.every((e) => !e.containsKey('_app')), isTrue);
    expect(updated.pendingCount, 0);
  });

  test('install ID expires 13 months after it was made, however often the app is used', () async {
    final t = FakeTransport(), s = MemoryStore(), c = Clock();
    final a = make(t, s, c);
    final visitor = a.ids.visitor;
    expect(s.get('mm_visitor_at'), isNotNull);
    c.advance(Tracker.visitorLifetimeMs - 1000);
    final b = make(t, s, c); // use doesn't extend it
    b.track('still');
    expect(b.ids.visitor, visitor);
    c.advance(1000);
    b.track('later'); // a run that stays open past the limit changes too
    await b.flush();
    expect(b.ids.visitor, isNot(visitor));
    expect(s.get('mm_visitor'), b.ids.visitor);
    final still = t.events.firstWhere((e) => e['name'] == 'still'), later = t.events.firstWhere((e) => e['name'] == 'later');
    expect(still['visitor'], visitor);
    expect(later['visitor'], b.ids.visitor);
    expect(later['session'], isNot(still['session']));
  });

  test('an install ID without a date counts from the day the rule shipped', () {
    final t = FakeTransport(), s = MemoryStore(), c = Clock();
    s.put('mm_visitor', 'old-id');
    c.ms = Tracker.visitorLegacyIssued + 86400000;
    expect(make(t, s, c).ids.visitor, 'old-id');
    expect(s.get('mm_visitor_at'), '${Tracker.visitorLegacyIssued}');
    c.ms = Tracker.visitorLegacyIssued + Tracker.visitorLifetimeMs;
    expect(make(t, s, c).ids.visitor, isNot('old-id'));
  });

  test('install ID survives relaunch; identify and reset', () async {
    final t = FakeTransport(), s = MemoryStore(), c = Clock();
    final a = make(t, s, c);
    final visitor = a.ids.visitor;
    a.identify('user_42', traits: {'plan': 'pro'});
    await a.flush();
    final b = make(t, s, c);
    expect(b.ids.visitor, visitor);
    expect(b.ids.user, 'user_42');
    b.reset();
    expect(b.ids.visitor, isNot(visitor));
    expect(b.ids.user, isNull);
    expect(t.events.firstWhere((e) => e['name'] == r'$identify')['user'], 'user_42');
  });

  test('errors and opt-out', () async {
    final t = FakeTransport(), s = MemoryStore(), c = Clock();
    final tr = make(t, s, c);
    tr.captureError(StateError('bad state'), stack: StackTrace.current);
    await tr.flush();
    expect(t.events[0]['type'], 'error');
    expect(t.events[0]['props'], {'fatal': false});
    expect((t.events[0]['error'] as Map)['message'], contains('bad state'));
    tr.optOut();
    tr.track('after');
    await tr.flush();
    expect(t.batches.length, 1);
    expect(s.get('mm_optout'), '1');
    expect(s.get('mm_visitor'), isNull);
  });

  test('enabled: false stores and sends nothing until optIn, which is remembered', () async {
    final t = FakeTransport(), s = MemoryStore(), c = Clock();
    Tracker waiting() => Tracker(site: 'site_123', app: app, transport: t, store: s, now: () => c.ms, enabled: false);
    final tr = waiting();
    expect(tr.isEnabled, isFalse);
    tr.trackScreen('Home');
    tr.track('before_consent');
    await tr.flush();
    expect(t.batches, isEmpty);
    expect(s.values, isEmpty); // no install ID written before consent
    tr.optIn();
    tr.track('after_consent');
    await tr.flush();
    expect(t.events.map((e) => e['name']), ['after_consent']);
    final relaunched = waiting(); // consent remembered
    expect(relaunched.isEnabled, isTrue);
    relaunched.optOut(); // withdrawn: off again, also on the next launch
    expect(waiting().isEnabled, isFalse);
  });

  test('flags name the environment only when one is set', () async {
    final t = FakeTransport();
    final c = Clock();
    await make(t, MemoryStore(), c).flags();
    await Tracker(site: 'site_123', app: app, transport: t, store: MemoryStore(), now: () => c.ms, environment: '').flags();
    await Tracker(site: 'site_123', app: app, transport: t, store: MemoryStore(), now: () => c.ms, environment: 'staging').flags();
    expect(t.gets.length, 3);
    expect(t.gets[0].queryParameters.containsKey('env'), isFalse);
    expect(t.gets[1].queryParameters.containsKey('env'), isFalse);
    expect(t.gets[2].queryParameters['env'], 'staging');
  });

  test('flags are evaluated server-side, with one exposure', () async {
    final t = FakeTransport()..flagsBody = '{"flags":{"new-checkout":{"enabled":true,"variant":"on"}}}';
    final tr = make(t, MemoryStore(), Clock());
    expect(await tr.flag('new-checkout'), const FlagResult(true, 'on'));
    expect(await tr.flag('new-checkout'), const FlagResult(true, 'on'));
    expect(await tr.flag('unknown'), FlagResult.off);
    await tr.flush();
    expect(t.gets.length, 1);
    expect(t.gets[0].toString(), startsWith('https://in.metricmind.si/v1/flags?site=site_123'));
    expect(t.gets[0].queryParameters['platform'], 'android');
    expect(t.events.where((e) => e['name'] == r'$flag').length, 1);
  });

  test('campaigns from links', () {
    expect(Campaign.from('myapp://listing/42?utm_source=newsletter&utm_medium=email&utm_campaign=Spring%20sale#top'),
        const Campaign(source: 'newsletter', medium: 'email', campaign: 'Spring sale'));
    expect(Campaign.from('https://example.com/app?ref=producthunt'), const Campaign(source: 'producthunt'));
    expect(Campaign.from('/listing/42?utm_source=qr'), const Campaign(source: 'qr'));
    expect(Campaign.from('myapp://home?id=4'), isNull);
    expect(Campaign.from('/'), isNull);
    expect(Campaign.from('myapp://x?utm_source=%E0%A4%A&utm_medium=cpc'), const Campaign(medium: 'cpc'));
  });

  test('a campaign link credits the screen it opens, in a new session', () async {
    final t = FakeTransport(), c = Clock();
    final tr = make(t, MemoryStore(), c);
    tr.trackScreen('Home');
    c.advance(3000);
    tr.openUrl('myapp://home?id=1'); // no campaign: nothing happens
    tr.openUrl('myapp://listing/42?utm_source=instagram&utm_campaign=launch');
    tr.trackScreen('Listing'); // the router opens the link's screen
    await Future<void>.delayed(const Duration(milliseconds: 30));
    await tr.flush();
    expect(rows(t), [
      ['pageview', '/Home', ''],
      ['exit', '/Home', ''],
      ['pageview', '/Listing', ''],
    ]);
    expect(t.events[2]['utm'], {'source': 'instagram', 'campaign': 'launch'});
    expect(t.events[2]['session'], isNot(t.events[0]['session']));
    expect(t.events[1]['session'], t.events[0]['session']);
  });

  test('a campaign link to the screen already shown counts it again', () async {
    final t = FakeTransport();
    final tr = make(t, MemoryStore(), Clock());
    tr.trackScreen('Home');
    tr.openUrl('myapp://home?utm_source=qr');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    await tr.flush();
    expect(rows(t), [
      ['pageview', '/Home', ''],
      ['exit', '/Home', ''],
      ['pageview', '/Home', ''],
    ]);
    expect(t.events[2]['utm'], {'source': 'qr'});
  });

  test('a cold start link credits the first screen', () async {
    final t = FakeTransport();
    final cold = make(t, MemoryStore(), Clock())..openUrl('myapp://x?utm_source=qr&utm_medium=print');
    cold.trackScreen('Home');
    await cold.flush();
    expect(t.events[0]['utm'], {'source': 'qr', 'medium': 'print'});
    expect(t.events.length, 1);
  });
}
