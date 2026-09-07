import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ruling 158 (pass 35 F35-9) — the operations docs never tell anyone to open
 * a LIVE projection database, from either side of the container boundary.
 *
 * Pass 34 (D34-1) saw the server die with SIGBUS (exit 135) one second after a
 * HOST-side `sqlite3 -readonly` reader over the bind mount, and wrote the rule
 * "inside the container, read-only": `docker compose exec -T app node -e`
 * opening the file with `readOnly: true`. Pass 35 (NOTES 18:40Z) saw the same
 * exit one second after exactly that in-container `readOnly: true` reader, and
 * boot recovery then interrupted 23 runs. The mapping of the WAL index is the
 * hazard, not the write and not the side: a second connection to a live root
 * is never safe. So the rule is now "copy first": `projection.sqlite` and its
 * `-wal` are copied to a scratch directory and the COPY is opened, which is
 * what `openDatabaseReadOnly` (`app/server/db/sqlite.server.ts`) does for
 * `npm run backup` and `npm run keys -- status` whenever `state/writer.lock`
 * is there at all.
 *
 * Mechanical pins over BOTH pages, so the next rewrite cannot quietly put a
 * live-file form back:
 *   1. no `sqlite3` invocation targets `state/projection.sqlite` at all
 *      (`mode=ro` was the pass-34 exemption; it is no protection);
 *   2. no fenced bash block opens `state/projection.sqlite` with
 *      `DatabaseSync(` (the pass-34 in-container form), whatever options it
 *      passes;
 *   3. the runbook shows the copy recipe: a fenced bash block that copies the
 *      projection AND its `-wal` and opens the copy;
 *   4. both pages state the rule in words ("copy first", "never a second
 *      connection"), and the runbook names the controller's `viberr_ops` tools
 *      as the in-process reader to ask before copying anything;
 *   5. every in-container `npm run backup` carries an explicit absolute `--out`
 *      (`scripts/backup.ts` defaults to `./backups`, which is `/app/backups` in
 *      the container and is lost with it), outside `/data` (`createBackup`
 *      refuses a destination under the root it backs up), and the page copies
 *      the artefact out with `docker compose cp`;
 *   6. a host-side `npm run backup` in a recipe that also stops the container
 *      comes AFTER the `docker compose down` (with the app down the CLI reads
 *      the file itself; there is nothing to copy first).
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
 * correction notes quote what the page used to say) is not an invocation and
 * does not match.
 */
const SQLITE3_ON_PROJECTION =
  /\bsqlite3\s+(?:-[\w-]+\s+)*"?(?:file:)?\$?[^\s"]*state\/projection\.sqlite[^\s"]*"?/g;

/** A `DatabaseSync(` constructor call whose argument names the live file. */
const DATABASE_SYNC_ON_PROJECTION = /DatabaseSync\([^)]*state\/projection\.sqlite/;

/** The page's fenced ```bash blocks, in order, with the offset of each. */
function bashBlocks(text: string): { body: string; at: number }[] {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => ({
    body: m[1] ?? "",
    at: m.index,
  }));
}

/**
 * The copy recipe: one fenced bash block that copies `state/projection.sqlite`
 * and its `-wal` somewhere else and opens THAT copy (a `DatabaseSync(` or
 * `sqlite3` whose argument is not the live file). Bounded to one block on
 * purpose: a page that copies in one block and opens the live file in another
 * has not shown the recipe. Returns the offset of the first such block, or -1.
 */
function copyRecipeAt(text: string): number {
  const block = bashBlocks(text).find(({ body }) => {
    const copiesMain = /\bcp\b[^\n]*state\/projection\.sqlite\b/.test(body);
    const copiesWal = /projection\.sqlite-wal\b/.test(body);
    const opensACopy =
      (/DatabaseSync\(/.test(body) || /\bsqlite3\s/.test(body)) &&
      !DATABASE_SYNC_ON_PROJECTION.test(body) &&
      !SQLITE3_ON_PROJECTION.test(body);
    return copiesMain && copiesWal && opensACopy;
  });
  return block ? block.at : -1;
}

function sqlite3Invocations(text: string): { command: string; at: number }[] {
  return [...text.matchAll(SQLITE3_ON_PROJECTION)].map((m) => ({
    command: m[0],
    at: m.index,
  }));
}

describe("ruling 158: the operations docs never open a live projection database, on either side", () => {
  it.each(PAGES)("$rel: no sqlite3 invocation targets state/projection.sqlite", ({ rel, text }) => {
    expect(
      sqlite3Invocations(text).map((i) => i.command),
      `${rel} tells an operator to run sqlite3 on the live projection database; ` +
        `a second connection to a live root is the SIGBUS of passes 34 and 35, and mode=ro is no protection. ` +
        `Copy the file and its -wal first and open the copy.`,
    ).toEqual([]);
  });

  it.each(PAGES)(
    "$rel: no fenced block opens state/projection.sqlite with DatabaseSync (the pass-34 in-container form is gone)",
    ({ rel, text }) => {
      const offenders = bashBlocks(text)
        .filter(({ body }) => DATABASE_SYNC_ON_PROJECTION.test(body))
        .map(({ body }) => body.trim());
      expect(
        offenders,
        `${rel} shows a node:sqlite reader opening the LIVE projection database. ` +
          `readOnly: true does not help (pass 35, 18:40Z): copy the file and its -wal first and open the copy.`,
      ).toEqual([]);
    },
  );

  it("runbook.md shows the copy recipe: cp projection.sqlite and its -wal, then open the copy", () => {
    expect(
      copyRecipeAt(RUNBOOK.text),
      `${RUNBOOK.rel} must show one fenced bash block that copies state/projection.sqlite AND ` +
        `projection.sqlite-wal to a scratch directory and opens the copy (DatabaseSync or sqlite3 on the copy's path)`,
    ).toBeGreaterThan(-1);
  });

  it.each(PAGES)("$rel: states the rule in words", ({ rel, text }) => {
    // `\s+`: markdown prose wraps, and the phrase may break across a line.
    expect(text, `${rel} must say "copy first"`).toMatch(/copy\s+first/i);
    expect(text, `${rel} must say "never a second connection"`).toMatch(
      /never\s+a\s+second\s+connection/i,
    );
  });

  it("runbook.md names the controller's viberr_ops tools as the in-process reader to ask first", () => {
    const readers = /### Readers[\s\S]*?(?=\n## )/.exec(RUNBOOK.text)?.[0] ?? "";
    expect(readers, `${RUNBOOK.rel} must keep a "### Readers" section`).not.toBe("");
    expect(
      readers,
      `${RUNBOOK.rel}'s readers section must name viberr_ops: the controller reads through the server's own handle`,
    ).toContain("viberr_ops");
  });

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
          `${rel}: this recipe runs "npm run backup" from the host BEFORE "docker compose down"; ` +
            `with the app down there is nothing to copy first:\n${block}`,
        ).toBeGreaterThan(down);
      }
    },
  );
});

