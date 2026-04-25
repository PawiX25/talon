/**
 * Discord message formatting and splitting utilities.
 *
 * Discord supports markdown natively (no HTML conversion like Telegram). The job
 * here is to (a) chunk long messages so they fit Discord's 2000-char per-message
 * limit, splitting at safe boundaries, (b) keep code blocks intact, and (c)
 * provide an escape helper for embedding user-supplied text inside markdown.
 */

export const DISCORD_MAX_TEXT = 2000;
/** Reasonable embed description cap (Discord allows 4096 but field cap matters too). */
export const DISCORD_EMBED_DESCRIPTION_MAX = 4000;

/**
 * Split a message into chunks ≤ max characters, preferring paragraph/newline/space
 * boundaries. Code fences are kept intact: if a split would land inside a fenced
 * block, the block is closed before the split and reopened in the next chunk.
 */
export function splitMessage(text: string, max = DISCORD_MAX_TEXT): string[] {
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  let rest = text;
  let openFence: string | null = null; // tracks an unclosed ``` block carried into next chunk

  while (rest.length > 0) {
    if (rest.length <= max) {
      chunks.push(openFence ? openFence + rest : rest);
      break;
    }

    let at = rest.lastIndexOf("\n\n", max);
    if (at <= max * 0.3) at = rest.lastIndexOf("\n", max);
    if (at <= max * 0.3) at = rest.lastIndexOf(" ", max);
    if (at <= 0) at = max;

    let head = rest.slice(0, at);
    if (openFence) head = openFence + head;

    // Detect unclosed fence in this chunk; if so, close it here and reopen next.
    const fences = head.match(/```/g)?.length ?? 0;
    if (fences % 2 === 1) {
      head = head + "\n```";
      openFence = "```\n";
    } else {
      openFence = null;
    }

    chunks.push(head);
    rest = rest.slice(at).trimStart();
  }

  return chunks;
}

/**
 * Escape user-supplied text so Discord doesn't interpret markdown / mentions.
 * Use ONLY when embedding untrusted text inside a message you're constructing.
 * Do not run on AI output (we want markdown to render).
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([*_`~|>])/g, "\\$1")
    .replace(/^#/gm, "\\#")
    .replace(/^-/gm, "\\-");
}

/**
 * Suppress @everyone, @here, @&role, @userId mentions inside arbitrary text.
 * Wraps each "@" target with a zero-width space so Discord won't ping anyone.
 * Returned text is still readable.
 */
export function suppressMentions(text: string): string {
  return text
    .replace(/@everyone/g, "@​everyone")
    .replace(/@here/g, "@​here")
    .replace(/<@!?\d+>/g, (m) => m.replace("@", "@​"))
    .replace(/<@&\d+>/g, (m) => m.replace("@", "@​"));
}

/** Truncate a string to `max` characters, suffix with "…" if cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

/** Simple HTML-style escape used when displaying raw text inside code blocks. */
export function escapeForCodeBlock(text: string): string {
  // The only sequence that breaks an inline code/code block is a backtick run
  // longer than the wrapper. We can't trivially solve all cases — replace ``` with
  // a zero-width-joiner-separated equivalent so the fence never collides.
  return text.replace(/```/g, "`​``");
}
