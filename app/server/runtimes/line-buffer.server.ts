/**
 * Line-buffered NDJSON/JSONL parser. The real adapters now use the official
 * SDKs (which yield parsed objects), but the canonical truth is still the
 * append-only `.jsonl` under runtimes/ — this parser reads those files back
 * (projection rebuild, offline inspection) and remains the safe reader for
 * any raw stream. Buffers chunks and splits on `\n`; events straddle chunk
 * boundaries — the #1 naive-parser bug (runtime-adapters.md §3). Tolerant: a
 * non-JSON line is surfaced via `onInvalid`, never thrown; unknown event
 * types are the caller's concern (both vendors add types between versions).
 *
 * Usage:
 *   const lb = createLineBuffer({ onJson, onInvalid });
 *   for (const chunk of chunks) lb.push(chunk);
 *   lb.flush();
 */

export interface LineBufferOptions {
  /** Called with each successfully parsed JSON object (one per line). */
  onJson: (value: unknown, rawLine: string) => void;
  /** Called for a non-empty line that failed to parse. */
  onInvalid?: (rawLine: string, error: unknown) => void;
}

export interface LineBuffer {
  /** Feed a chunk of text (already decoded from bytes). */
  push(chunk: string): void;
  /** Flush any trailing partial line (call on stream end). */
  flush(): void;
}

export function createLineBuffer(options: LineBufferOptions): LineBuffer {
  let buffer = "";

  const emitLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      options.onInvalid?.(trimmed, error);
      return;
    }
    options.onJson(value, trimmed);
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        emitLine(line);
        newlineIdx = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer.length > 0) {
        emitLine(buffer);
        buffer = "";
      }
    },
  };
}
