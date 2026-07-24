import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { logger } from "~/server/logging/logger.server";
import { kbDirPath } from "./file-store-root.server";

/**
 * Shared knowledge-base → agent-context reader (F6).
 *
 * A knowledge base is a store folder under `data/kb/<dir>/`. Both the operator
 * and specialist runtimes inject its docs into the run prompt. This is the ONE
 * canonical reader — the operator and specialist paths used to each carry a
 * private copy that (a) read only the TOP level of the folder and (b) matched
 * only `*.md`. Both assumptions were wrong for real content:
 *
 *  - `importGithubSnapshot` (store-files.server.ts) always writes imported docs
 *    under a nested `<repo-or-subpath>/…` folder, and folder-uploads preserve
 *    their nesting — so every doc from the real "Add from GitHub" flow and every
 *    uploaded folder landed one+ level deep and was silently invisible to
 *    agents, even though the browser, the reindex count, and the delete-confirm
 *    copy all claimed the docs were loaded. Only the flat, top-level seed KBs
 *    injected correctly, which masked the gap.
 *  - KBs full of `.txt` / `.mdx` / `.markdown` / `.rst` docs contributed nothing.
 *
 * This reader walks the whole tree, matches every text-doc extension, keeps a
 * total-character budget so a large KB can't blow the context window, and — when
 * the budget clips content — appends an explicit, honest truncation marker so
 * neither the agent nor the reader silently believes it saw the whole KB.
 */

/** Extensions we treat as injectable text docs (lower-cased, with dot). */
const KB_TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".rst",
  ".text",
]);

/** Default per-run character budget across ALL of a KB's docs. */
export const KB_INJECTION_BUDGET = 24_000;

interface KbDoc {
  /** Store-relative path within the KB folder (forward slashes), for headings. */
  rel: string;
  abs: string;
  size: number;
}

/** Recursively collect injectable docs under `dir`, sorted by relative path so
 *  injection order is deterministic (and stable across runs). */
function collectKbDocs(dir: string): KbDoc[] {
  const out: KbDoc[] = [];
  // F10-18: never follow a symlink out of the KB root, and never loop on a
  // symlink cycle. `lstatSync` does not follow symlinks; symlinked entries are
  // skipped entirely (KB content is real files under the store, not links); a
  // realpath cycle guard + depth cap bound the walk; and every visited dir is
  // re-checked to be beneath the (realpath'd) root.
  let rootReal: string;
  try {
    rootReal = realpathSync(dir);
  } catch {
    return out;
  }
  const visited = new Set<string>();
  const MAX_DEPTH = 32;
  const walk = (abs: string, relParts: string[], depth: number) => {
    if (depth > MAX_DEPTH) return;
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return;
    }
    if (visited.has(real)) return; // cycle guard
    visited.add(real);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return; // containment
    let entries: string[];
    try {
      entries = readdirSync(abs).sort();
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue; // dotfiles are not content
      const childAbs = path.join(abs, entry);
      let st;
      try {
        st = lstatSync(childAbs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // never follow symlinks out of the root
      if (st.isDirectory()) {
        walk(childAbs, [...relParts, entry], depth + 1);
      } else if (
        st.isFile() &&
        KB_TEXT_EXTENSIONS.has(path.extname(entry).toLowerCase())
      ) {
        out.push({
          rel: [...relParts, entry].join("/"),
          abs: childAbs,
          size: st.size,
        });
      }
    }
  };
  walk(dir, [], 0);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Read a knowledge base's documents from the store, concatenated with per-doc
 * headings and bounded by {@link KB_INJECTION_BUDGET}. Returns "" when the KB
 * folder is absent (an unresolved KB reference injects nothing, exactly as
 * skills do). When the budget clips content, a `_(… N doc(s) omitted — KB
 * exceeds the Nk injection budget)_` marker is appended so the truncation is
 * never silent.
 */
export function readKbBody(
  name: string,
  dataRoot?: string,
  budgetChars: number = KB_INJECTION_BUDGET,
): string {
  try {
    const dir = kbDirPath(name, dataRoot);
    if (!existsSync(dir)) {
      // P13-KM-02: a granted KB that resolves to NOTHING used to be perfectly
      // silent — no log, no evidence line — which is exactly what hid KM-01
      // (a grant stored under the display name) and KM-07 (a rename that
      // orphaned every reference). Live-proven: after renaming a KB, a fresh
      // run reported "there is no p13-facts knowledge base reaching this run"
      // while every UI still showed it attached. Mirrors readSkillBody.
      logger.warn(
        "declared knowledge base not found in the store — run proceeds WITHOUT it",
        { kb: name },
      );
      return "";
    }
    const docs = collectKbDocs(dir);
    if (docs.length === 0) {
      logger.warn("declared knowledge base is empty — run proceeds WITHOUT it", {
        kb: name,
      });
      return "";
    }
    const parts: string[] = [];
    let budget = budgetChars;
    let omitted = 0;
    let truncatedADoc = false;
    for (const doc of docs) {
      if (budget <= 0) {
        omitted += 1;
        continue;
      }
      let raw: string;
      try {
        raw = readFileSync(doc.abs, "utf8").trim();
      } catch {
        continue; // unreadable doc — skip (not counted as omitted)
      }
      if (!raw) continue;
      const slice = raw.slice(0, budget);
      if (slice.length < raw.length) truncatedADoc = true;
      budget -= slice.length;
      parts.push(`### ${doc.rel}\n\n${slice}`);
    }
    if ((omitted > 0 || truncatedADoc) && parts.length > 0) {
      const kb = Math.round(budgetChars / 1000);
      const tail =
        omitted > 0
          ? `${omitted} more doc${omitted === 1 ? "" : "s"} omitted`
          : `this doc was clipped`;
      parts.push(
        `_(knowledge base truncated — ${tail}; KB exceeds the ${kb}k-char injection budget)_`,
      );
    }
    return parts.join("\n\n");
  } catch (error) {
    logger.warn("knowledge base unreadable — run proceeds WITHOUT it", {
      kb: name,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return "";
  }
}
