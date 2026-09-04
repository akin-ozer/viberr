import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D34-1 (pass 34) — the operations docs never tell an operator to open the
 * LIVE projection database from the host.
 *
 * `docs/operations/runbook.md` used to say, under "Check who is connected",
 * `sqlite3` on `$VIBERR_DATA_ROOT/state/projection.sqlite`. On the shipped
 * Docker deployment the data root is a bind mount, so that opens from the HOST
 * the WAL index of a file the GUEST is writing, across VirtioFS. Done exactly
 * that way during pass 34 (host `sqlite3 -readonly` polling every few seconds),
 * it preceded the container's SIGBUS at 09:12:46Z, exit 135. `-readonly` is no
 * protection: the shared mapping is the problem, not the write.
 * `docs/operations/deployment.md`'s lossy re-baseline recipe ran a host
 * `npm run backup` against the same live root, one line ABOVE the
 * `docker compose down` that would have made it safe.
 *
 * Mechanical pins over BOTH pages, so the next rewrite cannot quietly put a
 * host-side form back:
 *   1. no `sqlite3` invocation on `state/projection.sqlite` without `mode=ro`;
 *   2. the in-container read-only form (`docker compose exec -T app node -e`
 *      opening with `readOnly: true`, the option `openDatabaseReadOnly` in
 *      `app/server/db/sqlite.server.ts` uses) appears BEFORE any host-side form;
 *   3. every in-container `npm run backup` carries an explicit absolute `--out`
 *      (`scripts/backup.ts` defaults to `./backups`, which is `/app/backups` in
 *      the container and is lost with it), outside `/data` (`createBackup`
 *      refuses a destination under the root it backs up), and the page copies
 *      the artefact out with `docker compose cp`;
 *   4. a host-side `npm run backup` in a recipe that also stops the container
 *      comes AFTER the `docker compose down`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");

interface OpsPage {
  rel: string;
  text: string;
}

function page(rel: string): OpsPage {
  return { rel, text: readFileSync(path.join(ROOT, rel), "utf8") };
}

const RUNBOOK = page("docs/operations/runbook.md");
const DEPLOYMENT = page("docs/operations/deployment.md");
const PAGES = [RUNBOOK, DEPLOYMENT];

/**
 * A `sqlite3` COMMAND whose file argument is the projection database: the
 * binary, optional flags, then the path token, all on one line and separated
 * by whitespace. Prose that merely names `sqlite3` next to the file (the dated
 * correction note quotes what the page used to say) is not an invocation and
 * does not match.
 */
const SQLITE3_ON_PROJECTION =
  /\bsqlite3\s+(?:-[\w-]+\s+)*"?(?:file:)?\$?[^\s"]*state\/projection\.sqlite[^\s"]*"?/g;

/** The page's fenced ```bash blocks, in order, with the offset of each. */
function bashBlocks(text: string): { body: string; at: number }[] {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => ({
    body: m[1] ?? "",
    at: m.index,
  }));
}

/**
 * The in-container read-only form: a fenced bash block that runs
 * `docker compose exec … app node -e` AND opens the file with `readOnly: true`
 * inside that same block. Bounded to the block on purpose: prose elsewhere on
 * the page quotes `readOnly: true` too, and an unbounded scan would let a
 * read-write example borrow it. Returns the offset of the first such block,
 * or -1.
 */
function containerReadOnlyFormAt(text: string): number {
  const block = bashBlocks(text).find(
    ({ body }) =>
      /docker compose exec\s+(?:-T\s+)?app\s+node\s+-e\b/.test(body) &&
      /readOnly:\s*true/.test(body),
  );
  return block ? block.at : -1;
}

function sqlite3Invocations(text: string): { command: string; at: number }[] {
  return [...text.matchAll(SQLITE3_ON_PROJECTION)].map((m) => ({
    command: m[0],
    at: m.index,
  }));
}

describe("D34-1: the operations docs never open the live projection database from the host", () => {
  it.each(PAGES)(
    "$rel: every sqlite3 invocation on state/projection.sqlite opens read-only (mode=ro)",
    ({ rel, text }) => {
      const offenders = sqlite3Invocations(text)
        .map((i) => i.command)
        .filter((command) => !/[?&]mode=ro\b/.test(command));
      expect(
        offenders,
        `${rel} tells an operator to open the projection database without mode=ro; ` +
          `a host-side sqlite3 on a live Docker root is the pass-34 SIGBUS`,
      ).toEqual([]);
    },
  );

  it("runbook.md shows the in-container read-only form (docker compose exec … node -e, readOnly: true)", () => {
    // Without this pin the ordering check below passes vacuously once someone
    // deletes the container form and the bare-metal line with it.
    expect(
      containerReadOnlyFormAt(RUNBOOK.text),
      `${RUNBOOK.rel} must show the in-container read-only form: docker compose exec -T app node -e ` +
        `'… new DatabaseSync(path, { readOnly: true }) …'`,
    ).toBeGreaterThan(-1);
  });

  it.each(PAGES)(
    "$rel: the in-container read-only form appears BEFORE any host-side sqlite3 form",
    ({ rel, text }) => {
      const first = sqlite3Invocations(text).at(0);
      if (!first) return; // no host-side form on this page at all
      const containerAt = containerReadOnlyFormAt(text);
      expect(
        containerAt,
        `${rel} shows a host-side sqlite3 form ("${first.command}") with no in-container ` +
          `read-only form anywhere on the page`,
      ).toBeGreaterThan(-1);
      expect(
        containerAt,
        `${rel} shows the host-side sqlite3 form ("${first.command}") before the in-container ` +
          `read-only form; the container form is the one to reach for first`,
      ).toBeLessThan(first.at);
    },
  );

  it.each(PAGES)(
    "$rel: every in-container `npm run backup` names an absolute --out outside /data and copies it out",
    ({ rel, text }) => {
      // Command lines only: the reader/writer table names both strings in one
      // prose cell, and prose is not a recipe.
      const inContainer = text
        .split("\n")
        .filter((line) => /^\s*docker compose exec\b.*\bnpm run backup\b/.test(line));
      // Both pages carry the recipe; a page that dropped it would leave only
      // the host-side form for an operator to find.
      expect(
        inContainer.length,
        `${rel} must show the in-container backup form (docker compose exec -T app npm run backup -- --out …)`,
      ).toBeGreaterThan(0);
      for (const line of inContainer) {
        const out = /--out\s+(\/\S+)/.exec(line)?.[1];
        expect(
          out,
          `${rel}: "${line.trim()}" relies on backup.ts's default ./backups, which is ` +
            `/app/backups inside the container and is lost with it`,
        ).toBeDefined();
        expect(
          out,
          `${rel}: createBackup refuses a destination under the data root it backs up (/data)`,
        ).not.toMatch(/^\/data(?:\/|$)/);
        expect(
          text,
          `${rel}: the artefact at ${out} is container-local; the page must copy it out ` +
            `with "docker compose cp app:${out}"`,
        ).toContain(`docker compose cp app:${out}`);
      }
    },
  );

  it.each(PAGES)(
    "$rel: a host-side `npm run backup` in a recipe that stops the container comes after the down",
    ({ rel, text }) => {
      for (const { body: block } of bashBlocks(text)) {
        const lines = block.split("\n");
        const down = lines.findIndex((line) => /^\s*docker compose down\b/.test(line));
        if (down === -1) continue;
        const hostBackup = lines.findIndex(
          (line) => /^\s*(?:\w+=\S+\s+)*npm run backup\b/.test(line),
        );
        if (hostBackup === -1) continue;
        expect(
          hostBackup,
          `${rel}: this recipe runs "npm run backup" from the host BEFORE "docker compose down", ` +
            `i.e. against the live root over the bind mount:\n${block}`,
        ).toBeGreaterThan(down);
      }
    },
  );
});
