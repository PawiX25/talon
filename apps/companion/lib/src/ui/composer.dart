import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

/// The message input. Enter sends; Shift+Enter inserts a newline. Grows with
/// content up to a cap, then scrolls.
class Composer extends StatefulWidget {
  final Future<void> Function(String text) onSend;
  final bool enabled;
  const Composer({super.key, required this.onSend, required this.enabled});

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _controller = TextEditingController();
  final _focus = FocusNode();
  bool _canSend = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(() {
      final can = _controller.text.trim().isNotEmpty;
      if (can != _canSend) setState(() => _canSend = can);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _controller.text.trim();
    if (text.isEmpty || !widget.enabled) return;
    _controller.clear();
    setState(() => _canSend = false);
    _focus.requestFocus();
    await widget.onSend(text);
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is KeyDownEvent &&
        event.logicalKey == LogicalKeyboardKey.enter &&
        !HardwareKeyboard.instance.isShiftPressed) {
      _send();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final canSend = _canSend && widget.enabled;
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
      child: Container(
        decoration: BoxDecoration(
          color: TalonColors.void1.withValues(alpha: 0.7),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: TalonColors.glassStroke),
        ),
        padding: const EdgeInsets.fromLTRB(16, 4, 6, 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: Focus(
                onKeyEvent: _onKey,
                child: TextField(
                  controller: _controller,
                  focusNode: _focus,
                  enabled: widget.enabled,
                  minLines: 1,
                  maxLines: 6,
                  textInputAction: TextInputAction.newline,
                  keyboardType: TextInputType.multiline,
                  style: const TextStyle(fontSize: 14.5, height: 1.4),
                  decoration: InputDecoration(
                    isCollapsed: true,
                    border: InputBorder.none,
                    contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    hintText: widget.enabled ? 'Message Talon…' : 'Connecting…',
                    hintStyle: const TextStyle(color: TalonColors.textFaint),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 6),
            _SendButton(enabled: canSend, onTap: _send),
          ],
        ),
      ),
    );
  }
}

class _SendButton extends StatefulWidget {
  final bool enabled;
  final VoidCallback onTap;
  const _SendButton({required this.enabled, required this.onTap});

  @override
  State<_SendButton> createState() => _SendButtonState();
}

class _SendButtonState extends State<_SendButton> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget.enabled;
    // Springs up to full size + full colour when there's something to send,
    // dips slightly under the finger, and softens to a flat idle state when
    // the field is empty — a small but legible bit of life.
    return GestureDetector(
      onTapDown: enabled ? (_) => setState(() => _pressed = true) : null,
      onTapUp: enabled ? (_) => setState(() => _pressed = false) : null,
      onTapCancel: enabled ? () => setState(() => _pressed = false) : null,
      onTap: enabled ? widget.onTap : null,
      child: AnimatedScale(
        scale: _pressed
            ? 0.88
            : enabled
                ? 1.0
                : 0.9,
        duration: TalonMotion.fast,
        curve: TalonMotion.emphasized,
        child: AnimatedContainer(
          duration: TalonMotion.base,
          curve: TalonMotion.standard,
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            gradient: enabled ? TalonColors.accentGradient : null,
            color: enabled ? null : TalonColors.surfaceHi,
            borderRadius: BorderRadius.circular(13),
            boxShadow: enabled
                ? [
                    BoxShadow(
                      color: TalonColors.accent.withValues(alpha: 0.35),
                      blurRadius: 14,
                      spreadRadius: -2,
                      offset: const Offset(0, 3),
                    ),
                  ]
                : null,
          ),
          child: Icon(
            Icons.arrow_upward_rounded,
            color: enabled ? Colors.white : TalonColors.textFaint,
            size: 20,
          ),
        ),
      ),
    );
  }
}
