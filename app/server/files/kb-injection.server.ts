import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
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

/**
 * Ruling 283 (pass 37, F37-118): a knowledge base arrives as an INDEX, and the
 * run pulls the documents it decides it needs.
 *
 * Injecting the text was a budget problem with no good allocation. The docs of
 * one KB were served in ALPHABETICAL order out of a shared character budget,
 * first-come-first-served, so whichever doc sorted first took everything it
 * could and every doc behind it got nothing. Live on the shopify-clone board:
 * `conventions.md` (20,632 chars) took all 15,817 chars that were left, cut
 * itself mid-sentence in its own §9, and starved `published-history.md` (185
 * chars) and `standing-corrections.md` (281 chars) to ZERO — 466 characters of
 * whole documents lost to buy 466 characters of a document that was being
 * truncated either way. A task goal on that board reads "See
 * published-history.md in the project's rulings knowledge base", naming a
 * document no run on it could ever receive.
 *
 * Ruling 261 had already raised a floor for exactly this — it was written
 * because `standing-corrections.md` arrived cut off mid-word — and the floor
 * was then eaten by the alphabetically-first document inside the very KB it
 * was protecting. A second allocation rule would have had the same shape.
 *
 * So there is no allocation any more. The index names every document, with its
 * size and its heading outline, and costs a few hundred characters whatever the
 * KB weighs; the run reads what the index makes it want to read. A KB can now
 * grow without silently pushing its own documents out of every prompt, and the
 * "N docs · agents read the live folder" every UI has always shown is true
 * again.
 */

/** Heading outline per KB, shared across its docs. Past it, documents are still
 *  NAMED — the index's whole job is that the run can ask for any of them. */
export const KB_INDEX_OUTLINE_BUDGET = 4_000;

/** Docs listed per KB. A folder with more says how many it did not name; no
 *  real knowledge base is near this, and an index that walks 10,000 files is
 *  the prompt problem this ruling exists to remove. */
export const KB_INDEX_MAX_DOCS = 200;

/** Cap on ONE `read_knowledge_doc` call. Generous — the point of the pull is
 *  that a document arrives whole — but not unbounded. */
export const KB_DOC_READ_CHARS = 48_000;

/** Heading lines are cheap to extract and are what makes an index worth
 *  reading; a doc far larger than any real KB doc is listed without them. */
const OUTLINE_MAX_BYTES = 512 * 1024;

/** Markdown heading lines, in order, flattened to `#### Title`. Returns [] for
 *  a doc with no headings (`.txt`, `.json`, prose) — its path and size are
 *  still the index entry. Fenced code is skipped so a shell comment inside a
 *  ``` block is not read as a section of the document. */
function outlineOf(abs: string, size: number): string[] {
  if (size > OUTLINE_MAX_BYTES) return [];
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  let fenced = false;
  for (const line of raw.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^(#{1,6})\s+(\S.*?)\s*#*$/.exec(line);
    if (m) out.push(`${m[1]} ${m[2]}`);
  }
  return out;
}

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
  /** The index text to inject ("" when this KB resolved to nothing). */
  body: string;
  /** Present when the grant did not deliver what every UI says it delivers. */
  unresolved?: UnresolvedKbGrant;
}

/**
 * Index ONE knowledge base: every document it holds, with its size and its
 * sections. Returns "" with an `unresolved` row when the grant resolves to
 * nothing a run can read — a missing folder, a symlink out of the store, an
 * empty folder, an unreadable one. Those are now the ONLY ways a knowledge
 * base fails to arrive: an index is never clipped by another KB's size, so a
 * grant that resolves always names every document it holds (ruling 283).
 *
 * C1/pass-16: `unresolved` carries the same structured miss the MCP leg has
 * reported since P14-LV-09, so a renamed/typo'd KB folder reaches the run's own
 * prompt instead of living in a server log nobody reads while every UI still
 * shows the grant attached.
 */
export function readKbIndexDetailed(name: string, dataRoot?: string): KbInjection {
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
    // indexed the target's files as trusted agent context. Every other store
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
    const listed = docs.slice(0, KB_INDEX_MAX_DOCS);
    let outlineBudget = KB_INDEX_OUTLINE_BUDGET;
    const entries = listed.map((doc) => {
      const head = `- \`${doc.rel}\` · ${doc.size.toLocaleString("en-US")} chars`;
      // Ruling 283: the outline budget clips OUTLINES, never the list. A doc
      // whose sections do not fit is still named at full size, because the name
      // is the only thing the run needs in order to ask for the document — and
      // "a doc you cannot name" is the failure this ruling exists to end. The
      // line that GUARANTEES that is the `kept.length === 0` return below, which
      // every doc past the budget takes; this early exit only saves reading the
      // file once nothing can fit, and is not the behaviour a test can pin.
      if (outlineBudget <= 0) return head;
      const outline = outlineOf(doc.abs, doc.size);
      if (outline.length === 0) return head;
      const kept: string[] = [];
      for (const heading of outline) {
        const line = `\n  ${heading}`;
        if (line.length > outlineBudget) break;
        outlineBudget -= line.length;
        kept.push(line);
      }
      if (kept.length === 0) return head;
      const more =
        kept.length < outline.length
          ? `\n  … ${outline.length - kept.length} more section${outline.length - kept.length === 1 ? "" : "s"}`
          : "";
      return `${head}${kept.join("")}${more}`;
    });
    if (docs.length > listed.length) {
      entries.push(
        `- … ${docs.length - listed.length} more document${docs.length - listed.length === 1 ? "" : "s"} in this folder, not listed here.`,
      );
    }
    return {
      body: `Folder \`${dir}\`. ${docs.length} document${docs.length === 1 ? "" : "s"}:\n\n${entries.join("\n")}`,
    };
  } catch (error) {
    logger.warn("knowledge base unreadable — run proceeds WITHOUT it", {
      kb: name,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return miss("its store folder could not be read");
  }
}

export interface KbInjectionSet {
  /** The KBs that produced an index, in declaration order. */
  parts: { name: string; body: string }[];
  /** Grants that delivered nothing (C1) — the caller owes the run these. */
  unresolved: UnresolvedKbGrant[];
}

/**
 * Index EVERY declared knowledge base. There is no budget to share and so no
 * ordering that decides who is starved (ruling 283): every declared KB that
 * resolves is indexed in full, and `unresolved` now carries only the ways a
 * grant can genuinely deliver nothing — a folder that is missing, a symlink, an
 * empty folder, an unreadable one.
 */
export function readKbIndexes(
  names: readonly string[],
  dataRoot?: string,
  /** Ruling 286: which of these names is the project's RULINGS knowledge base
   *  (ruling 239). A LABEL, not an allocation — ruling 283 removed the budget
   *  this argument used to feed, and it is back for the opposite reason: to say
   *  which index the run is OBLIGED to read rather than which one may take the
   *  most characters. */
  opts: { rulingsKb?: string | null } = {},
): KbInjectionSet {
  const parts: { name: string; body: string }[] = [];
  const unresolved: UnresolvedKbGrant[] = [];
  // Ruling 239's emission order is untouched — a profile's own grants first,
  // the project's rulings last — but the ORDER no longer decides anything: it
  // is a reading order now, not an allocation. Ruling 261's floor existed only
  // to survive the allocation and is retired with it.
  for (const name of names) {
    const index = readKbIndexDetailed(name, dataRoot);
    if (index.unresolved) unresolved.push(index.unresolved);
    if (!index.body) continue;
    parts.push({
      name,
      body:
        name === opts.rulingsKb
          ? `${RULINGS_BINDING_LINE}\n\n${index.body}`
          : index.body,
    });
  }
  return { parts, unresolved };
}

/** Ruling 286: the sentence that separates a BINDING index from an optional
 *  one, on the index itself — so it is read with the document list rather than
 *  in a note the run may have scrolled past. */
export const RULINGS_BINDING_LINE =
  "**BINDING on this run.** This is the project's settled rulings knowledge base " +
  "(ruling 239): an administrator made it binding on every run this project makes, " +
  "you included. Read it — the obligation is not conditional on your finding it " +
  "interesting.";

/** One document out of one knowledge base, or `null` when this KB has no such
 *  document. The caller decides WHICH knowledge bases may be asked for — this
 *  reader does not know a run's grants and must never be handed an
 *  unfiltered name (ruling 283). */
export function readKbDoc(
  kb: string,
  docPath: string,
  dataRoot?: string,
): { text: string; truncated: boolean; rel: string } | null {
  const dir = kbDirPath(kb, dataRoot);
  // The doc path comes from a model, so it is treated exactly like a request
  // from outside: normalised, then proven to land inside this KB's folder. The
  // realpath comparison is what stops `../` and a symlink alike; `kbDirPath`
  // has already contained the KB NAME the same way.
  const rel = docPath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!rel || !isInjectableKbDoc(path.basename(rel))) return null;
  const abs = path.resolve(dir, rel);
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    return null;
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return null;
  }
  if (!real.startsWith(root + path.sep)) return null;
  let st;
  try {
    st = statSync(real);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const raw = readFileSync(real, "utf8");
  return {
    rel: path.relative(root, real).split(path.sep).join("/"),
    text: raw.slice(0, KB_DOC_READ_CHARS),
    // Reported, never hidden: a clipped document that reads as complete is how
    // a model states a half-read file as fact.
    truncated: raw.length > KB_DOC_READ_CHARS,
  };
}

/**
 * The instruction that ships WITH every knowledge-base index (ruling 283).
 *
 * An index no one is told to follow is worse than the text it replaced. Both
 * channels are named because the toolkit tool is Claude-only — a Codex run
 * mounts no in-process Viberr tools at all, and its channel is the folder path
 * the index prints, which is a real path on the machine the run executes on.
 */
export const KB_INDEX_NOTE =
  "\n\n---\n# How to read a knowledge base\n\n" +
  "Each knowledge base below is listed as an INDEX: every document it holds, " +
  "its size, and its sections. The text is NOT in this prompt — read the " +
  "documents you need. Call `read_knowledge_doc` with the knowledge base's " +
  "name and the document's path; if that tool is not mounted for you, the " +
  "index prints the folder's path on disk and you can read the file directly. " +
  "Read a document before relying on what its title or a section heading " +
  "suggests it says, and read the ones a task, a directive or another agent " +
  "tells you to read by name.";
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

/**
 * The `read_knowledge_doc` tool's whole body, shared by the three toolkits that
 * mount it (specialist, operator, controller) — ONE implementation, because
 * "what does standing-corrections.md say" must not have three answers.
 *
 * `granted` is the run's OWN knowledge-base list. A run may read the documents
 * of the knowledge bases attached to it and no others: the index it was given
 * names those and only those, and an org's other knowledge bases are not
 * context this run was granted just because it can spell their names.
 */
export function readKbDocForRun(
  granted: readonly string[],
  kb: string,
  docPath: string,
  dataRoot?: string,
): string {
  const wanted = kb.trim();
  if (!granted.includes(wanted)) {
    // Ruling 246's shape: say what this reader IS rather than implying the
    // knowledge base does not exist — it may well exist and belong to another
    // profile, and a run told "no such knowledge base" goes looking for a
    // deletion that never happened.
    return (
      `[noop] No knowledge base \`${wanted}\` is attached to this run. ` +
      (granted.length > 0
        ? `You hold: ${granted.map((n) => `\`${n}\``).join(", ")}. This reads the knowledge bases attached to YOUR profile; others in the org are not yours to read.`
        : "None are attached to this run at all.")
    );
  }
  const doc = readKbDoc(wanted, docPath, dataRoot);
  if (!doc) {
    const index = readKbIndexDetailed(wanted, dataRoot);
    return (
      `[noop] Knowledge base \`${wanted}\` has no document \`${docPath}\`. ` +
      (index.body
        ? `Its index:\n\n${index.body}`
        : `It resolves to nothing this run can read${index.unresolved ? ` — ${index.unresolved.reason}` : ""}.`)
    );
  }
  return doc.truncated
    ? `${doc.text}\n\n_(cut off here — \`${doc.rel}\` is longer than the ${KB_DOC_READ_CHARS.toLocaleString("en-US")} characters one read returns; what is above is its opening, not the whole document)_`
    : doc.text;
}

/**
 * Ruling 286 (2026-09-15, pass 37; F37-121) — the teeth an index needs when the
 * documents behind it BIND.
 *
 * Ruling 283 made every knowledge base a pull, and the controller named the
 * regression that creates, with evidence from its own board: "Under injection,
 * reading is not a decision. Under index-and-fetch it becomes one, and it
 * competes with the agent's own turns — which on this board are scarce and
 * frequently interrupted." And the structural half: "An optional craft KB is
 * consulted when an agent recognises a need. A rulings KB binds decisions the
 * agent does not know it is making. Nobody fetches the never-rebase rule while
 * about to rebase — at that moment they feel certain, not uncertain. The failure
 * mode is not laziness, it is the absence of a trigger."
 *
 * So this names the TRIGGERS rather than only the contents, and asks the run to
 * say what it read. It is machinery and not a directive on purpose, also the
 * controller's call: a rule that lives in the coordinator's directive covers
 * only the tasks whose directives it writes, and misses reviewer engagements,
 * verifier runs, chain-created tasks and every project it is not in — which is
 * "a deferral recorded in a document with no mechanism behind it", the shape of
 * the defect this whole pass keeps finding.
 *
 * What it deliberately is NOT: a gate that refuses a delivery until the document
 * is fetched. The controller ruled that out and was right — "that is the
 * serialisation answer: it works today and rots, and it taxes every run that
 * legitimately did not need it."
 */
export const KB_RULINGS_NOTE =
  "\n\n---\n# The project's rulings are binding on you\n\n" +
  "One of the knowledge bases above is this project's settled RULINGS. Its index " +
  "tells you what exists; it does not tell you when a rule applies, and a rule you " +
  "have not read cannot stop you. Read the rulings document BEFORE each of these, " +
  "not after:\n\n" +
  "- before choosing a branch or merge strategy;\n" +
  "- before widening the set of paths you are going to change;\n" +
  "- before reporting a check as passed, or a check you could not run;\n" +
  "- before calling the work done, or judging whether someone else's is.\n\n" +
  "These are the moments the rules were written for, and they are moments you will " +
  "feel certain rather than uncertain — which is exactly why the trigger is the " +
  "situation and not your sense of needing help.\n\n" +
  "In your final report, state which rulings sections you relied on, and say so " +
  "plainly if you did not open them. A delivery that contradicts a rule its author " +
  "never read is a thing a reviewer should be able to SEE, rather than rediscover.";
