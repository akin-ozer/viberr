import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { logger } from "~/server/logging/logger.server";
import { STORE_TEXT_EXTENSIONS } from "~/shared/text/store-extensions";
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

/**
 * THE list of store text-doc extensions now lives in an isomorphic module: the
 * store browser needs it too and runs in the browser, so it cannot import this
 * `.server` file. Re-exported here because this injector is the reason the list
 * exists — `isInjectableKbDoc` below is its primary consumer, and callers that
 * already import the injector should not have to learn a second module.
 *
 * C5/pass-16: the set MUST cover everything the in-app editor can author. It
 * didn't — `.json`/`.yaml`/`.yml` were offered by the "New document" flow,
 * written to disk, counted in the browser, and then invisible to every run.
 * C5-followup: the first fix left three hand-maintained copies "separate but
 * equal", which is how the divergence happened in the first place. One set now.
 */
export { STORE_TEXT_EXTENSIONS };

/**
 * Would this file name reach a run? P14-KM-13: the org-settings row counted
 * EVERY non-dot file as a "doc", so a KB holding nothing but PDFs advertised a
 * healthy count while injecting zero bytes. The count and the injector must
 * answer the same question, so the injector owns the predicate.
 */
export function isInjectableKbDoc(fileName: string): boolean {
  if (fileName.startsWith(".")) return false; // dotfiles are not content
  return STORE_TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
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

/** A declared knowledge base that reached the run with less (or none) of its
 *  content — the KB twin of `UnresolvedSkillGrant` / `UnresolvedMcpGrant`. */
export interface UnresolvedKbGrant {
  name: string;
  /** Why it produced nothing usable, in words a human can act on. */
  reason: string;
}

export interface KbInjection {
  /** The text to inject ("" when nothing of this KB reached the run). */
  body: string;
  /** Present when the grant did not deliver what every UI says it delivers. */
  unresolved?: UnresolvedKbGrant;
}

/**
 * Read a knowledge base's documents from the store, concatenated with per-doc
 * headings and bounded by {@link KB_INJECTION_BUDGET}. Returns "" when the KB
 * folder is absent (an unresolved KB reference injects nothing, exactly as
 * skills do). When the budget clips content a truncation marker is appended,
 * and when the remaining budget fits NOTHING the marker is returned on its own
 * (P14-KM-05) — a KB is never dropped silently, whether it was partly or wholly
 * squeezed out by the KBs ahead of it.
 *
 * C1/pass-16: the "not silently" part was true of the LOG only. `unresolved` now
 * carries the same structured miss the MCP leg has reported since P14-LV-09, so
 * a renamed/typo'd KB folder reaches the run's own prompt instead of living in
 * a server log nobody reads while every UI still shows the grant attached.
 */
/** Doc names for a human-readable sentence: `a.md`, `b.md` and `c.md`. */
function listDocs(rels: readonly string[]): string {
  const quoted = rels.map((r) => `\`${r}\``);
  if (quoted.length <= 1) return quoted[0] ?? "";
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

export function readKbBodyDetailed(
  name: string,
  dataRoot?: string,
  budgetChars: number = KB_INJECTION_BUDGET,
): KbInjection {
  const miss = (reason: string): KbInjection => ({
    body: "",
    unresolved: { name, reason },
  });
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
      return miss("no knowledge-base folder by that name in the store");
    }
    // C5/pass-16: the walk below realpath's the ROOT before enforcing
    // containment, so a KB folder that is ITSELF a symlink made every
    // containment check relative to the link's target — `data/kb/notes -> /etc`
    // injected the target's files as trusted agent context. Every other store
    // path refuses to follow a link out of the store (P14-RV-02); so does this.
    if (lstatSync(dir).isSymbolicLink()) {
      logger.warn(
        "declared knowledge base folder is a symlink — run proceeds WITHOUT it",
        { kb: name },
      );
      return miss(
        "its store folder is a symlink — Viberr does not follow links out of the store",
      );
    }
    const docs = collectKbDocs(dir);
    if (docs.length === 0) {
      logger.warn("declared knowledge base is empty — run proceeds WITHOUT it", {
        kb: name,
      });
      return miss("its store folder holds no documents a run can read");
    }
    const parts: string[] = [];
    let budget = budgetChars;
    // Ruling 253 (pass 37, F37-82): the NAMES, not just the counts. An agent
    // cannot ask for a rule it cannot name, and a human debugging "why did the
    // run ignore the standing correction" had nothing to read.
    const omittedDocs: string[] = [];
    const clippedDocs: string[] = [];
    for (const doc of docs) {
      if (budget <= 0) {
        omittedDocs.push(doc.rel);
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
        omittedDocs.push(doc.rel);
        continue;
      }
      const slice = raw.slice(0, room);
      if (slice.length < raw.length) clippedDocs.push(doc.rel);
      budget -= heading.length + slice.length;
      parts.push(`${heading}${slice}`);
    }
    const omitted = omittedDocs.length;
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
        return {
          body: `_(knowledge base omitted entirely — ${omitted} doc${omitted === 1 ? "" : "s"} dropped; only ${budgetChars} chars of the shared knowledge-base budget were left)_`,
          unresolved: {
            name,
            reason: `it did not fit the shared ${KB_INJECTION_BUDGET}-char knowledge-base budget — none of its ${omitted} doc${omitted === 1 ? "" : "s"} reached this run`,
          },
        };
      }
      logger.warn(
        "declared knowledge base holds no readable text — run proceeds WITHOUT it",
        { kb: name, docs: docs.length },
      );
      return miss("its documents hold no readable text");
    }
    if (omitted > 0 || clippedDocs.length > 0) {
      // Ruling 253: BOTH halves, and both by name. The old marker chose one
      // sentence — "N more docs omitted" whenever anything was omitted — so a
      // run that got half a rule AND lost two more docs was told only about the
      // two, and never that the rule it did read stops mid-sentence.
      const lost = [
        ...(clippedDocs.length > 0
          ? [`${listDocs(clippedDocs)} cut off mid-document`]
          : []),
        ...(omitted > 0 ? [`${listDocs(omittedDocs)} not included at all`] : []),
      ].join("; ");
      parts.push(
        `_(knowledge base truncated — ${lost}; it exceeded the ${budgetChars}-char budget left for knowledge bases)_`,
      );
      // Ruling 253: a KB that delivered HALF is now reported on the SAME
      // structured channel as one that delivered nothing. It was not: the
      // `unresolved` row was returned only from the delivered-nothing branch, so
      // the run-input disclosure a human reads (P19-G11) said every grant
      // arrived while a project's binding rulings had been cut in half.
      return {
        body: parts.join("\n\n"),
        unresolved: {
          name,
          reason: `only part of it fitted the shared knowledge-base budget — ${lost}`,
        },
      };
    }
    return { body: parts.join("\n\n") };
  } catch (error) {
    logger.warn("knowledge base unreadable — run proceeds WITHOUT it", {
      kb: name,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return miss("its store folder could not be read");
  }
}

/** Read one KB's docs, or "" when it resolves to nothing. Thin wrapper over
 *  {@link readKbBodyDetailed} for callers that only inject. */
export function readKbBody(
  name: string,
  dataRoot?: string,
  budgetChars: number = KB_INJECTION_BUDGET,
): string {
  return readKbBodyDetailed(name, dataRoot, budgetChars).body;
}

export interface KbInjectionSet {
  /** The KBs that contributed text, in declaration order. */
  parts: { name: string; body: string }[];
  /** Grants that delivered nothing (C1) — the caller owes the run these. */
  unresolved: UnresolvedKbGrant[];
}

/**
 * Read EVERY declared knowledge base under ONE shared budget (F9). Each KB draws
 * from what the ones before it left; a KB that no longer fits still emits its
 * "omitted entirely" marker (P14-KM-05) AND a structured `unresolved` row (C1),
 * so the run's prompt names what it did not get.
 */
export function readKbBodies(
  names: readonly string[],
  dataRoot?: string,
  budgetChars: number = KB_INJECTION_BUDGET,
): KbInjectionSet {
  const parts: { name: string; body: string }[] = [];
  const unresolved: UnresolvedKbGrant[] = [];
  let budget = budgetChars;
  for (const name of names) {
    const injection = readKbBodyDetailed(name, dataRoot, Math.max(0, budget));
    if (injection.unresolved) unresolved.push(injection.unresolved);
    if (injection.body) {
      parts.push({ name, body: injection.body });
      budget -= injection.body.length;
    }
  }
  return { parts, unresolved };
}

/**
 * R19-2 — the PRECEDENCE rule that ships with every knowledge-base injection.
 *
 * A KB is org-level context; the repository is the thing being changed. When
 * they disagree the repo wins and the KB supplements. Live-caught this pass: a
 * KB-granted Codex developer and a KB-less Claude writer produced two different
 * formats for the same file family on ONE repo, because nothing ever told
 * either run which source outranks the other. Two agents on one repo must not
 * be able to derive two house styles from the same evidence.
 *
 * It lives HERE, beside {@link readKbBodies}, because it is a property of the
 * KB injection itself — not of either runtime. Both runtimes (specialist +
 * operator) import this one constant and push it immediately before the bodies
 * it ranks, so the rule cannot drift between them; the operator used to import
 * a prompt constant from the specialist runtime, which put the rule in the
 * wrong place and made one runtime depend on the other for it.
 *
 * Emitted only alongside REAL KB text (`kbSet.parts.length > 0`), so a run with
 * no knowledge base never carries a rule about a resource it does not have.
 */
export const KB_PRECEDENCE_NOTE =
  "\n\n---\n# Which source wins (knowledge bases vs the repository)\n\n" +
  "The repository's OWN documented conventions outrank the knowledge bases " +
  "below. Where a repo file states a convention — its README, CONTRIBUTING, " +
  "docs/, a linter or formatter config, or the established pattern of the " +
  "files you are editing — follow the repository and treat the knowledge base " +
  "as supplementary. Use knowledge-base guidance where the repo is silent, and " +
  "when the two genuinely conflict, follow the repo and SAY SO in your report " +
  "(name the file and the conflicting knowledge base) so a human can reconcile " +
  "them. Never rewrite an existing file family into a knowledge base's style " +
  "just because the knowledge base describes one.";
