import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D5 — the failure-toast honesty gate.
 *
 * decisions.md §UI porting rules, stated as a rule: *"A failure toast must not
 * render the success tick — pass the toast kind explicitly."* The toast icon is
 * the WHOLE signal (the message text is the same for both kinds; the glyph
 * and, since P13-D-10, its colour differ — `app/ui/toast.tsx`, the `.toast`
 * icon rules in app.css), so a refusal pushed with the default `"success"` kind
 * renders a green check over a message that says the action was refused.
 *
 * The rule existed and was written down, and ~10 client-side `push(...)` sites
 * violated it with nothing to catch a new one. This scan is that check: it reads
 * every `push(...)` call in the render layer (`features` / `routes` / `ui`),
 * and fails on any whose message LITERAL is refusal-shaped while the call passes
 * no explicit `"error"` kind.
 *
 * Precision (per the sweep's mandate — low false-positive):
 *  - Only STRING-LITERAL messages are inspected. `push(d.toast)` / `push(p.toast)`
 *    carry no literal to judge and route their failures through the shared
 *    `useActionToast` / `useOrgAction` split (which already passes `"error"`),
 *    so they are out of scope by construction.
 *  - "Has an error kind" is the textual presence of a quoted `"error"` anywhere
 *    in the call — so `push(msg, "error")` AND `push(cond ? "…" : "…", cond ?
 *    "success" : "error")` both pass.
 *  - Comments and identifiers are removed before the scan (a comment that
 *    mentions a refusal, or a `d.error` identifier, must not trip it).
 *
 * Canary: drop the `, "error"` from any fixed site (e.g. connections-panel's
 * "Set another connection as default first") and this test goes red.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const ROOTS = [
  path.join(APP, "features"),
  path.join(APP, "routes"),
  path.join(APP, "ui"),
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|ts)$/.test(entry) && !/\.test\.(tsx|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip `//` line and block comments while keeping newlines (so a reported line
 * matches the source) and PRESERVING string contents (the scan reads them). A
 * char scanner rather than a regex, so a `//` inside a string or a `/` that
 * begins a regex is not mistaken for a comment.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < n) {
        out += src[i];
        if (src[i] === "\\") {
          out += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (src[i] === c) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The balanced-paren argument text of the `push(` whose `(` is at `open`. */
function extractArgs(src: string, open: number): string {
  let depth = 0;
  const start = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(start, i);
    }
  }
  return src.slice(start);
}

/** Every string-literal payload inside an argument list. */
function stringLiterals(args: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    const c = args[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i++;
      let s = "";
      while (i < args.length && args[i] !== c) {
        if (args[i] === "\\") {
          s += args[i + 1] ?? "";
          i += 2;
          continue;
        }
        s += args[i];
        i++;
      }
      out.push(s);
      i++;
    } else i++;
  }
  return out;
}

/**
 * Refusal-shaped message markers. Tuned against the real violations this sweep
 * fixed AND verified to flag none of the app's SUCCESS toasts. Trailing `first`
 * ("… out of X first", "… as default first") is the app's idiomatic
 * precondition-refusal; `valid` covers "enter a valid …".
 */
const REFUSAL =
  /can'?t|cannot|can not|could ?n'?t|could not|\bfailed\b|\bfailure\b|unable|not allowed|\bmust\b|\balready\b|no longer|denied|refus(?:e|ed|al)|reject|invalid|isn'?t|aren'?t|\bfirst\b|needs at least|\bvalid\b/i;

/** A quoted `"error"` (or `'error'`) anywhere in the call = an explicit kind. */
const ERROR_KIND = /(["'])error\1/;

const STANDALONE_PUSH = /(?<![.\w])push\s*\(/g;

interface Violation {
  file: string;
  line: number;
  message: string;
}

function scan(file: string): Violation[] {
  const src = stripComments(readFileSync(file, "utf8"));
  const out: Violation[] = [];
  for (const m of src.matchAll(STANDALONE_PUSH)) {
    const open = m.index! + m[0].length - 1;
    const args = extractArgs(src, open);
    if (ERROR_KIND.test(args)) continue;
    const bad = stringLiterals(args).find((s) => REFUSAL.test(s));
    if (bad) {
      const line = src.slice(0, m.index!).split("\n").length;
      out.push({ file: path.relative(APP, file), line, message: bad.trim() });
    }
  }
  return out;
}

describe("D5: a failure toast passes the error kind (no green tick on a refusal)", () => {
  const files = ROOTS.flatMap(walk);

  it("finds no refusal-shaped push() left on the default success kind", () => {
    const violations = files.flatMap(scan);
    const report = violations
      .map((v) => `  ${v.file}:${v.line} — push("${v.message}") has no "error" kind`)
      .join("\n");
    expect(violations, `\n${report}\n`).toEqual([]);
  });

  it("catches a planted violation (the gate actually bites)", () => {
    // A synthetic source proving the scan flags a refusal pushed as success and
    // clears the same message once the kind is passed.
    const bad = `const p = useToast(); p; push("You can't do that yet");`;
    const good = `push("You can't do that yet", "error");`;
    const withErrorElsewhere = `push(d.ok ? "Saved" : "Save failed", d.ok ? "success" : "error");`;
    const notARefusal = `push("Pinned — it stays at the top");`;
    const flag = (src: string) => {
      if (ERROR_KIND.test(extractArgs(src, src.indexOf("push(") + 4))) return false;
      return stringLiterals(
        extractArgs(src, src.indexOf("push(") + 4),
      ).some((s) => REFUSAL.test(s));
    };
    expect(flag(bad)).toBe(true);
    expect(flag(good)).toBe(false);
    expect(flag(withErrorElsewhere)).toBe(false);
    expect(flag(notARefusal)).toBe(false);
  });
});
