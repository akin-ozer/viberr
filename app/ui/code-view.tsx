import { useEffect, useState } from "react";
import { highlightCode, type CodeToken } from "./code-highlight";
import { PLAIN_LANGUAGE } from "./code-language";

/**
 * Ruling 363: read-only code with a line-number gutter and Shiki tokens.
 *
 * The lines render plain on the first paint — the text is what the reader
 * came for, and it must never wait on a grammar. `highlightCode` then fetches
 * the language's chunk and tokenizes; when it resolves for THESE inputs the
 * tokens replace the plain text of each line, as classed spans the stylesheet
 * colours (`.tk-keyword` …). A `null` result (no grammar mapped, a load that
 * failed) changes nothing. Line numbers are CSS counters on `.line`; the
 * gutter width follows the digit count so a 12,000-line log lines up too.
 */
export function CodeView({
  text,
  language,
  className,
}: {
  text: string;
  /** A `code-language.ts` id, or `PLAIN_LANGUAGE` for no highlighting. */
  language: string;
  className?: string;
}) {
  const lines = splitLines(text);
  const [highlighted, setHighlighted] = useState<{
    text: string;
    language: string;
    lines: CodeToken[][];
  } | null>(null);
  useEffect(() => {
    if (language === PLAIN_LANGUAGE) return;
    let cancelled = false;
    highlightCode(text, language).then((tokens) => {
      if (!cancelled && tokens) setHighlighted({ text, language, lines: tokens });
    });
    return () => {
      cancelled = true;
    };
  }, [text, language]);
  // Tokens are used only for the inputs they were computed from — a reader
  // that just switched files keeps its new plain lines, not the old colours.
  const tokens =
    highlighted && highlighted.text === text && highlighted.language === language
      ? highlighted.lines
      : null;
  return (
    <pre
      className={"code-view" + (className ? " " + className : "")}
      tabIndex={0}
      data-language={language}
      data-digits={String(lines.length).length}
      data-highlighted={tokens ? "true" : "false"}
    >
      <code>
        {lines.map((line, i) => {
          const lineTokens = tokens?.[i];
          return (
            <span className="line" key={i}>
              {lineTokens
                ? lineTokens.map((token, j) =>
                    token.className ? (
                      <span key={j} className={token.className}>
                        {token.text}
                      </span>
                    ) : (
                      token.text
                    ),
                  )
                : line}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

/** Lines as the gutter counts them: a trailing newline ENDS the last line,
 *  it does not open an empty one after it (the same split Shiki uses, so
 *  token rows and plain rows line up by index). */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
