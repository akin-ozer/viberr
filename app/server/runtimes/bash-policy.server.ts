/**
 * Ruling 101(e), amended 2026-09-11 (Option D PR 5): argument-level denies
 * carry a model-visible reason and cover wrapped command shapes; the denylist
 * remains the fence.
 *
 * A run's `Bash(<prefix>:*)` denies match a command by its leading words. The
 * pinned Claude CLI already splits `&&` and `;` chains and checks each part,
 * but it let `git -C . push` and `sh -c 'git push'` through (measured live on
 * 2026-09-11 against a local remote: both refs landed). This module reads a
 * command the way a shell would split it, unwraps the wrappers that hide a
 * command word, and names the denied prefix a command reaches, for the
 * PreToolUse hook the Claude adapter installs.
 *
 * It is coverage, not containment: a script that pushes, or a binary copied
 * under another name, still runs, and the container plus the server-owned
 * delivery gate stay the boundary (ruling 93).
 */

/** The command prefixes a run's denylist names as `Bash(<prefix>:*)`. */
export function bashDenyPrefixes(denied: readonly string[]): string[] {
  const prefixes: string[] = [];
  for (const rule of denied) {
    const match = /^Bash\((.+):\*\)$/.exec(rule);
    const prefix = match?.[1]?.trim();
    if (prefix && !prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return prefixes;
}

/** Wrappers whose job is to run the command after them. Their own options
 *  (words starting `-`, `VAR=value` for `env`) are skipped. */
const PASS_THROUGH = new Set(["env", "command", "exec", "nohup", "time", "nice", "xargs", "sudo", "doas"]);

/** Shells whose `-c <script>` runs a whole script: it is read like the command. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** git's options that take a separate value word before the subcommand. */
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
]);

/** A command word without its directory: `/usr/bin/git` runs git. */
function commandName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** The index of the `)` closing the `$(` whose body starts at `start`. */
function closingParen(text: string, start: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") i++;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return text.length;
}

/**
 * Split a command line into the simple commands it runs, each as its words.
 * Separators outside quotes end a command (`&&`, `||`, `;`, `|`, `&`, a
 * newline, parentheses, braces); a redirection's `&` (`2>&1`) does not. The
 * bodies of `$(…)` and backticks are commands too, read recursively.
 */
function splitCommands(text: string, out: string[][]): void {
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (ch === "\\") {
      word += text[i + 1] ?? "";
      inWord = true;
      i++;
      continue;
    }
    if (ch === "$" && text[i + 1] === "(") {
      const end = closingParen(text, i + 2);
      splitCommands(text.slice(i + 2, end), out);
      i = end;
      inWord = true;
      continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      const close = end === -1 ? text.length : end;
      splitCommands(text.slice(i + 1, close), out);
      i = close;
      inWord = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "&" && (text[i - 1] === ">" || text[i - 1] === "<")) {
      word += ch;
      inWord = true;
      continue;
    }
    if (";&|\n()".includes(ch)) {
      endCommand();
      continue;
    }
    if (/\s/.test(ch)) {
      endWord();
      continue;
    }
    word += ch;
    inWord = true;
  }
  endCommand();
}

/**
 * The words a simple command runs once its wrappers are peeled: leading
 * `VAR=value` assignments, pass-through wrappers (`env`, `command`, `xargs`,
 * …) and git's own global options (`git -C <dir> -c k=v push` runs
 * `git push`). A shell's `-c <script>` and `eval <words>` are returned as a
 * script to read again instead.
 */
function unwrap(words: readonly string[]): { words: string[] } | { script: string } {
  let rest = [...words];
  for (;;) {
    while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!)) rest = rest.slice(1);
    const name = rest.length ? commandName(rest[0]!) : "";
    if (rest[0] === "{" || rest[0] === "}") {
      rest = rest.slice(1);
      continue;
    }
    if (PASS_THROUGH.has(name)) {
      rest = rest.slice(1);
      while (rest.length && (rest[0]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!))) {
        rest = rest.slice(1);
      }
      // `timeout 60 git push` and `nice -n 5 git push`: a bare number is the
      // wrapper's own argument.
      while (rest.length && /^\d+[smhd]?$/.test(rest[0]!)) rest = rest.slice(1);
      continue;
    }
    if (name === "timeout") {
      rest = rest.slice(1);
      while (rest.length && (rest[0]!.startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(rest[0]!))) {
        rest = rest.slice(1);
      }
      continue;
    }
    break;
  }
  if (!rest.length) return { words: [] };
  const name = commandName(rest[0]!);
  if (name === "eval") return { script: rest.slice(1).join(" ") };
  if (SHELLS.has(name)) {
    const flag = rest.findIndex((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
    if (flag !== -1 && rest[flag + 1] !== undefined) return { script: rest[flag + 1]! };
  }
  if (name === "git") {
    const out = ["git"];
    let i = 1;
    while (i < rest.length && rest[i]!.startsWith("-")) {
      i += GIT_VALUE_OPTIONS.has(rest[i]!) ? 2 : 1;
    }
    return { words: [...out, ...rest.slice(i)] };
  }
  return { words: [name, ...rest.slice(1)] };
}

/** How deep a shell-in-a-shell is read before the rest is left to the fence. */
const MAX_SCRIPT_DEPTH = 4;

/** Every simple command a command line runs, unwrapped, as its words. */
export function simpleCommands(command: string, depth = 0): string[][] {
  const split: string[][] = [];
  splitCommands(command, split);
  const out: string[][] = [];
  for (const words of split) {
    const read = unwrap(words);
    if ("script" in read) {
      if (depth < MAX_SCRIPT_DEPTH) out.push(...simpleCommands(read.script, depth + 1));
    } else if (read.words.length) {
      out.push(read.words);
    }
  }
  return out;
}

/** The denied prefix of the first command in the line that reaches one, word
 *  for word, or null. */
export function deniedPrefixFor(command: string, prefixes: readonly string[]): string | null {
  const wanted = prefixes.map((prefix) => ({ prefix, words: prefix.split(/\s+/).filter(Boolean) }));
  for (const words of simpleCommands(command)) {
    const hit = wanted.find(
      (w) => words.length >= w.words.length && w.words.every((word, i) => words[i] === word),
    );
    if (hit) return hit.prefix;
  }
  return null;
}
