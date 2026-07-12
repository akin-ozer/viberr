/**
 * Parses a command line into an executable + argv without invoking a shell.
 * Supports POSIX-style whitespace, single/double quotes, backslash escapes and
 * explicit empty quoted arguments. Malformed quoting is rejected.
 */
export function parseCommandLine(input: string): string[] | null {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  const push = () => {
    if (!started) return;
    args.push(current);
    current = "";
    started = false;
  };

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    current += char;
    started = true;
  }

  if (quote || escaped) return null;
  push();
  return args;
}
