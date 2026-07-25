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

/**
 * Would this file name reach a run? P14-KM-13: the org-settings row counted
 * EVERY non-dot file as a "doc", so a KB holding nothing but PDFs advertised a
 * healthy count while injecting zero bytes. The count and the injector must
 * answer the same question, so the injector owns the predicate.
 */
export function isInjectableKbDoc(fileName: string): boolean {
  if (fileName.startsWith(".")) return false; // dotfiles are not content
  return KB_TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

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
      } else if (st.isFile() && isInjectableKbDoc(entry)) {
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
 * skills do). When the budget clips content a truncation marker is appended,
 * and when the remaining budget fits NOTHING the marker is returned on its own
 * (P14-KM-05) — a KB is never dropped silently, whether it was partly or wholly
 * squeezed out by the KBs ahead of it.
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
      // P13-KM-14: the per-doc heading was free — with many small docs the
      // headings alone could add thousands of unbudgeted characters, so the
      // "24k" cap was not the real ceiling. Charge the whole emitted chunk.
      const heading = `### ${doc.rel}\n\n`;
      const room = budget - heading.length;
      if (room <= 0) {
        omitted += 1;
        continue;
      }
      const slice = raw.slice(0, room);
      if (slice.length < raw.length) truncatedADoc = true;
      budget -= heading.length + slice.length;
      parts.push(`${heading}${slice}`);
    }
    if (parts.length === 0) {
      if (omitted > 0) {
        // P14-KM-05: NOTHING fit. The old `parts.length > 0` guard suppressed
        // both the marker and the warn in exactly this branch, so an earlier KB
        // that spent the shared budget made every later one vanish without a
        // trace — no prompt section, no log — while every UI still showed the
        // grant attached. Return the marker alone so the run's own prompt says
        // the KB was dropped.
        logger.warn(
          "declared knowledge base did not fit the run's injection budget — NOTHING of it reached the run",
          { kb: name, docs: omitted, budgetChars },
        );
        return `_(knowledge base omitted entirely — ${omitted} doc${omitted === 1 ? "" : "s"} dropped; only ${budgetChars} chars of the shared knowledge-base budget were left)_`;
      }
      logger.warn(
        "declared knowledge base holds no readable text — run proceeds WITHOUT it",
        { kb: name, docs: docs.length },
      );
      return "";
    }
    if (omitted > 0 || truncatedADoc) {
      const tail =
        omitted > 0
          ? `${omitted} more doc${omitted === 1 ? "" : "s"} omitted`
          : `this doc was clipped`;
      parts.push(
        `_(knowledge base truncated — ${tail}; it exceeded the ${budgetChars}-char budget left for knowledge bases)_`,
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
