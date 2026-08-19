import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * F18-14 — the "govern / governor / governance / governed" copy ban.
 *
 * design/CONVERSATION-SUMMARY.md line 22: *"govern/governor/governance is BANNED
 * — use Maintainer (human role), Permissions (panel), 'managed'."* Line 81 calls
 * it out for the Policy page specifically. The ban is about the copy a HUMAN
 * READS — NOT agent system prompts (an agent may legitimately be told it
 * operates under governed delivery; no end user sees that text).
 *
 * Two live violations slipped through 18 passes because nothing enforced it
 * ("No governance events" in the timeline empty state; "Off the governed path:"
 * on the Policy page). The first `it` scans the JSX render layer, strips
 * comments and allows identifiers, and fails on any banned word in rendered
 * text.
 *
 * F19-39 (pass 19) — the render layer was never the whole render surface. A
 * refusal SENTENCE composed on the server is copy a human reads (it becomes the
 * route error, the action toast, the accept-dialog blocker), and
 * `transitionStage` threw *"No governed boundary from X to Y."* for a pass with
 * nothing to catch it. The first widening scanned only `AppError.<factory>(...)`
 * arguments — a CALL SHAPE — and a verifier broke it LIVE three ways:
 *
 *  1. INDIRECTION. `const refusal = \`… governed …\`; throw AppError.conflict(refusal)`
 *     is invisible to a call-shape scan (live instance: `archivedTaskMoveRefusal`
 *     in task-actions.server.ts).
 *  2. `app/schemas/**` was scanned by NEITHER gate — yet `task-file.schema.ts`
 *     is the single source of the archived / closed-PR / conflicting-PR refusal
 *     sentences on the accept dialog. The banned word was inserted there and the
 *     suite stayed green.
 *  3. Non-`AppError` human-facing server copy — timeline `text:`, notification
 *     `title:`/`text:`, action `toast:` — was never in scope at all.
 *
 * So the last `it` stops tracking call shapes. It lexes every pure-TS root and
 * scans EVERY STRING LITERAL, with a narrow per-file allowlist for the only
 * legitimate uses — agent prompt text and the seeded KB doc, both read by a
 * MODEL, never by a person, plus one template ID. Identifiers, comments and log
 * lines are out of scope by construction: an identifier is not a string literal,
 * and the lexer removes comments itself. Anything a human could read is in scope
 * whether or not it reaches them through `AppError`.
 *
 * The two scans between them now cover EVERY source directory under `app/`, so
 * the describe's claim ("every surface a human reads") is literally true rather
 * than aspirational. The split is by SYNTAX, not by importance: `.tsx` cannot be
 * lexed as TypeScript (`</div>` reads as an unterminated regex literal), so the
 * JSX render layer keeps the line-wise scan and the pure-TS half gets the
 * literal scan. `app/ui/**` — the shared component library, i.e. the copy in
 * every button, dialog and empty state — was outside BOTH gates until now, the
 * same "the render layer was never the whole render surface" hole one level up.
 *
 * F19-39 (verifier, round two) — a gate has to enforce its OWN coverage claim.
 * The paragraph above was PROSE: `ROOTS`, `LITERAL_ROOTS` and the single-file
 * lists are hardcoded, so a new top-level directory (`app/widgets/`) or a new
 * top-level `.tsx` beside `root.tsx` reached NEITHER half. A verifier planted
 * the banned word in both and the suite stayed 4/4 green — the same hole that
 * produced this finding twice already (first `app/schemas`, then `app/ui`). It
 * is now an ASSERTION: every entry `readdirSync(app/)` returns must be claimed
 * by a scan or named in `IGNORED_ENTRIES` (empty today — nothing under `app/` is
 * excluded), so adding a source directory fails until someone classifies it.
 *
 * Three narrower escapes closed with it:
 *  - `ALLOW_SUBSTRINGS` exempted the whole LINE, so appending
 *    `const hole = "Off the governed path — ask a Maintainer.";` to a line that
 *    already contained `isGoverned` passed — one line, no ceremony. An exemption
 *    now covers the MARKER only: the markers are cut out and what REMAINS must
 *    be clean.
 *  - the render half had no stale-entry check (the literal half has had one all
 *    along), and had already rotted: five of its nine entries suppressed
 *    nothing. It now mirrors the literal half's check.
 *  - `app/app.css` joins the render scan. A stylesheet renders copy through
 *    `content:`, and both of its `govern` hits are CSS comments the stripper
 *    already removes — so covering it costs nothing and closes the surface.
 *
 * DECISION on `app/server/seed/assets/*.md` (the third `it`): brought UNDER the
 * gate rather than documented as out of scope. They are agent definitions and
 * skill docs — prompt text, the legitimate exempt category — but an org admin
 * READS AND EDITS them in the agent-definition UI, so "no human ever sees this"
 * is false and a blanket exclusion would be a lie. They are scanned like
 * everything else, with each existing prompt sentence exempted BY NAME in
 * `ALLOWED_ASSET_LINES` — same shape and same rot check as `ALLOWED_LITERALS`,
 * whose `operator-run.server.ts` entries are literally the same category (that
 * file's `FALLBACK_OPERATOR_DEFINITION` is a copy of `operator.definition.md`).
 * Prompt text stays legal; a NEW banned sentence in an asset, or a new asset
 * file, fails until someone writes down which category it belongs to.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
/**
 * The JSX render layer, scanned line-wise. `app/ui` is here for syntax reasons
 * only — as rendered copy it outranks most of `app/features`.
 */
const ROOTS = [
  path.join(APP, "features"),
  path.join(APP, "routes"),
  path.join(APP, "ui"),
];
/**
 * Render-layer files that sit directly under `app/` — no directory to walk.
 * `app.css` belongs here for the same reason `app/ui` belongs in `ROOTS`: a
 * stylesheet renders text through `content:`, and the line-wise scan (which
 * strips `/* … *\/`) reads it correctly. CSS has no `//` comment, and the
 * stripper's `[^:]` guard keeps `https://` from acting like one.
 */
const EXTRA_RENDER_FILES = [
  "root.tsx",
  "entry.client.tsx",
  "entry.server.tsx",
  "app.css",
].map((f) => path.join(APP, f));
/**
 * Pure-TypeScript roots, scanned literal-wise. Nothing containing JSX may join
 * this list — the literal test asserts that, because the lexer would otherwise
 * throw on the first closing tag and the failure would read as a lexer bug
 * rather than as "you put a `.tsx` in the wrong scan".
 */
const LITERAL_ROOTS = [
  path.join(APP, "server"),
  path.join(APP, "schemas"),
  path.join(APP, "shared"),
  path.join(APP, "lib"),
];
/** Pure-TS files sitting directly under `app/` — same scan, no directory. */
const LITERAL_FILES = [path.join(APP, "routes.ts")];
/**
 * The ONLY escape hatch from the coverage assertion below: a top-level entry
 * under `app/` that no scan reaches, each named with the reason it is safe to
 * skip. EMPTY — today every entry under `app/` is scanned by one of the three
 * gates, and that is the state worth defending. Dot-entries (`.DS_Store`) and
 * `*.test.ts(x)` are excluded by rule instead: a test is never product copy,
 * and `walk` already refuses test files everywhere else.
 */
const IGNORED_ENTRIES: Readonly<Record<string, string>> = {};
/** The seeded agent definitions / skill docs — prompt text, scanned line-wise. */
const ASSETS = path.join(APP, "server", "seed", "assets");

/** The banned word family, as a rendered-copy regex (word-ish boundaries). */
const BANNED = /\bgovern(ance|ed|or|ors|ing|s)?\b/i;

/**
 * Allowed uses that are NOT rendered UI copy shown to an end user: code
 * identifiers spelled with `governed` as a whole word — machinery, never
 * rendered. Each entry exempts ITSELF, not the line it sits on (see `redact`).
 *
 * There is NO rendered-copy exception. The login tagline had "governed" removed
 * at design time (design/CONVERSATION-SUMMARY.md L182: *"'Self-hosted ·
 * collaborative agentic AI delivery' (word 'governed' removed)"*), so the login
 * hero is subject to the ban like every other surface — not allowlisted.
 *
 * Five entries were deleted when the stale check went in, and WHY they were
 * dead is the useful part: `GOVERNED_TEMPLATE`, `GOVERNED_CAP_LABELS` and
 * `isGoverned` never needed exempting at all, because `BANNED`'s `\b` already
 * fails against an adjacent word char (`GOVERNED_`, `isGoverned`) — they only
 * looked load-bearing. `governed-5` (both spellings) appears in the render layer
 * ZERO times; its one definition lives in `shared/workflow/templates.ts` and is
 * covered by `ALLOWED_LITERALS` instead.
 */
const ALLOW_SUBSTRINGS = [
  "const governed =",
  "governed.direct",
  "governed.recommend",
  "governed.forbidden",
];

/**
 * Cut every allowed marker out of `line` and hand back what survives. This is
 * what makes an exemption cover the MARKER rather than the whole line: the
 * verifier appended `const hole = "Off the governed path — ask a Maintainer.";`
 * to a line that already contained `isGoverned` and a line-granular allowlist
 * waved it through. Longest marker first, so a marker that contains another
 * cannot be half-eaten and leave a banned fragment behind.
 */
function redact(line: string, markers: readonly string[]): string {
  let out = line;
  for (const marker of [...markers].sort((a, b) => b.length - a.length)) {
    out = out.split(marker).join(" ");
  }
  return out;
}

/**
 * Strip `//` line comments and block comments while PRESERVING line count, so a
 * reported line number matches the source. A comment that explains the ban (like
 * this file's own docblock) must never trip the gate.
 *
 * ONE alternation, ONE left-to-right pass — the order is load-bearing and two
 * sequential passes get it wrong in BOTH directions (both found by canarying):
 *
 *  - block-first blinds the gate: a `//` comment that merely MENTIONS a glob —
 *    the sentence "scans `app/server/**` too" — puts a `/*` in the source, and a
 *    block-first pass treats it as a real opener and BLANKS EVERY LINE up to the
 *    next `*\/`, swallowing whatever violation lived in between.
 *  - line-first blinds it too: in `/* note // see above *\/` the line pass eats
 *    `// see above *\/`, leaving the `/*` unterminated, so the block pass runs
 *    on to the NEXT `*\/` and blanks the real code in between.
 *
 * A single regex alternation cannot do either: at every position the earliest
 * comment opener wins, which is exactly the tokenizer rule. The `[^:]` guard
 * keeps a `://` inside a URL from reading as a line comment.
 */
function stripComments(src: string): string {
  return src.replace(
    /\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/gm,
    (match, before?: string) =>
      before === undefined ? match.replace(/[^\n]/g, " ") : before,
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(tsx|ts)$/.test(entry) && !/\.test\.(tsx|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Every file under `dir`, whatever its extension — the seed assets are `.md`. */
function walkAll(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkAll(full));
    else out.push(full);
  }
  return out;
}

/** One string literal (or one static chunk of a template literal). */
type Literal = { start: number; text: string };

const IDENT_CHAR = /[A-Za-z0-9_$]/;
/** Chars after which a `/` opens a REGEX rather than a division. */
const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%^~<>".split(""));
/** Keywords after which a `/` opens a regex. */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "do",
  "else",
  "yield",
  "await",
  "new",
  "delete",
  "void",
  "instanceof",
]);

/**
 * Lex a `.ts` source into its string literals. A real left-to-right tokenizer,
 * not a regex sweep, because the three things that hide a literal from a regex —
 * comments, regex literals (which may contain quotes) and `${}` interpolation
 * (which contains CODE, not copy) — can only be told apart in order.
 *
 * Template literals contribute their STATIC chunks; the expressions inside
 * `${…}` are lexed as code, so `${isGoverned ? …}` is an identifier, not copy.
 *
 * Anything it cannot terminate (an unclosed string, template or regex) THROWS.
 * That is deliberate: a desynced lexer would silently stop seeing literals, and
 * a gate that silently sees nothing is worse than no gate. Failing loudly is the
 * only acceptable failure mode here.
 *
 * It also returns the `residue` — the source with every comment, regex and
 * literal (delimiters included) blanked out. The caller asserts the residue
 * holds no quote character at all, which PROVES no string was skipped: a
 * swallowed region would leave its quotes behind. Without that proof "0
 * offenders" and "0 literals seen" are the same green.
 */
function lexLiterals(src: string, label: string) {
  const literals: Literal[] = [];
  const residue = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < residue.length; k += 1) {
      if (residue[k] !== "\n") residue[k] = " ";
    }
  };
  const stack: Array<{ kind: "code"; braces: number } | { kind: "template" }> = [
    { kind: "code", braces: 0 },
  ];
  let prevChar = "";
  let prevWord = "";
  let i = 0;

  const fail = (at: number, what: string): never => {
    throw new Error(`copy-ban lexer desynced in ${label} at offset ${at}: ${what}`);
  };

  while (i < src.length) {
    const frame = stack[stack.length - 1]!;

    if (frame.kind === "template") {
      const start = i;
      let j = i;
      while (j < src.length) {
        const c = src[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "`") break;
        if (c === "$" && src[j + 1] === "{") break;
        j += 1;
      }
      if (j > start) literals.push({ start, text: src.slice(start, j) });
      if (j >= src.length) fail(start, "unterminated template literal");
      blank(start, j);
      if (src[j] === "`") {
        stack.pop();
        blank(j, j + 1);
        prevChar = "`";
        i = j + 1;
      } else {
        stack.push({ kind: "code", braces: 0 });
        prevChar = "{";
        i = j + 2;
      }
      continue;
    }

    const ch = src[i]!;

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }

    // Comments — removed here, so no separate stripping pass can blind us.
    if (ch === "/" && src[i + 1] === "/") {
      const start = i;
      while (i < src.length && src[i] !== "\n") i += 1;
      blank(start, i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close === -1) fail(i, "unterminated block comment");
      blank(i, close + 2);
      i = close + 2;
      continue;
    }

    // Regex literal — may contain quotes, so it MUST be consumed as one token.
    if (
      ch === "/" &&
      (REGEX_AFTER.has(prevChar) ||
        prevChar === "" ||
        REGEX_AFTER_WORD.has(prevWord))
    ) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        const c = src[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) fail(i, "unterminated regex literal");
      const from = i;
      i = j + 1;
      while (i < src.length && IDENT_CHAR.test(src[i]!)) i += 1;
      blank(from, i);
      prevChar = "/";
      prevWord = "";
      continue;
    }

    if (ch === '"' || ch === "'") {
      const start = i + 1;
      let j = start;
      while (j < src.length) {
        const c = src[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === ch) break;
        if (c === "\n") fail(start, "unterminated string literal");
        j += 1;
      }
      if (j >= src.length) fail(start, "unterminated string literal");
      literals.push({ start, text: src.slice(start, j) });
      blank(i, j + 1);
      prevChar = ch;
      prevWord = "";
      i = j + 1;
      continue;
    }

    if (ch === "`") {
      stack.push({ kind: "template" });
      blank(i, i + 1);
      i += 1;
      continue;
    }

    if (IDENT_CHAR.test(ch)) {
      let j = i;
      while (j < src.length && IDENT_CHAR.test(src[j]!)) j += 1;
      prevWord = src.slice(i, j);
      prevChar = src[j - 1]!;
      i = j;
      continue;
    }

    if (ch === "{") {
      frame.braces += 1;
    } else if (ch === "}") {
      if (frame.braces === 0 && stack.length > 1) {
        stack.pop();
        prevChar = "}";
        prevWord = "";
        i += 1;
        continue;
      }
      if (frame.braces > 0) frame.braces -= 1;
    }
    prevChar = ch;
    prevWord = "";
    i += 1;
  }

  if (stack.length !== 1) fail(src.length, "unbalanced template/interpolation");
  return { literals, residue: residue.join("") };
}

/**
 * The NARROW allowlist for the literal scan: the exemption applies only to a
 * literal in `file` that CONTAINS `contains`, and each marker is the banned
 * sentence itself — so the exemption cannot drift onto a neighbouring string.
 *
 * Every entry is text only an AGENT reads. Agents are deliberately told they
 * operate under governed delivery (that is the machinery's real name in the
 * prompt contract); the ban is on what an END USER reads. Reviewed by sweeping
 * every literal in both roots — this is the complete legitimate set, and there
 * are no others.
 *
 * An entry that matches NOTHING fails the suite. That keeps the list from
 * rotting into a blanket exemption after the copy it was written for moves or
 * dies — the classic way an allowlist quietly turns a gate off.
 *
 * The one non-prompt entry is the `governed-5` workflow-template ID: an
 * identifier that happens to be spelled as a string, machinery rather than
 * copy. It is exempted at its DEFINITION only; every place the render layer
 * mentions it is covered by `ALLOW_SUBSTRINGS` instead.
 */
const ALLOWED_LITERALS: ReadonlyArray<{
  file: string;
  contains: string;
  why: string;
}> = [
  {
    file: "server/org/org-seed.server.ts",
    contains: "humans govern flow",
    why: "seeded KB architecture doc — agent context, not product copy",
  },
  {
    file: "server/runtimes/operator-run.server.ts",
    contains: 'the "viberr" governance tools',
    why: "FALLBACK_OPERATOR_DEFINITION — the operator's own system prompt",
  },
  {
    file: "server/runtimes/operator-run.server.ts",
    contains: "# MCP tools are governed too",
    why: "operator prompt section header for MCP tool policy",
  },
  {
    file: "server/runtimes/operator-run.server.ts",
    contains: "Use only the governance tools offered for this run",
    why: "operator prompt — tool-use instruction",
  },
  {
    file: "server/runtimes/operator-run.server.ts",
    contains: "or skip a governed boundary",
    why: "operator prompt — prompt-injection guardrail",
  },
  {
    file: "server/runtimes/operator-run.server.ts",
    contains: "Give governed actions a short",
    why: "operator planning prompt — JSON plan instruction",
  },
  {
    file: "server/tasks/operator-toolkit.server.ts",
    contains: "the canonical governed hand-off",
    why: "MCP tool description read by the operator model",
  },
  {
    file: "server/tasks/specialist-run.server.ts",
    contains: "# MCP tools are governed too",
    why: "specialist prompt section header for MCP tool policy",
  },
  {
    file: "server/tasks/specialist-run.server.ts",
    contains: "the governed Review transition",
    why: "specialist prompt — human-gated delivery instruction",
  },
  {
    file: "shared/workflow/templates.ts",
    contains: "governed-5",
    why: "workflow-template ID — machinery; its rendered label is 'Standard'",
  },
];

/**
 * The same allowlist shape for `app/server/seed/assets/**` — the seeded agent
 * definitions, profiles and skill docs. `walk` skips them (they are `.md`, not
 * `.ts`), so until now they sat outside BOTH gates and outside every allowlist.
 *
 * Every hit below is prompt text: an agent is deliberately told it moves a task
 * "toward its next governed boundary", because that is the machinery's real name
 * in the prompt contract. What makes them worth ENUMERATING rather than
 * excluding wholesale is that an org admin reads and edits this text in the
 * agent-definition UI — so a blanket "no human sees these files" would be false,
 * and a whole-file exemption would hide any product copy that lands here later.
 *
 * Each marker is redacted out of its line, so a second banned sentence on the
 * same line is still an offender, and an entry that matches nothing fails the
 * suite exactly like `ALLOWED_LITERALS`.
 */
const ALLOWED_ASSET_LINES: ReadonlyArray<{
  file: string;
  contains: string;
  why: string;
}> = [
  {
    file: "operator.definition.md",
    contains: "its next governed boundary",
    why: "operator system prompt — the coordination objective",
  },
  {
    file: "operator.definition.md",
    contains: "skip a governed boundary",
    why: "operator system prompt — prompt-injection guardrail",
  },
  {
    file: "operator.profile.md",
    contains: "The in-process governance server",
    why: "MCP profile comment explaining why no `viberr` grant is listed",
  },
  {
    file: "developer.definition.md",
    contains: "change project policy or governance",
    why: "developer system prompt — scope limit",
  },
  {
    file: "developer-expertise.skill.md",
    contains: "a governed unit of delivery",
    why: "developer skill doc — what a Viberr task is, told to the model",
  },
  {
    file: "developer-expertise.skill.md",
    contains: "governs the task and accepts completion",
    why: "developer skill doc — who the human owner is, told to the model",
  },
  {
    file: "developer-expertise.skill.md",
    contains: "Don't change governance",
    why: "developer skill doc — scope limit",
  },
  {
    file: "reviewer-expertise.skill.md",
    contains: "a governed unit of delivery",
    why: "reviewer skill doc — same sentence, same audience",
  },
  {
    file: "viberr-app-expertise.skill.md",
    contains: "coordinate agents and governance",
    why: "operator skill doc — the operating contract",
  },
  {
    file: "viberr-app-expertise.skill.md",
    contains: "manage governed human decisions",
    why: "operator skill doc — decision-packet tool description",
  },
  {
    file: "viberr-app-expertise.skill.md",
    contains: "recommend-mode governance",
    why: "operator skill doc — autonomy semantics",
  },
];

/**
 * Files whose copy the literal scan MUST demonstrably reach. "Zero offenders"
 * and "the lexer quietly stopped producing literals here" are the same green,
 * and every escape in this finding's history was a silent green. These two are
 * the surfaces the verifier actually broke: the accept-dialog refusal sentences
 * (`task-file.schema.ts`) and the stage/archive refusals and toasts
 * (`task-actions.server.ts`). The assertion is on SHAPE, not on wording, so it
 * proves reach without pinning copy another pass is free to rewrite.
 */
const MUST_SEE_COPY = [
  "schemas/task-file.schema.ts",
  "server/tasks/task-actions.server.ts",
];

/** Sentence-shaped: two real words, long enough to be prose rather than a key. */
const SENTENCE = /[A-Za-z]{3,}\s+[A-Za-z]{3,}/;

/** Map a char offset to its 1-based line number. */
function lineIndex(src: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === "\n") starts.push(i + 1);
  }
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

describe("F18-14: the govern/governance copy ban holds on every surface a human reads", () => {
  it("no rendered UI copy under app/features, app/routes, app/ui or app.css contains a banned word", () => {
    const offenders: string[] = [];
    const used = new Set<number>();
    const files = [...ROOTS.flatMap(walk), ...EXTRA_RENDER_FILES];
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"));
      src.split("\n").forEach((line, i) => {
        if (!BANNED.test(line)) return;
        ALLOW_SUBSTRINGS.forEach((a, idx) => {
          if (line.includes(a)) used.add(idx);
        });
        // The exemption covers the identifier, NOT the line it sits on: cut the
        // allowed markers out and whatever is left must be clean.
        if (!BANNED.test(redact(line, ALLOW_SUBSTRINGS))) return;
        offenders.push(
          `${path.relative(APP, file)}:${i + 1} → ${line.trim().slice(0, 100)}`,
        );
      });
    }
    // A gate that scans nothing passes everything.
    expect(files.length).toBeGreaterThan(100);
    expect(offenders, `banned "govern*" word in rendered copy:\n${offenders.join("\n")}`).toEqual([]);
    // Same rot guard the literal half has always had: an entry that suppresses
    // nothing is an exemption nobody is checking, and the list decays into a
    // blanket one. (It already had: five of nine entries were dead.)
    const stale = ALLOW_SUBSTRINGS.filter((_, i) => !used.has(i));
    expect(
      stale,
      `render allowlist entries that suppress nothing:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  /**
   * The coverage claim, as an assertion instead of a docblock sentence. Both
   * scans start from hardcoded lists, so a new top-level directory under `app/`
   * (the verifier used `app/widgets/banner.tsx`) or a new top-level file beside
   * `root.tsx` (`app/error-boundary.tsx`) escaped BOTH and the suite stayed
   * green. Twice before, that same hole was found the same way — once for
   * `app/schemas`, once for `app/ui`. Now it fails until someone classifies it.
   */
  it("every top-level entry under app/ is claimed by a scan — a new source directory cannot escape", () => {
    const claimed = [
      ...ROOTS,
      ...LITERAL_ROOTS,
      ...EXTRA_RENDER_FILES,
      ...LITERAL_FILES,
    ];
    // The comparison below is by basename, so a claim that is NOT a direct child
    // of `app/` would silently "cover" an entry it never scans.
    expect(
      claimed.filter((p) => path.dirname(p) !== APP).map((p) => path.relative(APP, p)),
      "a scan root/file that is not a direct child of app/ breaks the coverage math",
    ).toEqual([]);
    const covered = new Set(claimed.map((p) => path.basename(p)));
    const unclassified = readdirSync(APP).filter((entry) => {
      if (covered.has(entry)) return false;
      if (Object.hasOwn(IGNORED_ENTRIES, entry)) return false;
      if (entry.startsWith(".")) return false; // .DS_Store and friends
      const full = path.join(APP, entry);
      // A test file is never product copy — `walk` refuses them everywhere else.
      return !(statSync(full).isFile() && /\.test\.(tsx|ts)$/.test(entry));
    });
    expect(
      unclassified,
      `top-level entry under app/ that NO copy-ban scan reaches — add it to ROOTS (JSX), LITERAL_ROOTS/LITERAL_FILES (pure TS), EXTRA_RENDER_FILES, or IGNORED_ENTRIES with a reason:\n${unclassified.join("\n")}`,
    ).toEqual([]);
    // …and the escape hatch rots like every other allowlist.
    const goneIgnores = Object.keys(IGNORED_ENTRIES).filter(
      (entry) => !existsSync(path.join(APP, entry)),
    );
    expect(
      goneIgnores,
      `IGNORED_ENTRIES names something that no longer exists:\n${goneIgnores.join("\n")}`,
    ).toEqual([]);
  });

  it("the comment stripper survives either opener nested inside the other", () => {
    // Both directions of the two-pass bug, as source the stripper must survive.
    // Line 1 hides a `//` inside a block comment (breaks LINE-first); line 2
    // hides a `/*` — the `**` of a glob — inside a line comment, and line 4
    // supplies the `*/` a block-first pass would run on to (breaks BLOCK-first).
    const src = [
      `const a = 1; /* note // see above */ const banned = "governance";`,
      `// mentions app/server/** in prose`,
      `const kept = "governed";`,
      `/* a real block comment */ const also = "governor";`,
      `const url = "https://x.test/a"; const tail = "governors";`,
    ].join("\n");
    const stripped = stripComments(src);
    // Line count is preserved, so reported line numbers stay true.
    expect(stripped.split("\n")).toHaveLength(5);
    // Nothing outside a comment may be blanked …
    expect(stripped).toContain('const banned = "governance"');
    expect(stripped).toContain('const kept = "governed"');
    expect(stripped).toContain('const also = "governor"');
    // … including code after a `://`, which must not read as a line comment …
    expect(stripped).toContain('const tail = "governors"');
    // … and everything inside a comment must be.
    expect(stripped).not.toContain("see above");
    expect(stripped).not.toContain("in prose");
    expect(stripped).not.toContain("a real block comment");
  });

  it("the literal lexer reads copy through indirection and anchors it to the string's own line", () => {
    const src = [
      `const re = /it's fine/; // a regex may hold quotes; a comment is not copy`,
      `/* note // see above */`,
      `const refusal =`,
      `  "TASK-1 is archived — restore it before moving it between stages.";`,
      `throw AppError.conflict(`,
      `  refusal,`,
      `);`,
      'const t = `stage ${isGoverned ? "direct" : "gated"} moved`;',
    ].join("\n");
    const { literals, residue } = lexLiterals(src, "fixture.ts");
    const lineOf = lineIndex(src);
    const texts = literals.map((l) => l.text);
    const joined = texts.join("|");

    // The refusal is a CONST, never an argument to a known factory — the whole
    // point: a call-shape scan cannot see it, a literal scan always can.
    const refusal = literals.find((l) => l.text.startsWith("TASK-1"));
    expect(refusal).toBeDefined();
    // Anchored to the STRING's line (4), not to `AppError.conflict(` on line 5.
    expect(lineOf(refusal!.start)).toBe(4);

    // A regex's contents and a comment's contents are not copy …
    expect(joined).not.toContain("it's fine");
    expect(joined).not.toContain("see above");
    expect(joined).not.toContain("a regex may hold quotes");
    // … and the code inside `${…}` is code, not copy.
    expect(joined).not.toContain("isGoverned");
    expect(texts).toContain("stage ");
    expect(texts).toContain(" moved");
    expect(texts).toContain("direct");
    // Nothing was walked past.
    expect(residue).not.toMatch(/["'`]/);
  });

  /**
   * F19-39 — the same ban on the OTHER surface a human reads: sentences composed
   * on the server. Scanned as LITERALS, not as arguments to a known call, so the
   * three live escapes (a refusal hoisted into a const, `app/schemas/**`, and
   * timeline/notification/toast text) are all in scope.
   */
  it("no string literal under app/server, app/schemas, app/shared or app/lib contains a banned word", () => {
    const offenders: string[] = [];
    const skipped: string[] = [];
    const jsx: string[] = [];
    const sawCopyIn = new Set<string>();
    const used = new Set<number>();
    let scanned = 0;

    for (const file of [...LITERAL_ROOTS.flatMap(walk), ...LITERAL_FILES]) {
      scanned += 1;
      const rel = path.relative(APP, file);
      // A `.tsx` here would die on its first closing tag (`</div>` lexes as an
      // unterminated regex). Name the real mistake instead.
      if (file.endsWith(".tsx")) {
        jsx.push(rel);
        continue;
      }
      const src = readFileSync(file, "utf8");
      const lineOf = lineIndex(src);
      const { literals, residue } = lexLiterals(src, rel);
      // Coverage proof: a string the lexer walked past would leave its own
      // quote characters in the residue. None may survive.
      residue.split("\n").forEach((line, i) => {
        const stray = line.match(/["'`]/);
        if (stray) skipped.push(`${rel}:${i + 1} → ${line.trim().slice(0, 100)}`);
      });
      if (MUST_SEE_COPY.includes(rel) && literals.some((l) => SENTENCE.test(l.text))) {
        sawCopyIn.add(rel);
      }
      for (const literal of literals) {
        if (!BANNED.test(literal.text)) continue;
        // Mark EVERY matching entry used, not just the first: two markers can
        // legitimately land in one long prompt, and crediting only the first
        // would report the second as stale and fail an honest allowlist.
        const markers: string[] = [];
        ALLOWED_LITERALS.forEach((a, idx) => {
          if (a.file === rel && literal.text.includes(a.contains)) {
            used.add(idx);
            markers.push(a.contains);
          }
        });
        // …and the exemption covers those markers, not the whole literal: one
        // allowlisted sentence in a long prompt chunk must not carry an
        // unexamined second one in with it (the render half's line-granularity
        // hole, one layer down).
        if (markers.length > 0 && !BANNED.test(redact(literal.text, markers))) continue;
        offenders.push(
          `${rel}:${lineOf(literal.start)} → ${literal.text
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 140)}`,
        );
      }
    }

    // A gate that scans nothing passes everything.
    expect(scanned).toBeGreaterThan(100);
    expect(jsx, `JSX file in a literal-scan root (move it to ROOTS):\n${jsx.join("\n")}`).toEqual([]);
    // …and a gate that scans files but produces no literals from them is the
    // same green. Prove the two surfaces the verifier broke are really reached.
    expect(
      [...sawCopyIn].sort(),
      "the literal scan produced no sentence-shaped copy from a file that is full of it — the lexer is blind there",
    ).toEqual([...MUST_SEE_COPY].sort());
    expect(
      skipped,
      `string the lexer failed to consume (the gate is blind there):\n${skipped.join("\n")}`,
    ).toEqual([]);
    expect(
      offenders,
      `banned "govern*" word in a server/schema string a human can read:\n${offenders.join("\n")}`,
    ).toEqual([]);
    const stale = ALLOWED_LITERALS.filter((_, i) => !used.has(i)).map(
      (a) => `${a.file} → ${a.contains}`,
    );
    expect(stale, `allowlist entries that match nothing:\n${stale.join("\n")}`).toEqual([]);
  });

  /**
   * The third surface: `app/server/seed/assets/**`. These `.md` files ship as the
   * seeded agent definitions, MCP profiles and skill docs. `walk` never sees them
   * (not `.ts`), so they were outside both gates AND outside every allowlist —
   * an org admin reads and edits this exact text in the agent-definition UI.
   *
   * The verdict is "prompt text is exempt, but only sentence by sentence": today
   * every hit is legitimate, and it is now written down as twelve named
   * exemptions instead of nobody having looked.
   */
  it("no seeded agent definition or skill doc carries a banned word outside its named prompt text", () => {
    const offenders: string[] = [];
    const used = new Set<number>();
    const files = walkAll(ASSETS);
    let lines = 0;

    for (const file of files) {
      const rel = path.relative(ASSETS, file);
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          lines += 1;
          if (!BANNED.test(line)) return;
          const markers: string[] = [];
          ALLOWED_ASSET_LINES.forEach((a, idx) => {
            if (a.file === rel && line.includes(a.contains)) {
              used.add(idx);
              markers.push(a.contains);
            }
          });
          // Redacted, not skipped: a second banned sentence appended to an
          // exempted line is still an offender.
          if (markers.length > 0 && !BANNED.test(redact(line, markers))) return;
          offenders.push(`${rel}:${i + 1} → ${line.trim().slice(0, 120)}`);
        });
    }

    // A gate that scans nothing passes everything.
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(lines).toBeGreaterThan(100);
    expect(
      offenders,
      `banned "govern*" word in a seeded asset with no prompt-text exemption — add it to ALLOWED_ASSET_LINES with a reason, or reword it:\n${offenders.join("\n")}`,
    ).toEqual([]);
    const stale = ALLOWED_ASSET_LINES.filter((_, i) => !used.has(i)).map(
      (a) => `${a.file} → ${a.contains}`,
    );
    expect(
      stale,
      `asset allowlist entries that match nothing:\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});

/**
 * F19-12 — the retired "primary specialist" vocabulary.
 *
 * Since the generic-agents work (2026-07-19) a task carries one `engagements[]`
 * list in which exactly one engagement has `delivers: true` — the DELIVERING
 * agent. FR14 was re-synced to that model in pass 17 (D9 / Q17-5), and the task
 * page has said "Delivering agent" ever since. But the retired words survived in
 * places a user still reads: the capability label on the Policy page and the
 * capability matrix, the @-mention picker, the "Deployed X as the primary
 * specialist" timeline event, and every assign/run recommendation label the
 * operator writes. One vocabulary, two names, is exactly the drift the state-
 * semantics rule exists to prevent — so pin it.
 *
 * Scope is wider than the ban above because these strings are BUILT server-side
 * and rendered verbatim (timeline events, recommendation labels, capability
 * labels). Comments are stripped, so the history may still be explained in prose.
 *
 * The capability **id** `assign-primary-specialist` is deliberately untouched: it
 * is a stable identifier stored in every project.md agent policy, never rendered.
 */
const RETIRED_VOCAB = /primary specialists?\b/i;

/** The capability id is an identifier, not copy — it may appear anywhere. */
const VOCAB_ALLOW = ["assign-primary-specialist"];

describe("F19-12: the retired 'primary specialist' vocabulary is gone from copy", () => {
  it("no rendered or server-built copy calls the delivering agent a 'primary specialist'", () => {
    const offenders: string[] = [];
    const roots = [
      path.join(APP, "features"),
      path.join(APP, "routes"),
      path.join(APP, "server"),
      path.join(APP, "shared"),
    ];
    for (const root of roots) {
      for (const file of walk(root)) {
        const src = stripComments(readFileSync(file, "utf8"));
        src.split("\n").forEach((line, i) => {
          if (!RETIRED_VOCAB.test(line)) return;
          if (VOCAB_ALLOW.some((a) => line.includes(a))) return;
          offenders.push(
            `${path.relative(APP, file)}:${i + 1} → ${line.trim().slice(0, 100)}`,
          );
        });
      }
    }
    expect(
      offenders,
      `retired "primary specialist" vocabulary — say "delivering agent":\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
