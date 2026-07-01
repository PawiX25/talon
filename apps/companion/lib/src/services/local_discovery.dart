import 'dart:convert';
import 'dart:io' show Directory, File, Platform;

import 'package:flutter/foundation.dart';

class LocalBridge {
  final String host;
  final int port;
  final String? token;
  final String scheme;

  const LocalBridge({
    required this.host,
    required this.port,
    required this.scheme,
    this.token,
  });
}

Future<LocalBridge?> readLocalBridge() async {
  if (!_desktopPlatform) return null;
  final dir = _talonDataDir();
  if (dir == null) return null;
  return readLocalBridgeFromDirectory(dir);
}

@visibleForTesting
Future<LocalBridge?> readLocalBridgeFromDirectory(Directory dir) async {
  try {
    final file = File('${dir.path}${Platform.pathSeparator}native-bridge.json');
    final raw = await file.readAsString();
    final decoded = jsonDecode(raw);
    if (decoded is! Map) return null;
    final json = decoded.cast<String, dynamic>();
    final host = json['host'];
    final port = json['port'];
    final token = json['token'];
    final scheme = json['scheme'];
    if (host is! String || host.trim().isEmpty) return null;
    if (port is! int || port < 1 || port > 65535) return null;
    if (token != null && token is! String) return null;
    if (scheme != null && scheme is! String) return null;
    final normalizedScheme = scheme ?? 'http';
    if (normalizedScheme != 'http' && normalizedScheme != 'https') return null;
    return LocalBridge(
      host: host,
      port: port,
      token: token,
      scheme: normalizedScheme,
    );
  } catch (_) {
    return null;
  }
}

Directory? _talonDataDir() {
  final env = Platform.environment;
  final home = Platform.isWindows
      ? (env['USERPROFILE']?.trim().isNotEmpty == true
          ? env['USERPROFILE']!
          : env['HOME'])
      : env['HOME'];
  if (home == null || home.trim().isEmpty) return null;
  return Directory('$home${Platform.pathSeparator}.talon');
}

bool get _desktopPlatform {
  if (kIsWeb) return false;
  try {
    return Platform.isWindows || Platform.isMacOS || Platform.isLinux;
  } catch (_) {
    return false;
  }
}
