import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * F18-14 — the "govern / governor / governance / governed" copy ban.
 *
 * design/CONVERSATION-SUMMARY.md line 22: *"govern/governor/governance is BANNED
 * — use Maintainer (human role), Permissions (panel), 'managed'."* Line 81 calls
 * it out for the Policy page specifically. The ban is about RENDERED UI copy the
 * human sees — NOT agent system prompts (those live under `app/server/` and may
 * legitimately tell an agent it operates under governance).
 *
 * Two live violations slipped through 18 passes because nothing enforced it
 * ("No governance events" in the timeline empty state; "Off the governed path:"
 * on the Policy page). This gate scans the user-facing render layer
 * (`app/features/**` + `app/routes/**`), strips comments and identifiers, and
 * fails on any banned word in rendered text — so a regression fails CI, not the
 * eye. Server-side prompt files are out of scope by construction (not scanned).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const ROOTS = [path.join(APP, "features"), path.join(APP, "routes")];

/** The banned word family, as a rendered-copy regex (word-ish boundaries). */
const BANNED = /\bgovern(ance|ed|or|ors|ing|s)?\b/i;

/**
 * Allowed uses that are NOT rendered UI copy shown to an end user:
 *  - code identifiers (`GOVERNED_TEMPLATE`, `isGoverned`, `governed.direct`, the
 *    `governed-5` template id) — machinery, never rendered.
 *
 * There is NO rendered-copy exception. The login tagline had "governed" removed
 * at design time (design/CONVERSATION-SUMMARY.md L182: *"'Self-hosted ·
 * collaborative agentic AI delivery' (word 'governed' removed)"*), so the login
 * hero is subject to the ban like every other surface — not allowlisted.
 */
const ALLOW_SUBSTRINGS = [
  "GOVERNED_TEMPLATE",
  "GOVERNED_CAP_LABELS",
  "isGoverned",
  "const governed =",
  "governed.direct",
  "governed.recommend",
  "governed.forbidden",
  '"governed-5"',
  "governed-5",
];

/** Strip `//` line comments and `/* … *\/` block comments while PRESERVING line
 *  count (replace each stripped newline-bearing block with its own newlines), so
 *  a reported line number matches the source. A comment that explains the ban
 *  (like this file's own docblock) must never trip it. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
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

describe("F18-14: the govern/governance copy ban holds in the render layer", () => {
  it("no rendered UI copy under app/features or app/routes contains a banned word", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const src = stripComments(readFileSync(file, "utf8"));
        src.split("\n").forEach((line, i) => {
          if (!BANNED.test(line)) return;
          if (ALLOW_SUBSTRINGS.some((a) => line.includes(a))) return;
          offenders.push(
            `${path.relative(APP, file)}:${i + 1} → ${line.trim().slice(0, 100)}`,
          );
        });
      }
    }
    expect(offenders, `banned "govern*" word in rendered copy:\n${offenders.join("\n")}`).toEqual([]);
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
