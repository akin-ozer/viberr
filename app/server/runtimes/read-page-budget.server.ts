/**
 * Ruling 624: the most one page of an agent's read carries, in UTF-8 bytes,
 * whichever backend the run is on.
 *
 * A Codex model in code mode (`tool_mode: code_mode_only` in the CLI's model
 * catalog; gpt-6-luna is one) reaches every tool through one JavaScript `exec`
 * call, and codex-cli 0.156 cuts what that call prints to the model's
 * `truncation_policy`: 10,000 tokens, counted as UTF-8 bytes / 4, cut from the
 * middle ("…9723 tokens truncated…"). The `tool_output_token_limit` key does
 * not lift it: measured 2026-10-01, a 79 KB print came back cut to 10,000 with
 * the key at 40,000 as without it. So a 48,000-character knowledge-base page
 * arrived with its middle gone and its closing "read on with offset" note
 * intact. Live on aws-cost-calculator AWSC-77 the Cloud Solutions Architect
 * read `mapping.md`'s two pages nine times in fifteen minutes and never saw the
 * rows in the middle of either.
 *
 * 32,000 bytes is 8,000 of those tokens, which leaves room for a page's own
 * note and for a print that JSON-escapes it. The Claude CLI refuses an MCP
 * result over 25,000 real tokens (ruling 436), far above this.
 */
export const READ_PAGE_BYTES = 32_000;

/**
 * Where a page of `text` that starts at `start` ends: the furthest index whose
 * slice fits `maxBytes` of UTF-8. A surrogate pair is never split, and a page
 * always takes at least one character, so a reader paging on `end` moves.
 */
export function pageEnd(text: string, start: number, maxBytes: number = READ_PAGE_BYTES): number {
  let at = Math.max(0, Math.min(start, text.length));
  const first = at;
  let bytes = 0;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    const pair =
      code >= 0xd800 && code <= 0xdbff && at + 1 < text.length && isLowSurrogate(text.charCodeAt(at + 1));
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + width > maxBytes && at > first) break;
    bytes += width;
    at += pair ? 2 : 1;
    if (bytes >= maxBytes) break;
  }
  return at;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
