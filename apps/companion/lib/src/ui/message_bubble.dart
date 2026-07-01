import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:url_launcher/url_launcher.dart' show launchUrl, LaunchMode;

import '../models/bridge_models.dart';
import '../theme.dart';
import 'activity_card.dart';
import 'brand.dart';
import 'markdown.dart';

/// A single conversation row, ChatGPT-style:
///   - user: a compact rounded bubble aligned right
///   - assistant: a full-width row with the Talon avatar + markdown + actions
///   - system: a quiet centered note
class MessageBubble extends StatelessWidget {
  final ClientMessage message;
  final String botName;

  /// Play a one-shot entrance when the row first appears. Only set for freshly
  /// arrived messages — never history or rows recycled back into view on scroll
  /// — so the list stays calm and nothing re-animates while scrolling.
  final bool animateIn;

  /// Fully-resolved URL for an attached image (base URL + token), or null.
  final String? imageUrl;

  const MessageBubble({
    super.key,
    required this.message,
    required this.botName,
    this.animateIn = false,
    this.imageUrl,
  });

  @override
  Widget build(BuildContext context) {
    final Widget row;
    switch (message.role) {
      case Role.system:
        row = _system();
      case Role.user:
        row = _userRow();
      case Role.assistant:
        row = _assistantRow();
    }
    // Respect the platform "reduce motion" setting.
    if (!animateIn || MediaQuery.of(context).disableAnimations) return row;
    return _MessageEntrance(
      // A user message rises from its side; the assistant fades in place.
      fromRight: message.role == Role.user,
      child: row,
    );
  }

  Widget _system() => Padding(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: TalonColors.glassFill,
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: TalonColors.glassStroke),
            ),
            child: Text(
              message.text,
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: TalonColors.textFaint,
                fontSize: 12,
              ),
            ),
          ),
        ),
      );

  Widget _userRow() => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Spacer(flex: 2),
            Flexible(
              flex: 9,
              child: Align(
                alignment: Alignment.centerRight,
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
                  decoration: BoxDecoration(
                    color: TalonColors.surfaceHi,
                    borderRadius: const BorderRadius.only(
                      topLeft: Radius.circular(18),
                      topRight: Radius.circular(18),
                      bottomLeft: Radius.circular(18),
                      bottomRight: Radius.circular(6),
                    ),
                    border: Border.all(color: TalonColors.glassStroke),
                  ),
                  child: SelectableText(
                    message.text,
                    style: const TextStyle(
                      color: TalonColors.text,
                      fontSize: 14.5,
                      height: 1.5,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      );

  Widget _assistantRow() => Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.only(top: 2),
              child: BrandMark(size: 28),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    botName,
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 13.5,
                    ),
                  ),
                  const SizedBox(height: 4),
                  if (message.tools.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: _ToolHistory(tools: message.tools),
                    ),
                  if (imageUrl != null)
                    Padding(
                      padding:
                          EdgeInsets.only(bottom: message.text.isEmpty ? 0 : 8),
                      child: _InlineImage(url: imageUrl!),
                    ),
                  // Suppress the "…" placeholder for an image-only message.
                  if (!(imageUrl != null && message.text.isEmpty))
                    MarkdownBody(
                      data: message.text.isEmpty ? '…' : message.text,
                      selectable: true,
                      onTapLink: (_, href, __) {
                        if (href != null) {
                          launchUrl(Uri.parse(href),
                              mode: LaunchMode.externalApplication);
                        }
                      },
                      styleSheet: talonMarkdownStyle(),
                    ),
                  if (message.buttons.isNotEmpty) _buttons(),
                  if (message.reactions.isNotEmpty) _reactions(),
                  _actions(),
                ],
              ),
            ),
          ],
        ),
      );

  Widget _actions() => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: _CopyButton(text: message.text),
      );

  Widget _buttons() => Padding(
        padding: const EdgeInsets.only(top: 10),
        child: Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final row in message.buttons)
              for (final b in row)
                OutlinedButton(
                  onPressed: b.url == null
                      ? null
                      : () => launchUrl(Uri.parse(b.url!),
                          mode: LaunchMode.externalApplication),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: TalonColors.accent,
                    side: BorderSide(
                        color: TalonColors.accent.withValues(alpha: 0.5)),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10)),
                  ),
                  child: Text(b.text),
                ),
          ],
        ),
      );

  Widget _reactions() => Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Wrap(
          spacing: 4,
          children: [
            for (final r in message.reactions)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: TalonColors.glassFill,
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: TalonColors.glassStroke),
                ),
                child: Text(r, style: const TextStyle(fontSize: 13)),
              ),
          ],
        ),
      );
}

/// One-shot entrance for a freshly-arrived message row: a gentle rise + fade,
/// with a whisper of scale so it settles rather than snaps. Plays exactly once
/// (on first mount); recycled rows never wrap this, so scrolling stays still.
class _MessageEntrance extends StatefulWidget {
  final Widget child;
  final bool fromRight;
  const _MessageEntrance({required this.child, required this.fromRight});

  @override
  State<_MessageEntrance> createState() => _MessageEntranceState();
}

class _MessageEntranceState extends State<_MessageEntrance>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: TalonMotion.base,
  )..forward();

  late final Animation<double> _eased = CurvedAnimation(
    parent: _c,
    curve: TalonMotion.emphasized,
  );

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dx = widget.fromRight ? 0.06 : -0.02;
    return FadeTransition(
      opacity: _eased,
      child: AnimatedBuilder(
        animation: _eased,
        builder: (context, child) {
          final t = _eased.value;
          return Transform.translate(
            offset: Offset(dx * 40 * (1 - t), 10 * (1 - t)),
            child: Transform.scale(
              scale: 0.985 + 0.015 * t,
              alignment: widget.fromRight
                  ? Alignment.centerRight
                  : Alignment.centerLeft,
              child: child,
            ),
          );
        },
        child: widget.child,
      ),
    );
  }
}

/// An inline attached image: rounded, width-capped, tap to open full-screen,
/// with quiet loading and error states so a slow or broken fetch never breaks
/// the row layout.
class _InlineImage extends StatelessWidget {
  final String url;
  const _InlineImage({required this.url});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => _openFull(context),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 320, maxHeight: 320),
          child: Image.network(
            url,
            fit: BoxFit.cover,
            loadingBuilder: (context, child, progress) {
              if (progress == null) return child;
              return Container(
                width: 200,
                height: 150,
                alignment: Alignment.center,
                color: TalonColors.surface,
                child: const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              );
            },
            errorBuilder: (context, _, __) => Container(
              width: 200,
              height: 110,
              alignment: Alignment.center,
              color: TalonColors.surface,
              child: const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.broken_image_outlined,
                      size: 18, color: TalonColors.textFaint),
                  SizedBox(width: 8),
                  Text('Image unavailable',
                      style: TextStyle(
                          color: TalonColors.textFaint, fontSize: 12.5)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _openFull(BuildContext context) {
    Navigator.of(context).push(
      PageRouteBuilder<void>(
        opaque: false,
        barrierColor: Colors.black.withValues(alpha: 0.9),
        pageBuilder: (_, __, ___) => GestureDetector(
          onTap: () => Navigator.of(context).pop(),
          child: Stack(
            children: [
              Center(
                child: InteractiveViewer(
                  maxScale: 5,
                  child: Image.network(url, fit: BoxFit.contain),
                ),
              ),
              Positioned(
                top: 40,
                right: 16,
                child: IconButton(
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close, color: Colors.white),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Collapsed summary of the tools the model ran for an assistant message.
/// Tap to expand and see the chip for each call.
class _ToolHistory extends StatefulWidget {
  final List<ToolActivity> tools;
  const _ToolHistory({required this.tools});

  @override
  State<_ToolHistory> createState() => _ToolHistoryState();
}

class _ToolHistoryState extends State<_ToolHistory> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final tools = widget.tools;
    final failed = tools.where((t) => t.error != null).length;
    final total = Duration(
      milliseconds: tools.fold<int>(0, (a, t) => a + t.elapsed.inMilliseconds),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: () => setState(() => _open = !_open),
          borderRadius: BorderRadius.circular(10),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                AnimatedRotation(
                  duration: const Duration(milliseconds: 160),
                  turns: _open ? 0.25 : 0,
                  child: const Icon(
                    Icons.chevron_right,
                    size: 16,
                    color: TalonColors.textFaint,
                  ),
                ),
                const SizedBox(width: 4),
                Icon(
                  failed > 0 ? Icons.error_outline : Icons.handyman_outlined,
                  size: 13,
                  color: failed > 0 ? TalonColors.bad : TalonColors.textFaint,
                ),
                const SizedBox(width: 6),
                Text(
                  _summary(tools.length, failed, total),
                  style: const TextStyle(
                    color: TalonColors.textFaint,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
        ),
        AnimatedSize(
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOut,
          alignment: Alignment.topLeft,
          child: _open
              ? Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final t in tools)
                        ToolChip(key: ValueKey(t.id), tool: t),
                    ],
                  ),
                )
              : const SizedBox(width: double.infinity),
        ),
      ],
    );
  }

  String _summary(int n, int failed, Duration total) {
    final base = '$n ${n == 1 ? 'tool' : 'tools'} · ${_fmt(total)}';
    if (failed == 0) return base;
    return '$base · $failed failed';
  }

  String _fmt(Duration d) {
    final ms = d.inMilliseconds;
    if (ms < 1000) return '${ms}ms';
    final s = ms / 1000;
    if (s < 10) return '${s.toStringAsFixed(1)}s';
    if (s < 60) return '${s.toStringAsFixed(0)}s';
    final m = (s / 60).floor();
    return '${m}m${(s - m * 60).toStringAsFixed(0)}s';
  }
}

class _CopyButton extends StatefulWidget {
  final String text;
  const _CopyButton({required this.text});

  @override
  State<_CopyButton> createState() => _CopyButtonState();
}

class _CopyButtonState extends State<_CopyButton> {
  bool _copied = false;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () async {
        await Clipboard.setData(ClipboardData(text: widget.text));
        if (!mounted) return;
        setState(() => _copied = true);
        Future.delayed(const Duration(milliseconds: 1400), () {
          if (mounted) setState(() => _copied = false);
        });
      },
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(_copied ? Icons.check : Icons.copy_rounded,
                size: 14, color: TalonColors.textFaint),
            const SizedBox(width: 5),
            Text(
              _copied ? 'Copied' : 'Copy',
              style:
                  const TextStyle(fontSize: 11.5, color: TalonColors.textFaint),
            ),
          ],
        ),
      ),
    );
  }
}
