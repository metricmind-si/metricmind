// The platform-independent core of the MetricMind Flutter SDK: identity,
// sessions, screens, campaigns, the event queue and delivery. Pure Dart (no
// Flutter imports), so it runs and is tested anywhere; the Flutter glue lives
// in metricmind.dart.
import 'dart:async';
import 'dart:convert';
import 'dart:math';

/// Sends HTTP requests. The default uses dart:io's HttpClient.
abstract class Transport {
  /// POSTs JSON; returns the HTTP status, or null on network failure.
  Future<int?> post(Uri url, String body);

  /// GETs; returns the status and body, or null on network failure.
  Future<(int, String)?> get(Uri url);
}

/// Small key/value storage for the install ID, session and unsent events.
/// Reads are synchronous (loaded once at startup), writes may finish later.
abstract class KeyValueStore {
  String? get(String key);
  void put(String key, String? value);
}

/// Storage in memory only: IDs and unsent events don't survive a restart.
class MemoryStore implements KeyValueStore {
  final Map<String, String> values = {};
  @override
  String? get(String key) => values[key];
  @override
  void put(String key, String? value) => value == null ? values.remove(key) : values[key] = value;
}

class FlagResult {
  final bool enabled;
  final String variant;
  const FlagResult(this.enabled, this.variant);
  static const off = FlagResult(false, 'off');
  @override
  bool operator ==(Object other) => other is FlagResult && other.enabled == enabled && other.variant == variant;
  @override
  int get hashCode => Object.hash(enabled, variant);
  @override
  String toString() => 'FlagResult($enabled, $variant)';
}

/// The app, sent once per batch: platform (ios | android), release, OS and form factor.
class AppContext {
  final String platform;
  final String version;
  final String? build;
  final String? osVersion;
  final String? device;
  const AppContext({required this.platform, required this.version, this.build, this.osVersion, this.device});
  Map<String, String> toJson() => {
        'platform': platform,
        'version': version,
        if (build != null) 'build': build!,
        if (osVersion != null) 'os_version': osVersion!,
        if (device != null) 'device': device!,
      };
}

/// A link's utm_* campaign (ref= counts as the source, like on the website).
class Campaign {
  final String? source;
  final String? medium;
  final String? campaign;
  const Campaign({this.source, this.medium, this.campaign});

  /// The campaign of a deep, universal or app link, or null when it has none.
  static Campaign? from(String url) {
    final noFragment = url.split('#').first;
    final at = noFragment.indexOf('?');
    if (at < 0) return null;
    final q = <String, String>{};
    for (final pair in noFragment.substring(at + 1).split('&')) {
      final eq = pair.indexOf('=');
      final k = eq < 0 ? pair : pair.substring(0, eq);
      final v = eq < 0 ? '' : pair.substring(eq + 1);
      try {
        final value = Uri.decodeQueryComponent(v).trim();
        q.putIfAbsent(Uri.decodeQueryComponent(k), () => value.length > 200 ? value.substring(0, 200) : value);
      } catch (_) {
        // malformed escape: skip the pair
      }
    }
    String? value(String name) => (q[name]?.isNotEmpty ?? false) ? q[name] : null;
    final c = Campaign(source: value('utm_source') ?? value('ref'), medium: value('utm_medium'), campaign: value('utm_campaign'));
    return c.source == null && c.medium == null && c.campaign == null ? null : c;
  }

  Map<String, String> toJson() => {
        if (source != null) 'source': source!,
        if (medium != null) 'medium': medium!,
        if (campaign != null) 'campaign': campaign!,
      };

  @override
  bool operator ==(Object other) => other is Campaign && other.source == source && other.medium == medium && other.campaign == campaign;
  @override
  int get hashCode => Object.hash(source, medium, campaign);
  @override
  String toString() => 'Campaign(${toJson()})';
}

/// "Checkout" → "/Checkout"; spaces become dashes (same rule as the other SDKs). Route names stay as they are.
String screenPath(String name) {
  var clean = name.trim().split(RegExp(r'\s+')).where((s) => s.isNotEmpty).join('-');
  while (clean.startsWith('/')) {
    clean = clean.substring(1);
  }
  if (clean.length > 200) clean = clean.substring(0, 200);
  if (clean.isEmpty) return name.trim().startsWith('/') ? '/' : '/unknown'; // Flutter's root route is "/"
  return '/$clean';
}

/// A search term worth recording, or null: emails and phone numbers are never sent.
String? searchTerm(String raw) {
  var term = raw.trim().split(RegExp(r'\s+')).where((s) => s.isNotEmpty).join(' ').toLowerCase();
  if (term.length > 100) term = term.substring(0, 100);
  if (term.isEmpty || term.contains('@') || RegExp(r'\d[\d\s().-]{6,}\d').hasMatch(term)) return null;
  return term;
}

/// A feedback message ready to send: at most 500 characters, emails and phone numbers replaced.
String? feedbackText(String raw) {
  var text = raw.trim().split(RegExp(r'\s+')).where((s) => s.isNotEmpty).join(' ');
  text = text.replaceAll(RegExp(r'[^\s@]+@[^\s@]+\.[^\s@]+'), '[email]').replaceAll(RegExp(r'\+?\d[\d\s().-]{6,}\d'), '[phone]');
  if (text.length > 500) text = text.substring(0, 500);
  return text.isEmpty ? null : text;
}

final _random = Random.secure();

/// A random RFC 4122 version 4 UUID (the event and install ID format ingest validates).
String uuid() {
  final b = List<int>.generate(16, (_) => _random.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

String _cut(String s, int n) => s.length > n ? s.substring(0, n) : s;

const _appKey = '_app';

class _Keys {
  static const visitor = 'mm_visitor', visitorAt = 'mm_visitor_at', session = 'mm_session', user = 'mm_user', queue = 'mm_queue', optOut = 'mm_optout', optIn = 'mm_optin', exposed = 'mm_exposed';
}

class _Screen {
  final String path;
  final String title;
  int? since;
  int engaged;
  final int openedAt;
  bool loaded = false;
  bool ready = false;
  int frames = 0, slowFrames = 0, frozenFrames = 0;
  _Screen(this.path, this.title, this.since, this.engaged) : openedAt = since ?? 0;
}

/// The measurement core.
class Tracker {
  static const defaultEndpoint = 'https://in.metricmind.si/v1/batch';
  static const sessionIdleMs = 30 * 60 * 1000;

  /// Back after this long in the background (or relaunched after it): a new session, as in the store consoles.
  static const backgroundSessionMs = 30 * 1000;
  static const maxBatch = 20;
  static const maxQueue = 300;

  final String site;
  AppContext app;
  final String endpoint;

  /// Which feature flags apply; null or empty serves flags without an environment.
  final String? environment;
  final Transport transport;
  final KeyValueStore store;
  final int Function() now;
  final String? Function() locale;
  final String? Function() timezone;

  /// How long a campaign link waits for the screen it opens before the current screen is counted again.
  final Duration campaignWait;
  String? viewport;

  /// An install ID lasts 13 months from the day it was made, never extended by use (CNIL's recommendation for audience
  /// measurement; 393 days is the shortest 13 calendar months can be).
  static const visitorLifetimeMs = 393 * 86400000;

  /// IDs from before this rule carry no date and count from the day it shipped (2026-11-02 UTC).
  static const visitorLegacyIssued = 1793577600000;

  late String _visitor;
  late int _visitorAt;
  String? _sessionId;
  int _sessionLast = 0;
  int? _backgroundAt;
  String? _user;
  late bool _disabled;
  final List<Map<String, Object?>> _queue = [];
  final Set<String> _exposed = {};
  _Screen? _screen;
  Campaign? _pendingCampaign;
  bool _flushing = false;
  Map<String, FlagResult>? _flagsCache;

  Tracker({
    required this.site,
    required this.app,
    required this.transport,
    KeyValueStore? store,
    this.endpoint = defaultEndpoint,
    int Function()? now,
    String? Function()? locale,
    String? Function()? timezone,
    this.campaignWait = const Duration(seconds: 1),
    bool enabled = true,
    this.environment,
  })  : store = store ?? MemoryStore(),
        now = now ?? (() => DateTime.now().millisecondsSinceEpoch),
        locale = locale ?? (() => null),
        timezone = timezone ?? (() => null) {
    // enabled: false waits for consent: nothing is stored or sent until optIn(), which is remembered.
    _disabled = this.store.get(_Keys.optOut) == '1' || (!enabled && this.store.get(_Keys.optIn) != '1');
    final stored = this.store.get(_Keys.visitor);
    _visitor = stored ?? uuid();
    // No date, a broken one or one from the future: never a reason to keep an ID longer.
    final at = int.tryParse(this.store.get(_Keys.visitorAt) ?? '');
    _visitorAt = stored == null ? this.now() : (at != null && at > 0 && at <= this.now() ? at : visitorLegacyIssued);
    _user = this.store.get(_Keys.user);
    final session = this.store.get(_Keys.session);
    if (session != null && session.contains('|')) {
      _sessionId = session.split('|').first;
      _sessionLast = int.tryParse(session.split('|').last) ?? 0;
      _backgroundAt = _sessionLast; // a launch is a return from the background
    }
    // Events a previous launch couldn't send (offline, killed before flushing).
    try {
      final saved = jsonDecode(this.store.get(_Keys.queue) ?? '[]') as List;
      _queue.addAll(saved.whereType<Map>().map((e) => e.cast<String, Object?>()));
    } catch (_) {}
    _exposed.addAll((this.store.get(_Keys.exposed) ?? '').split('\n').where((s) => s.isNotEmpty));
    if (!_expireVisitor() && !_disabled) _saveVisitor();
  }

  void _saveVisitor() {
    store.put(_Keys.visitor, _visitor);
    store.put(_Keys.visitorAt, '$_visitorAt');
  }

  /// A new install ID once the old one is 13 months old; it starts a new session, or one session would have two IDs.
  bool _expireVisitor() {
    final at = now();
    if (at - _visitorAt < visitorLifetimeMs) return false;
    _visitor = uuid();
    _visitorAt = at;
    _sessionId = null;
    _flagsCache = null;
    if (!_disabled) _saveVisitor();
    return true;
  }

  /// Session ID, rotated after 30 idle minutes (same rule as the website tracker).
  String _touchSession(int at) {
    final away = _backgroundAt != null && at - _backgroundAt! >= backgroundSessionMs;
    _backgroundAt = null;
    final id = (_sessionId != null && !away && at - _sessionLast <= sessionIdleMs) ? _sessionId! : uuid();
    _sessionId = id;
    _sessionLast = at;
    store.put(_Keys.session, '$id|$at');
    return id;
  }

  /// IDs for checkout metadata (mm_visitor, mm_session, mm_user), so Stripe/Paddle revenue is attributed.
  ({String visitor, String? session, String? user}) get ids => (visitor: _visitor, session: _sessionId, user: _user);

  int get pendingCount => _queue.length;

  void _emit(String type, {String? path, String? title, String? name, num? value, Map<String, Object?>? props, String? errorMessage, String? errorStack, Campaign? utm}) {
    if (_disabled) return;
    _expireVisitor();
    final ts = now();
    if (utm != null) _sessionId = null; // a campaign visit is a new session
    final lang = locale();
    final tz = timezone();
    _queue.add({
      _appKey: app.toJson(), // the release that recorded it, even if it's sent after an update
      'id': uuid(),
      'type': type,
      'ts': ts,
      'visitor': _visitor,
      'session': _touchSession(ts),
      if (_user != null) 'user': _user,
      'path': path ?? _screen?.path ?? '/',
      if (title != null) 'title': title,
      if (name != null) 'name': name,
      if (value != null) 'value': value,
      if (props != null) 'props': props,
      if (errorMessage != null) 'error': {'message': _cut(errorMessage, 500), if (errorStack != null) 'stack': _cut(errorStack, 4000)},
      if (utm != null) 'utm': utm.toJson(),
      if (lang != null) 'lang': _cut(lang, 35),
      if (tz != null) 'tz': _cut(tz, 64),
      if (viewport != null) 'viewport': viewport,
    });
    if (_queue.length > maxQueue) _queue.removeRange(0, _queue.length - maxQueue);
    _persist();
    if (_queue.length >= maxBatch) flush();
  }

  void _persist() => store.put(_Keys.queue, jsonEncode(_queue));

  /// One screen view; ends the previous screen with its engaged time.
  void trackScreen(String name, {Map<String, Object?>? props}) {
    final path = screenPath(name);
    if (_screen?.path == path) return;
    _endScreen();
    _screen = _Screen(path, _cut(name, 512), now(), 0);
    final utm = _pendingCampaign;
    _pendingCampaign = null;
    _emit('pageview', path: path, title: _screen!.title, props: props, utm: utm);
  }

  void _endScreen() {
    final s = _screen;
    if (s == null || (s.since == null && s.engaged == 0)) return; // already closed (hidden, then paused)
    final engaged = s.engaged + (s.since != null ? now() - s.since! : 0);
    // Frames rendered while the screen was shown: slow (over one refresh interval) and frozen (over 700 ms).
    final frames = s.frames > 0 ? {'frames': s.frames, 'slow': s.slowFrames, 'frozen': s.frozenFrames} : null;
    _emit('exit', path: s.path, value: min(engaged, 86400000), props: frames);
    s.since = null;
    s.engaged = 0;
    s.frames = s.slowFrames = s.frozenFrames = 0;
  }

  /// A link opened the app. With utm_* parameters it starts a new session credited to
  /// that campaign, whose entry is the screen the link opens. If no screen follows within
  /// [campaignWait] (a link to the screen already shown), the current screen is counted again.
  void openUrl(String url) {
    final c = Campaign.from(url);
    if (c == null) return;
    _pendingCampaign = c;
    if (_screen != null) Timer(campaignWait, () => _recountFor(c));
  }

  void _recountFor(Campaign c) {
    final s = _screen;
    if (!identical(_pendingCampaign, c) || s == null) return; // already used by the next screen
    _endScreen();
    _screen = null;
    trackScreen(s.title);
  }

  /// App went to the background: close the screen's engaged time and send what's queued.
  Future<void> background() {
    _endScreen();
    _backgroundAt ??= now();
    return flush();
  }

  /// Back in the foreground: the current screen keeps counting (a new session after 30 idle minutes).
  /// A resume without a background first (a dialog, a link arriving) keeps the time already counted.
  void foreground() {
    final s = _screen;
    final at = now();
    if (_backgroundAt != null && at - _backgroundAt! >= backgroundSessionMs && s != null) {
      // Back after 30 s or more: a new session, whose entry is the screen the app returns to.
      s.since = at;
      s.engaged = 0;
      _emit('pageview', path: s.path, title: s.title);
      return;
    }
    if (s == null) return; // launching: the first event decides whether it's a new session
    _backgroundAt = null;
    if (s.since == null) s.since = at;
  }

  /// Adds rendered frames to the current screen (sent as totals with its exit).
  void recordFrames(int frames, {required int slow, required int frozen}) {
    final s = _screen;
    if (s == null) return;
    s.frames += frames;
    s.slowFrames += slow;
    s.frozenFrames += frozen;
  }

  /// Time to initial display of the current screen: opened to first frame (once per screen view).
  void screenLoaded(int milliseconds) {
    final s = _screen;
    if (s == null || s.loaded || milliseconds < 0 || milliseconds >= 60000) return;
    s.loaded = true;
    _emit('vital', name: 'SCREEN_LOAD', value: milliseconds, path: s.path);
  }

  /// Time to full display: call when the current screen's content has loaded (once per screen view).
  void screenReady() {
    final s = _screen;
    if (s == null || s.ready) return;
    final ms = now() - s.openedAt;
    if (ms < 0 || ms >= 60000) return;
    s.ready = true;
    _emit('vital', name: 'SCREEN_READY', value: ms, path: s.path);
  }

  void track(String name, {Map<String, Object?>? props}) {
    if (name.isEmpty) return;
    _emit('event', name: _cut(name, 120), props: props);
  }

  /// What a user tells you (your feedback form), with an optional 1–5 rating; linked to the session and release.
  void feedback(String message, {int? rating}) {
    final text = feedbackText(message);
    if (text == null) return;
    track(r'$feedback', props: {'message': text, if (rating != null && rating >= 1 && rating <= 5) 'rating': rating});
  }

  /// Call, WhatsApp, email or chat actions, counted like the website's automatic contact clicks.
  /// [props] say what was contacted ({'category': 'cars'}); never the number or address.
  void contact(String channel, {Map<String, Object?> props = const {}}) =>
      track('contact', props: {...props, 'channel': _cut(channel.toLowerCase(), 40)});

  /// What the user searched for. Emails and phone numbers are never sent.
  /// [results]: how many results the search found, so searches that find nothing stand out.
  void search(String term, {int? results, Map<String, Object?> props = const {}}) {
    final t = searchTerm(term);
    if (t == null) return;
    track('search', props: {
      for (final e in props.entries)
        if (e.key != 'results') e.key: e.value,
      'term': t,
      if (results != null && results >= 0) 'results': results,
    });
  }

  /// Links this install to your user ID (after login). Traits are sent once; only pass what your privacy policy covers.
  void identify(String id, {Map<String, Object?>? traits}) {
    if (id.isEmpty) return;
    final u = _cut(id, 128);
    final changed = u != _user;
    _user = u;
    store.put(_Keys.user, u);
    if (changed) _flagsCache = null;
    if (changed || traits != null) _emit('event', name: r'$identify', props: traits);
  }

  /// Forgets the user (call on logout): new anonymous install ID and session.
  void reset() {
    _user = null;
    _visitor = uuid();
    _visitorAt = now();
    _sessionId = null;
    _flagsCache = null;
    store.put(_Keys.user, null);
    if (!_disabled) _saveVisitor(); // never stored without consent
    store.put(_Keys.session, null);
  }

  /// An error you caught (fatal: false) or one that crashed the app (fatal: true).
  void captureError(Object error, {StackTrace? stack, bool fatal = false}) {
    final message = error is Exception || error is Error ? '${error.runtimeType}: $error' : error.toString();
    _emit('error', props: {'fatal': fatal}, errorMessage: message, errorStack: stack?.toString());
  }

  void optOut() {
    _disabled = true;
    _queue.clear();
    for (final k in [_Keys.queue, _Keys.visitor, _Keys.visitorAt, _Keys.session, _Keys.user]) {
      store.put(k, null);
    }
    store.put(_Keys.optIn, null);
    store.put(_Keys.optOut, '1');
  }

  /// Starts (or resumes) measurement, e.g. after the user consents. Remembered across launches.
  void optIn() {
    _disabled = false;
    store.put(_Keys.optOut, null);
    store.put(_Keys.optIn, '1');
    _saveVisitor();
  }

  /// Whether events are being recorded (false before consent with enabled: false, or after optOut).
  bool get isEnabled => !_disabled;

  /// Sends queued events. Failed batches stay queued (and on disk) for the next try.
  Future<void> flush() async {
    if (_disabled || _flushing) return;
    _flushing = true;
    try {
      while (_queue.isNotEmpty) {
        // One release per batch: a crash saved before an update is sent with the version that crashed.
        final batchApp = _queue.first[_appKey] ?? app.toJson();
        final batch = _queue.take(maxBatch).takeWhile((e) => jsonEncode(e[_appKey] ?? app.toJson()) == jsonEncode(batchApp)).toList();
        final events = [for (final e in batch) Map.of(e)..remove(_appKey)];
        final body = jsonEncode({'site': site, 'app': batchApp, 'events': events});
        int? status;
        try {
          status = await transport.post(Uri.parse(endpoint), body);
        } catch (_) {}
        // Network errors, 429 and 5xx: keep for later. Other 4xx: drop, retrying won't help.
        if (status == null || status >= 500 || status == 429) return;
        _queue.removeRange(0, min(batch.length, _queue.length));
        _persist();
      }
    } finally {
      _flushing = false;
    }
  }

  /// All flags for this install, evaluated by MetricMind's servers (cached until identify/reset).
  Future<Map<String, FlagResult>> flags() async {
    if (_disabled) return {};
    final cached = _flagsCache;
    if (cached != null) return cached;
    final base = endpoint.endsWith('/batch') ? endpoint.substring(0, endpoint.length - 6) : endpoint;
    final url = Uri.parse('$base/flags').replace(queryParameters: {
      'site': site,
      'visitor': _visitor,
      'path': _screen?.path ?? '/',
      'platform': app.platform,
      if (_user != null) 'user': _user!,
      if (environment != null && environment!.isNotEmpty) 'env': environment!,
    });
    (int, String)? res;
    try {
      res = await transport.get(url);
    } catch (_) {}
    if (res == null || res.$1 != 200) return {};
    final out = <String, FlagResult>{};
    try {
      final flags = (jsonDecode(res.$2) as Map)['flags'] as Map;
      flags.forEach((k, v) {
        if (v is Map && v['enabled'] is bool && v['variant'] is String) out[k as String] = FlagResult(v['enabled'] as bool, v['variant'] as String);
      });
    } catch (_) {
      return {};
    }
    _flagsCache = out;
    return out;
  }

  /// One flag; off when unknown or unreachable. Records an exposure once so the dashboard can compare variants.
  Future<FlagResult> flag(String key) async {
    final result = (await flags())[key];
    if (result == null) return FlagResult.off;
    if (_exposed.add('$key=${result.variant}')) {
      store.put(_Keys.exposed, _exposed.toList().reversed.take(50).toList().reversed.join('\n'));
      track(r'$flag', props: {'flag': key, 'variant': result.variant});
    }
    return result;
  }
}
