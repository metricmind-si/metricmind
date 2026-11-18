// MetricMind for Flutter (iOS and Android): cookieless screens, sessions,
// events, users, errors and campaigns. Copy metricmind.dart and
// metricmind_tracker.dart into lib/, then in main():
//
//   WidgetsFlutterBinding.ensureInitialized();
//   await MetricMind.init(site: 'YOUR_SITE_ID', appVersion: '2.4.1', build: '41');
//   runApp(MaterialApp(navigatorObservers: [MetricMind.observer], ...));
//
//   MetricMind.screen('Checkout');                // screens without a route name
//   MetricMind.track('purchase', props: {'plan': 'pro'});
//
// Screens: named routes are recorded by MetricMind.observer (go_router: give
// routes a name, or pass the observer to GoRouter(observers: [...])).
// Campaigns: links that open the app with utm_source / utm_medium / utm_campaign
// start a session credited to that campaign, read from Flutter's deep linking.
// Errors: uncaught Dart and Flutter framework errors (not native crashes).
//
// Consent: MetricMind.init(..., enabled: false) records nothing until MetricMind.optIn().
//
// Privacy: a random install ID in the app's own storage (no advertising ID, no
// fingerprinting). The IP address is used for the country and never stored.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui';

import 'package:flutter/widgets.dart';

import 'metricmind_tracker.dart';

export 'metricmind_tracker.dart' show AppContext, Campaign, FlagResult, KeyValueStore, MemoryStore, Tracker, Transport;

class MetricMind {
  MetricMind._();

  static Tracker? _tracker;
  static FileStore? _fileStore;
  static _Lifecycle? _lifecycle;

  /// Records a screen view for every named route pushed, popped back to or replaced.
  static final NavigatorObserver observer = _ScreenObserver();

  /// The running tracker (null before init, and on platforms other than iOS and Android).
  static Tracker? get tracker => _tracker;

  /// Starts measurement. Call once in main(), after WidgetsFlutterBinding.ensureInitialized().
  /// With [enabled] false nothing is stored or sent until [optIn] (e.g. after consent); the choice is remembered.
  /// [environment] names which feature flags apply (it matches a flag's environment exactly); without one, flags with no environment are served.
  static Future<Tracker?> init({
    required String site,
    required String appVersion,
    String? build,
    KeyValueStore? store,
    String endpoint = Tracker.defaultEndpoint,
    bool errors = true,
    bool deepLinks = true,
    bool enabled = true,
    String? environment,
    Transport? transport,
  }) async {
    if (_tracker != null) return _tracker;
    if (!Platform.isIOS && !Platform.isAndroid) return null;
    final binding = WidgetsFlutterBinding.ensureInitialized();
    final dispatcher = PlatformDispatcher.instance;
    final kv = store ?? (_fileStore = await FileStore.open());
    final view = dispatcher.implicitView ?? (dispatcher.views.isEmpty ? null : dispatcher.views.first);
    final size = view == null ? null : view.physicalSize / view.devicePixelRatio;
    final t = Tracker(
      site: site,
      app: AppContext(
        platform: Platform.isIOS ? 'ios' : 'android',
        version: _clean(appVersion).isEmpty ? '0' : _clean(appVersion),
        build: build == null ? null : _clean(build),
        osVersion: await _osVersion(),
        device: (size?.shortestSide ?? 0) >= 600 ? 'tablet' : 'phone',
      ),
      transport: transport ?? HttpTransport(),
      store: kv,
      endpoint: endpoint,
      locale: () => dispatcher.locale.toLanguageTag(),
      enabled: enabled,
      environment: environment,
    );
    if (size != null) t.viewport = '${size.width.round()}x${size.height.round()}';
    _tracker = t;
    binding.addObserver(_lifecycle = _Lifecycle(t, deepLinks));
    Timer.periodic(const Duration(seconds: 10), (_) => t.flush());
    // Launched from a link: Flutter puts the deep link in the initial route.
    if (deepLinks) t.openUrl(dispatcher.defaultRouteName);
    if (errors) _installErrorHandlers(t);
    _countFrames(t, dispatcher);
    unawaited(t.flush()); // anything a previous launch couldn't send
    return t;
  }

  static void _installErrorHandlers(Tracker t) {
    final previousFlutter = FlutterError.onError;
    FlutterError.onError = (details) {
      t.captureError(details.exception, stack: details.stack);
      previousFlutter?.call(details);
    };
    final dispatcher = PlatformDispatcher.instance;
    final previousUncaught = dispatcher.onError;
    dispatcher.onError = (error, stack) {
      t.captureError(error, stack: stack);
      return previousUncaught?.call(error, stack) ?? false;
    };
  }

  /// Rendered frames from the engine's frame timings: slow = over one refresh interval, frozen = over 700 ms.
  static void _countFrames(Tracker t, PlatformDispatcher dispatcher) {
    final hz = dispatcher.implicitView?.display.refreshRate ?? 60;
    final budgetUs = (1000000 / (hz >= 30 ? hz : 60)).round();
    WidgetsBinding.instance.addTimingsCallback((timings) {
      var slow = 0, frozen = 0;
      for (final f in timings) {
        final us = f.totalSpan.inMicroseconds;
        if (us > budgetUs) slow++;
        if (us > 700000) frozen++;
      }
      t.recordFrames(timings.length, slow: slow, frozen: frozen);
    });
  }

  static String _clean(String s) {
    final c = s.replaceAll(RegExp(r'[^A-Za-z0-9.+\-_]'), '');
    return c.length > 32 ? c.substring(0, 32) : c;
  }

  static Future<String?> _osVersion() async {
    if (Platform.isIOS) return RegExp(r'(\d+(?:\.\d+)*)').firstMatch(Platform.operatingSystemVersion)?.group(1);
    try {
      final r = await Process.run('getprop', ['ro.build.version.release']).timeout(const Duration(seconds: 1));
      final v = _clean((r.stdout as String).trim());
      return v.isEmpty ? null : v;
    } catch (_) {
      return null;
    }
  }

  /// One screen view (for screens without a named route).
  static void screen(String name, {Map<String, Object?>? props}) => _tracker?.trackScreen(name, props: props);
  static void track(String name, {Map<String, Object?>? props}) => _tracker?.track(name, props: props);

  /// Call when the current screen's content has loaded (its data is on screen): records time to full display.
  static void screenReady() => _tracker?.screenReady();

  /// Call, WhatsApp, email or chat actions, counted as contacts like the website's automatic contact clicks.
  static void contact(String channel, {Map<String, Object?> props = const {}}) => _tracker?.contact(channel, props: props);

  /// What a user tells you (your feedback form), with an optional 1–5 rating. Emails and phone numbers are removed.
  static void feedback(String message, {int? rating}) => _tracker?.feedback(message, rating: rating);

  /// What the user searched for. Emails and phone numbers are never sent.
  static void search(String term, {int? results, Map<String, Object?> props = const {}}) => _tracker?.search(term, results: results, props: props);

  /// After login. Call [reset] on logout.
  static void identify(String id, {Map<String, Object?>? traits}) => _tracker?.identify(id, traits: traits);
  static void reset() => _tracker?.reset();
  static void captureError(Object error, {StackTrace? stack, bool fatal = false}) => _tracker?.captureError(error, stack: stack, fatal: fatal);

  /// A link opened the app outside Flutter's deep linking (app_links, uni_links…): utm_* credit the session.
  static void openUrl(String url) => _tracker?.openUrl(url);
  static Future<FlagResult> flag(String key) => _tracker?.flag(key) ?? Future.value(FlagResult.off);

  /// IDs for checkout metadata (mm_visitor, mm_session, mm_user), so Stripe/Paddle revenue is attributed.
  static ({String visitor, String? session, String? user})? get ids => _tracker?.ids;
  static void optOut() => _tracker?.optOut();
  static void optIn() => _tracker?.optIn();
  static Future<void> flush() => _tracker?.flush() ?? Future.value();

  /// For tests: runs [t] as the app's tracker (lifecycle and deep links included), or forgets it with null.
  @visibleForTesting
  static void debugUse(Tracker? t) {
    final binding = WidgetsBinding.instance;
    if (_lifecycle != null) binding.removeObserver(_lifecycle!);
    _lifecycle = null;
    _tracker = t;
    if (t != null) binding.addObserver(_lifecycle = _Lifecycle(t, true));
  }
}

class _Lifecycle with WidgetsBindingObserver {
  _Lifecycle(this.t, this.deepLinks);
  final Tracker t;
  final bool deepLinks;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      t.foreground();
    } else if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) {
      // Save now (the exit), and again once the send is done: iOS can suspend the app
      // before a delayed write runs, and sent events left on disk would go out twice.
      MetricMind._fileStore?.writeNow();
      unawaited(t.background().whenComplete(() => MetricMind._fileStore?.writeNow()));
    }
  }

  @override
  Future<bool> didPushRouteInformation(RouteInformation routeInformation) async {
    if (deepLinks) t.openUrl(routeInformation.uri.toString());
    return false; // let the app's router handle the link
  }
}

/// The screen for a route name. Deep links can arrive as the whole link
/// ("myapp:///sell?utm_source=qr" on Android) or with a query (tokens, campaign):
/// screens keep the path only.
@visibleForTesting
String? routeScreen(String? name) {
  if (name == null || name.isEmpty) return null;
  final uri = Uri.tryParse(name);
  if (uri != null && uri.hasScheme) return uri.path.isEmpty ? '/' : uri.path;
  return name.split('?').first.split('#').first;
}

class _ScreenObserver extends NavigatorObserver {
  void _report(Route<dynamic>? route) {
    final name = routeScreen(route is PageRoute ? route.settings.name : null);
    if (name == null || name.isEmpty) return;
    MetricMind.screen(name);
    // Time to initial display: from the navigation to the first frame drawn after it.
    final t = MetricMind._tracker;
    if (t == null) return;
    final clock = Stopwatch()..start();
    WidgetsBinding.instance.addPostFrameCallback((_) => t.screenLoaded(clock.elapsedMilliseconds));
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => _report(route);
  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) => _report(previousRoute);
  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) => _report(newRoute);
}

/// Key/value storage in one JSON file in the app's private data directory
/// (Android: files/, iOS: Library/Application Support/), so no plugin is needed.
class FileStore implements KeyValueStore {
  FileStore._(this._file, this._values);
  final File? _file;
  final Map<String, String> _values;
  Timer? _pending;

  static Future<FileStore> open() async {
    try {
      // The temp directory sits inside the app's private container on both platforms.
      final container = Directory.systemTemp.parent.path;
      final dir = Directory(Platform.isIOS ? '$container/Library/Application Support' : '$container/files');
      await dir.create(recursive: true);
      final file = File('${dir.path}/metricmind.json');
      final values = await file.exists() ? (jsonDecode(await file.readAsString()) as Map).cast<String, String>() : <String, String>{};
      return FileStore._(file, values);
    } catch (_) {
      return FileStore._(null, {});
    }
  }

  @override
  String? get(String key) => _values[key];

  @override
  void put(String key, String? value) {
    value == null ? _values.remove(key) : _values[key] = value;
    _pending ??= Timer(const Duration(milliseconds: 200), writeNow);
  }

  /// Writes pending changes now (the app is going to the background).
  void writeNow() {
    _pending?.cancel();
    _pending = null;
    try {
      _file?.writeAsStringSync(jsonEncode(_values), flush: true);
    } catch (_) {}
  }
}

/// HTTP with dart:io (no package dependency).
class HttpTransport implements Transport {
  final HttpClient _client = HttpClient()
    ..connectionTimeout = const Duration(seconds: 10)
    ..userAgent = 'metricmind-flutter/0.1 (${Platform.operatingSystem})';

  @override
  Future<int?> post(Uri url, String body) async {
    try {
      final req = await _client.postUrl(url);
      req.headers.contentType = ContentType.json;
      req.add(utf8.encode(body));
      final res = await req.close().timeout(const Duration(seconds: 15));
      await res.drain<void>();
      return res.statusCode;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<(int, String)?> get(Uri url) async {
    try {
      final req = await _client.getUrl(url);
      final res = await req.close().timeout(const Duration(seconds: 15));
      return (res.statusCode, await res.transform(utf8.decoder).join());
    } catch (_) {
      return null;
    }
  }
}
