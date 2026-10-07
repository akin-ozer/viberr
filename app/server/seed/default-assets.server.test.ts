import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { z } from "zod";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import { sha256Hex } from "~/server/files/content-hash.server";
import { logger } from "~/server/logging/logger.server";
import { getBuildInfo } from "~/server/ops/build-info.server";
import { DONE_SIGNAL_RULE } from "~/server/tasks/done-signal.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import { createTestDbContext } from "../../../test-support/test-db";
import { SEED_AGENT_PROFILES } from "./agent-catalog.server";

/**
 * P13 regression: the shipped agent assets must load under EVERY runtime, not
 * just Vite's.
 *
 * They used to be imported with Vite's `?raw`. When `seed.server.ts` began
 * emitting the shipped personas (AP-03), this module entered the import graph
 * of `tsx scripts/seed.ts` and the documented install step `npm run seed` died
 * with `ERR_UNKNOWN_FILE_EXTENSION ".md"`. Typecheck, the whole unit suite and
 * the production build were green throughout — vitest and vite both understand
 * `?raw` — so nothing except a real CLI invocation could catch it.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/** The on-disk bookkeeping this module maintains: shipped path → content hash. */
const manifestSchema = z.record(z.string(), z.string());
/** The asset a divergence warning names, and the drift it reports. */
const warnedAssetSchema = z.object({ asset: z.string() });
const divergenceFieldsSchema = z.object({
  onDisk: z.string(),
  shipped: z.string(),
  path: z.string(),
});
const roots: string[] = [];
/** One `## heading` section of a shipped markdown asset, to the next heading ("" when absent). */
function markdownSection(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return "";
  const end = text.indexOf("\n## ", start + 1);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
const dbCtx = createTestDbContext();
afterEach(dbCtx.cleanup);

describe("shipped default assets", () => {
  it("exposes every persona/skill body with real content", async () => {
    const mod = await import("./default-assets.server");
    expect(mod.seedDefaultAgentAssets).toBeTypeOf("function");
    // The operator profile template is built from the assets; an empty asset
    // would silently ship an agent with no instructions.
    const assetDir = path.join(REPO_ROOT, "app/server/seed/assets");
    for (const file of readdirSync(assetDir).filter((f) => f.endsWith(".md"))) {
      expect(
        readFileSync(path.join(assetDir, file), "utf8").trim().length,
        `${file} is empty`,
      ).toBeGreaterThan(50);
    }
  });

  it("uses no Vite-only import loader anywhere the CLI entrypoints can reach", () => {
    // `scripts/*.ts` run under tsx, which has no `?raw` loader. Keeping the
    // server tree free of it is what makes `npm run seed` / `npm run seed:demo`
    // survive any future import-graph change.
    // Only IMPORT statements matter; prose mentioning `?raw` is fine.
    let hits = "";
    try {
      hits = execFileSync(
        "grep",
        [
          "-rnE",
          "--include=*.ts",
          "--include=*.tsx",
          "from \\\"[^\\\"]*\\?raw\\\"",
          "app",
          "test-support",
          "scripts",
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      ).trim();
    } catch {
      hits = ""; // grep exits 1 when there are no matches — that is the pass case
    }
    expect(hits, `Vite-only ?raw imports found:\n${hits}`).toBe("");
  });

  it("F15-14: the shipped operator doctrine carries the triage quality gate", () => {
    // The gate the New-task dialog promises ("underspecified goals get flagged")
    // lived nowhere in the persona, and live a textbook-vague goal walked
    // straight through Triage.
    const definition = readFileSync(
      path.join(REPO_ROOT, "app/server/seed/assets/operator.definition.md"),
      "utf8",
    );
    expect(definition).toContain("triage quality gate");
    expect(definition).toContain("MUST NOT transition forward");
    expect(definition).toContain("acceptance criteria");
  });

  it("`npm run seed` completes on a clean data root", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-seed-cli-"));
    roots.push(dataRoot);
    execFileSync("npm", ["run", "seed"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        VIBERR_DATA_ROOT: dataRoot,
        VIBERR_SESSION_SECRET: "seed-cli-secret-0123456789abcdefghijklmnop",
        VIBERR_SECRET_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
    });
    // AP-03: the seeded specialist templates carry the SHIPPED persona, not the
    // two-sentence catalog blurb.
    const developer = readFileSync(
      path.join(dataRoot, "agents/profiles/developer.md"),
      "utf8",
    );
    expect(developer).toContain("You are the Developer");
  }, 120_000);
});

/**
 * B-OP1: `seedDefaultAgentAssets` only ever wrote MISSING files, so a store
 * seeded before a doctrine rewrite kept running the old one forever — live, the
 * operator followed a standard operating procedure naming tools that no longer
 * exist, because the runtime prefers the store copy over the shipped asset. A
 * copy that still hashes to something this app shipped is refreshed; a copy a
 * human edited is not.
 */
describe("shipped-asset refresh (B-OP1)", () => {
  const OPERATOR_REL = path.join("agents", "definitions", "operator.md");

  function freshStore(): string {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-assets-"));
    roots.push(dataRoot);
    return dataRoot;
  }

  const storeCopy = (dataRoot: string): string =>
    readFileSync(path.join(dataRoot, OPERATOR_REL), "utf8");

  const shipped = (): string =>
    readFileSync(
      path.join(REPO_ROOT, "app/server/seed/assets/operator.definition.md"),
      "utf8",
    );

  it("pass 34 A19/A21: the operator doctrine says a hand-off is about who builds, never about stages, and its outgoing hash is recorded", async () => {
    // Canaries: revert the rework paragraph; remove the outgoing hash.
    const { shippedCopyIsUnedited } = await import("./default-assets.server");
    expect(shippedCopyIsUnedited(OPERATOR_REL, "dd42d1a7614df74f937519f53a0e9690affa0e0eb8a89da07d38cac4fc580752", {})).toBe(true);
    expect(shipped()).toContain("the deliverer owes the rework and it runs at EVERY stage");
    expect(shipped()).toContain("Never hand delivery to another profile to get around a stage.");
    expect(shipped()).not.toContain("does not work the CURRENT stage");
  });

  /**
   * Ruling 468 (F40-12): the operator never asks a person for a repository's
   * first commit. Live on WEB-1 its first run found an unborn `main` and
   * opened a packet whose recommended option was "I pushed an initial commit
   * to main"; nothing it read said Viberr makes that commit.
   */
  it("ruling 468: the doctrine says an empty repository is Viberr's to initialize, and its outgoing hash is recorded", async () => {
    // Canaries: drop the sentence; remove the outgoing hash.
    const { shippedCopyIsUnedited } = await import("./default-assets.server");
    expect(shippedCopyIsUnedited(OPERATOR_REL, "1763e3889a2da992052bebd5accbe51854baea010bc80d7e8d7aa96266715c13", {})).toBe(true);
    expect(shipped()).toContain("An EMPTY repository (no commit yet, an unborn default branch) is never a person's chore");
    expect(shipped()).toContain("Never ask anyone to push an initial commit or a README");
    // Nothing in it instructs a manual first commit.
    expect(shipped()).not.toMatch(/(ask|tell) (a person|the owner|a human)[^.]*(push|make)[^.]*(initial|first) commit/i);
  });

  /**
   * Ruling 487 (F40-65): a wait on a clock is scheduled, never asked, and a
   * hold a pending schedule explains needs no packet. Live on WEB-9 the
   * operator asked the owner to route a 12:25Z run through the controller and
   * opened a packet only to record the wait, obeying "never leave a pre-work
   * or `auto` stage with nothing done and no packet".
   */
  it("ruling 487: the doctrine schedules a wait on a clock and records a scheduled hold with a note, and its outgoing hash is recorded", async () => {
    // Canaries: drop the new sentences; restore "nothing done and no packet";
    // remove the outgoing hash.
    const { shippedCopyIsUnedited } = await import("./default-assets.server");
    expect(shippedCopyIsUnedited(OPERATOR_REL, "0386467b19815de69f8a814134081b78813e2d99414c7ab45b563da84bf26786", {})).toBe(true);
    const doctrine = shipped();
    expect(doctrine).toContain("that wait is scheduled, not asked: `schedule_task_action` the run that picks it up then");
    expect(doctrine).toContain("Never ask a person to schedule it or to route it through the controller");
    expect(doctrine).toContain("A hold that a pending schedule explains needs NO decision packet");
    expect(doctrine).toContain("write one timeline note naming the schedule and end your turn");
    expect(doctrine).toContain("A decision packet is for a decision a person must make, never for recording that you are waiting.");
    expect(doctrine).not.toContain("nothing done and no packet");
  });

  /**
   * Ruling 488 (F40-67): text meant for another task is relayed, never handed
   * to a person to post there. Live on WEB-9 the acceptance packet asked the
   * owner to confirm two attachments had been pasted onto WEB-8 by hand.
   */
  it("ruling 488: the doctrine and the specialist handbook relay text between tasks and never hand it to a person, and their outgoing hashes are recorded", async () => {
    // Canaries: drop the doctrine's paragraph, the app skill's tool line or
    // the Developer's reporting bullet; remove any of the three hashes.
    const { shippedCopyIsUnedited } = await import("./default-assets.server");
    expect(shippedCopyIsUnedited(OPERATOR_REL, "474502b29f913396ec86de5f2fd8088d7a0a221a12342e5972ea815cc8d1fa0c", {})).toBe(true);
    expect(
      shippedCopyIsUnedited(
        path.join("skills", "viberr-app-expertise", "SKILL.md"),
        "a0e0896423dc9a9344d814181c90346c65a6068f84b7512d4820d6994cbf3bc7",
        {},
      ),
    ).toBe(true);
    expect(
      shippedCopyIsUnedited(
        path.join("skills", "developer-expertise", "SKILL.md"),
        "6c22506cf4bb40c40011d2c0afefbdd7f59d0bd891a8ecdf3df0c1ec00a5392a",
        {},
      ),
    ).toBe(true);
    const doctrine = shipped();
    expect(doctrine).toContain("post it there with `relay_to_task`");
    expect(doctrine).toContain(
      "Never hand text to a person to copy, paste or post between tasks, never ask for an attachment to be carried over, and never ask a person to confirm a relay landed",
    );
    const asset = (file: string) =>
      readFileSync(path.join(REPO_ROOT, "app/server/seed/assets", file), "utf8");
    expect(asset("viberr-app-expertise.skill.md")).toContain(
      "- `relay_to_task` posts on ANOTHER task in this project (ruling 488)",
    );
    expect(asset("developer-expertise.skill.md")).toContain(
      "put it in the `relay` entries of your reported outcome",
    );
    expect(asset("developer-expertise.skill.md")).toContain(
      "Never write it to an attachment or into your report for a person to copy over.",
    );
  });

  /**
   * Ruling 492 (F40-69): a done signal is something the task can show before
   * acceptance, which closes the task. Goals kept asking for a proof only the
   * merged or deployed code could show (the operator's option on WEB-16,
   * WEB-13, goal-1 links 9 and 11), and nothing their authors read said
   * otherwise. The controller guide and the operator doctrine quote
   * `DONE_SIGNAL_RULE` word for word, and the doctrine says the operator
   * raises the follow-up read as a `create_task` option.
   *
   * Review (2026-09-26): the read's goal confirms the merge and the deploy,
   * because the read is released at Done and the operator's own acceptance
   * leaves the merge pending; and the doctrine waits for a person's answer
   * to that option before the task goes up for acceptance, because an
   * acceptance withdraws an open decision unanswered. The first doctrine
   * said "Never hold this task back for that proof" instead.
   */
  it("ruling 492: the controller guide and the operator doctrine carry the done-signal rule, and their outgoing hashes are recorded", async () => {
    // Canaries: drop the rule from the guide's "Creating a task" section or
    // its bullet from "Epics"; drop the rule or the create_task sentence from
    // the doctrine; remove either outgoing hash. Review canaries: drop the
    // merge check from the guide's read task or its epic example; drop the
    // doctrine's wait for the answer; restore "Never hold this task back for
    // that proof". Ruling 503 moved the guide's bullet from "Chained goals"
    // to "Epics" and the doctrine's check from `goalChain` to the task's epic.
    const { PRIOR_SHIPPED_HASHES, shippedCopyIsUnedited } = await import("./default-assets.server");
    const guideRel = path.join("skills", "controller-guide", "SKILL.md");
    expect(
      shippedCopyIsUnedited(guideRel, "ce538f0db704167a768cdab3848110ad5c46ff7843919330927bf59efda22a57", {}),
      "the guide's outgoing hash is not recorded",
    ).toBe(true);
    expect(
      shippedCopyIsUnedited(OPERATOR_REL, "ee212fda34ef04e0447ed1edd1a2f50b6c1cd92cde5ac498956cea61dbcfb6d8", {}),
      "the doctrine's outgoing hash is not recorded",
    ).toBe(true);
    const guide = readFileSync(
      path.join(REPO_ROOT, "app/server/seed/assets/controller-guide.skill.md"),
      "utf8",
    );
    const doctrine = shipped();
    expect(PRIOR_SHIPPED_HASHES[guideRel]).not.toContain(sha256Hex(guide));
    expect(PRIOR_SHIPPED_HASHES[OPERATOR_REL]).not.toContain(sha256Hex(doctrine));
    const section = (heading: string): string => markdownSection(guide, heading);
    const creating = section("Creating a task");
    expect(creating, "the guide's Creating a task section").toContain(DONE_SIGNAL_RULE);
    expect(creating, "the guide's Creating a task section").toContain("create both tasks in the same turn");
    expect(creating, "the guide's Creating a task section").toContain(
      "a goal that confirms the delivery task's change is merged and deployed before it reads",
    );
    const epics = section("Epics");
    expect(epics, "the guide's Epics section").toContain(
      "it is something the task can show BEFORE acceptance",
    );
    expect(epics, "the guide's Epics section").toContain(
      "is two tasks in the epic: the delivery task, and a read task whose `blockedBy` names it",
    );
    expect(epics, "the guide's Epics section").toContain(
      "confirms the job is merged and deployed, then reads its first run on the deployed build",
    );
    expect(section("Chained goals"), "ruling 503 retired the Chained goals section").toBe("");
    expect(doctrine, "the operator doctrine").toContain(DONE_SIGNAL_RULE);
    expect(doctrine, "the operator doctrine").toContain(
      "raise a `create_task` option for the read: its `newTask.blockedBy` names this task, its `newTask.goal` has the read confirm this task's change is merged and deployed before it reads",
    );
    expect(doctrine, "the operator doctrine").toContain(
      "Then stop, and put this task up for acceptance only once a person has answered that option",
    );
    expect(doctrine, "the operator doctrine").not.toContain("Never hold this task back");
    expect(doctrine, "the operator doctrine").toContain(
      "no task owns that read (`read_board` lists none, and no task in your `epic` is one)",
    );
    expect(doctrine, "the operator doctrine").not.toContain("goalChain");
    for (const text of [guide, doctrine]) expect(text).not.toMatch(/[–—]/);
  });

  /**
   * Ruling 494 (F40-70): a behind count is true only of the head it was
   * counted on. Live on WEB-16 two packets told the owner the branch was 6
   * commits behind `main`, five minutes after a push that carried `main`.
   */
  it("ruling 494: the doctrine checks a behind count's head against the head just pushed and keeps another head's count out of packets, and its outgoing hashes are recorded", async () => {
    // Canaries: drop the sentences; remove either outgoing hash; say "Never
    // call it" again after the packet sentence.
    const { shippedCopyIsUnedited } = await import("./default-assets.server");
    expect(shippedCopyIsUnedited(OPERATOR_REL, "ee212fda34ef04e0447ed1edd1a2f50b6c1cd92cde5ac498956cea61dbcfb6d8", {})).toBe(true);
    // The text as ruling 494 first shipped it, before its review named the tool.
    expect(shippedCopyIsUnedited(OPERATOR_REL, "43a9a0b59ee0c6d6e58cbc5c6807467005b5b343f7e5f7909d622a944d23d5e4", {})).toBe(true);
    const doctrine = shipped();
    expect(doctrine).toContain(
      "`get_task`'s `baseBehindBy` is the count the last compare read, and `baseComparedHead` names the head it read: check that head against the head you just pushed before you rely on the count or repeat it.",
    );
    expect(doctrine).toContain(
      "a decision packet never states a behind count for a head other than the one the packet puts up",
    );
    // The sentence after the packet rule names the tool it forbids: an "it"
    // there reads as the packet or the count.
    expect(doctrine).toContain(
      "the one the packet puts up. Never call `update_branch_from_base` once the task stands at the acceptance stage",
    );
  });

  /**
   * Ruling 531: the operator scopes and delivers a task whose deliverable is a
   * result (ruling 530) on the task. The turn prompt carries both rules from
   * `result-delivery.server.ts`; the doctrine a project reads quotes them, so
   * the two cannot drift, and a store seeded before them upgrades in place.
   */
  it("ruling 531: the operator doctrine quotes the result rules word for word, and its outgoing hash is recorded", async () => {
    // CANARY: drop either rule from the doctrine, or reword one side only; or
    // remove the outgoing hash.
    const { PRIOR_SHIPPED_HASHES, shippedCopyIsUnedited } = await import("./default-assets.server");
    const { RESULT_DELIVERY_RULE, RESULT_GOAL_RULE } = await import(
      "~/server/tasks/result-delivery.server"
    );
    expect(
      shippedCopyIsUnedited(OPERATOR_REL, "e3abc19158dc27db39cd9efd29b3a2cceb1a0cf78eaf852b46738e783b159b89", {}),
      "the doctrine's outgoing hash is not recorded",
    ).toBe(true);
    const doctrine = shipped();
    expect(PRIOR_SHIPPED_HASHES[OPERATOR_REL]).not.toContain(sha256Hex(doctrine));
    expect(doctrine, "the triage gate").toContain(RESULT_GOAL_RULE);
    expect(doctrine, "the delivery paragraph").toContain(RESULT_DELIVERY_RULE);
  });

  it("pass 34 A13: the operator doctrine shipped before `set_dependencies` is a recorded prior hash, so a live store upgrades in place", async () => {
    // Canary: remove the outgoing hash from PRIOR_SHIPPED_HASHES.
    const { shippedCopyIsUnedited } = await import("./default-assets.server");
    expect(shippedCopyIsUnedited(OPERATOR_REL, "9731f0a69b6a8b5824277c4d1a2d4ad18cc126c2ca827a844369f9f0ed9ef3f6", {})).toBe(true);
    expect(shipped()).toContain("`set_dependencies`");
  });

  it("pass 34 A14: the controller definition and guide shipped before `blockedBy` are recorded prior hashes, so both upgrade in place", async () => {
    // Canary: omit the skill's hash.
    const { shippedCopyIsUnedited } = await import("./default-assets.server");
    const path = await import("node:path");
    expect(shippedCopyIsUnedited(path.join("agents", "definitions", "controller.md"), "e600925f824e5ec43ca962c56304e5099ae76a1ad41dff8bc94a431666756712", {})).toBe(true);
    expect(shippedCopyIsUnedited(path.join("skills", "controller-guide", "SKILL.md"), "69805ce6bb7bd0180014e164ae6d863268813bd4fb6a0f61bfa4e333b6674608", {})).toBe(true);
  });

  it("ruling 483: the operator skill and controller guide shipped before knowledge-base proposals are recorded prior hashes", async () => {
    // Canary: omit either outgoing hash and a live store keeps the version that
    // names `propose_ruling` or never mentions `resolve_kb_proposal`.
    const { shippedCopyIsUnedited } = await import("./default-assets.server");
    const path = await import("node:path");
    expect(
      shippedCopyIsUnedited(
        path.join("skills", "viberr-app-expertise", "SKILL.md"),
        "20acdfcb363f22622c38a48ca0f5963a5a09399aa76f87cccace59c15a2c2509",
        {},
      ),
    ).toBe(true);
    expect(
      shippedCopyIsUnedited(
        path.join("skills", "controller-guide", "SKILL.md"),
        "7418f3499b14e1c8ce8a0cc46d6efdec850370712f1ec56728c1130302fcb948",
        {},
      ),
    ).toBe(true);
    const assets = path.join(import.meta.dirname, "assets");
    const guide = readFileSync(path.join(assets, "controller-guide.skill.md"), "utf8");
    expect(guide).toContain("`resolve_kb_proposal`");
  });

  it("ruling 498: the operator skill and controller guide shipped before corrections were written are recorded prior hashes", async () => {
    // Canary: omit either outgoing hash and a live store keeps the version that
    // tells agents to propose and the controller to wait for a person.
    const { shippedCopyIsUnedited } = await import("./default-assets.server");
    const path = await import("node:path");
    expect(
      shippedCopyIsUnedited(
        path.join("skills", "viberr-app-expertise", "SKILL.md"),
        "195516db43c82959b5d0ec94806e15de0a1b90fd68f02525c95e43d7effdae2d",
        {},
      ),
    ).toBe(true);
    expect(
      shippedCopyIsUnedited(
        path.join("skills", "controller-guide", "SKILL.md"),
        "a8e1cd90673ab1b2eccf08aeeff10f1e7f8ae181a4dc0c82518b08303dd5ba85",
        {},
      ),
    ).toBe(true);
    const assets = path.join(import.meta.dirname, "assets");
    const skill = readFileSync(path.join(assets, "viberr-app-expertise.skill.md"), "utf8");
    const guide = readFileSync(path.join(assets, "controller-guide.skill.md"), "utf8");
    expect(skill).toContain("`correct_knowledge_doc`");
    expect(skill).not.toContain("propose_kb_correction");
    expect(skill).not.toContain("not binding");
    expect(guide).toContain("`undo_kb_correction`");
    expect(guide).toContain("`kbCorrections`");
  });

  /**
   * Ruling 526: the timeline draws a verdict's evidence as a checklist, so the
   * Reviewer is told what each row carries: what it checked, how it came out,
   * and its pass, fail or info mark. A store seeded before it upgrades in place.
   */
  it("ruling 526: the reviewer skill asks for each row's result and mark, and its outgoing hash is recorded", async () => {
    // Canaries: drop the mark from the skill's evidence-rows bullet; remove
    // the outgoing hash.
    const { PRIOR_SHIPPED_HASHES, shippedCopyIsUnedited } = await import("./default-assets.server");
    const rel = path.join("skills", "reviewer-expertise", "SKILL.md");
    expect(
      shippedCopyIsUnedited(rel, "0fea5d36f4a35643d4352cccfc35183018a76907bc9387c4c2b34bb9abbbb57a", {}),
      "the skill's outgoing hash is not recorded",
    ).toBe(true);
    const skill = readFileSync(path.join(REPO_ROOT, "app/server/seed/assets/reviewer-expertise.skill.md"), "utf8");
    expect(PRIOR_SHIPPED_HASHES[rel]).not.toContain(sha256Hex(skill));
    expect(skill).toContain("and marks it `pass`, `fail`, or `info`");
    expect(skill).toContain("so mark a row that blocks as `fail`");
  });

  it("ruling 619: the operator skill carries an earlier stage's fix through a later stage's file, and its outgoing hash is recorded", async () => {
    // Canaries: drop the bullet; remove the outgoing hash.
    const { PRIOR_SHIPPED_HASHES, shippedCopyIsUnedited } = await import("./default-assets.server");
    const rel = path.join("skills", "viberr-app-expertise", "SKILL.md");
    expect(
      shippedCopyIsUnedited(rel, "c58c22c5e04de01ae5ccd0114869c560e1a16376a4be2420b6ce5cb618dfa3d4", {}),
      "the skill's outgoing hash is not recorded",
    ).toBe(true);
    const skill = readFileSync(path.join(REPO_ROOT, "app/server/seed/assets/viberr-app-expertise.skill.md"), "utf8");
    expect(PRIOR_SHIPPED_HASHES[rel]).not.toContain(sha256Hex(skill));
    const prose = skill.replace(/\s+/g, " ");
    expect(prose).toContain("A fix at one stage can leave a later stage's file stale.");
    expect(prose).toContain(
      "make the lines of its own file that restate the change part of its job, whether or not it has a finding of its own",
    );
  });

  it("refreshes an UNEDITED copy of an older shipped version", async () => {
    const { seedDefaultAgentAssets } = await import("./default-assets.server");
    const dataRoot = freshStore();
    seedDefaultAgentAssets(dataRoot);
    expect(storeCopy(dataRoot)).toBe(shipped());

    // Roll the store back to a previous release's doctrine, exactly as that
    // release wrote it (its hash recorded in the manifest it maintained).
    const manifestPath = path.join(dataRoot, "state", "shipped-assets.json");
    const oldDoctrine = "---\nid: operator\n---\n\nCall assign_specialist, then prompt_specialist.\n";
    writeFileSync(path.join(dataRoot, OPERATOR_REL), oldDoctrine, "utf8");
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
    manifest[OPERATOR_REL] = sha256Hex(oldDoctrine);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    seedDefaultAgentAssets(dataRoot);

    expect(storeCopy(dataRoot)).toBe(shipped());
    const after = manifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
    expect(after[OPERATOR_REL]).toBe(sha256Hex(shipped()));
  });

  // CANARY: record nothing after a refresh and an upgrade that replaced the
  // operator's doctrine leaves a log line and no row; record on every boot
  // and each restart of an unchanged build writes one.
  it("ruling 681: a boot that refreshed a shipped file records which and under which build, and one that refreshed nothing records nothing", async () => {
    const { recordShippedAssetRefresh, seedDefaultAgentAssets } = await import("./default-assets.server");
    const dataRoot = freshStore();
    const db = dbCtx.makeDb();
    /** One boot: the refresh, then its record once there is a database. */
    const boot = () => recordShippedAssetRefresh(db, seedDefaultAgentAssets(dataRoot));

    // A first boot writes every file and replaces none.
    boot();
    expect(listAuditEvents(db)).toEqual([]);

    // A previous release's doctrine, as that release recorded writing it.
    const manifestPath = path.join(dataRoot, "state", "shipped-assets.json");
    const oldDoctrine = "---\nid: operator\n---\n\nCall assign_specialist, then prompt_specialist.\n";
    writeFileSync(path.join(dataRoot, OPERATOR_REL), oldDoctrine, "utf8");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    manifest[OPERATOR_REL] = sha256Hex(oldDoctrine);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    boot();
    // The same build started again: nothing left to refresh.
    boot();

    const build = getBuildInfo();
    expect(
      listAuditEvents(db).map((row) => [row.action, row.actorLabel, row.projectSlug, row.details]),
    ).toEqual([
      [
        "org.shipped_assets.refreshed",
        "system",
        null,
        { assets: [OPERATOR_REL], version: build.version, revision: build.revision },
      ],
    ]);
  });

  it("never touches a copy a human edited", async () => {
    const { seedDefaultAgentAssets } = await import("./default-assets.server");
    const dataRoot = freshStore();
    seedDefaultAgentAssets(dataRoot);

    const edited = `${shipped()}\n\nOur team also always tags the on-call reviewer.\n`;
    writeFileSync(path.join(dataRoot, OPERATOR_REL), edited, "utf8");

    seedDefaultAgentAssets(dataRoot);
    expect(storeCopy(dataRoot)).toBe(edited);
  });

  /**
   * B7: preserving the edit is correct, but doing it SILENTLY is how the live
   * `./data` store ended up running an operator.md that matches no shipped
   * version and still names the deleted `prompt_specialist` /
   * `assign_specialist` tools. Boot must name the file and the drift.
   */
  it("WARNS that a diverged copy is being kept, naming the asset and both hashes", async () => {
    const { seedDefaultAgentAssets } = await import("./default-assets.server");
    const dataRoot = freshStore();
    seedDefaultAgentAssets(dataRoot);

    // A copy that hashes to nothing this app ever shipped — the shape of the
    // real finding, not a hand-appended paragraph.
    const diverged = "---\nid: operator\n---\n\nCall assign_specialist, then prompt_specialist.\n";
    writeFileSync(path.join(dataRoot, OPERATOR_REL), diverged, "utf8");

    const warn = vi.spyOn(logger, "warn");
    try {
      seedDefaultAgentAssets(dataRoot);

      // Still preserved — the warning REPLACES silence, not the fail-safe.
      expect(storeCopy(dataRoot)).toBe(diverged);

      const call = warn.mock.calls.find(([, fields]) => {
        const warned = warnedAssetSchema.safeParse(fields);
        return warned.success && warned.data.asset === OPERATOR_REL;
      });
      expect(call, "no warning named the diverged asset").toBeDefined();
      const fields = divergenceFieldsSchema.parse(call![1]);
      expect(fields.onDisk).toBe(sha256Hex(diverged).slice(0, 12));
      expect(fields.shipped).toBe(sha256Hex(shipped()).slice(0, 12));
      expect(fields.path).toBe(path.join(dataRoot, OPERATOR_REL));
    } finally {
      warn.mockRestore();
    }
  });

  it("adopts a pre-manifest store that is already current, so the NEXT rewrite reaches it", async () => {
    const { seedDefaultAgentAssets } = await import("./default-assets.server");
    const dataRoot = freshStore();
    // A store written by a build with no manifest: the file is there, the
    // bookkeeping is not.
    mkdirSync(path.dirname(path.join(dataRoot, OPERATOR_REL)), { recursive: true });
    writeFileSync(path.join(dataRoot, OPERATOR_REL), shipped(), "utf8");

    seedDefaultAgentAssets(dataRoot);

    const manifest = manifestSchema.parse(
      JSON.parse(
        readFileSync(path.join(dataRoot, "state", "shipped-assets.json"), "utf8"),
      ),
    );
    expect(manifest[OPERATOR_REL]).toBe(sha256Hex(shipped()));
  });

  it("recognizes the versions shipped before the manifest existed", async () => {
    const { PRIOR_SHIPPED_HASHES, shippedCopyIsUnedited } = await import(
      "./default-assets.server"
    );
    const known = PRIOR_SHIPPED_HASHES[OPERATOR_REL] ?? [];
    // The pre-pass-15 doctrine is in the list, so a store seeded from it — the
    // docker-data copy this finding was raised against — converges on boot.
    expect(known).toContain(
      "849d977503fe2a3b04776379b4017d40e50d95ed394770f28ef825e8513085d6",
    );
    expect(shippedCopyIsUnedited(OPERATOR_REL, known[0]!, {})).toBe(true);
    expect(shippedCopyIsUnedited(OPERATOR_REL, "f".repeat(64), {})).toBe(false);
    // The manifest is the other half: whatever this app last wrote counts.
    expect(shippedCopyIsUnedited(OPERATOR_REL, "a".repeat(64), {
      [OPERATOR_REL]: "a".repeat(64),
    })).toBe(true);
  });
});

// ------------------------------------------------------------ ruling 121

describe("the controller doctrine and skill upgrade in place (ruling 121)", () => {
  const assetsDir = path.join(import.meta.dirname, "assets");

  it("lists the outgoing versions of both files, so an unedited store copy is refreshed at boot", async () => {
    const { PRIOR_SHIPPED_HASHES, shippedCopyIsUnedited } = await import(
      "./default-assets.server"
    );
    const definitionRel = path.join("agents", "definitions", "controller.md");
    const skillRel = path.join("skills", "controller-guide", "SKILL.md");
    expect(PRIOR_SHIPPED_HASHES[definitionRel]).toContain(
      "8dcb2d1bb8f3668bcc9337af2d07be196ed704b66d70b699b2ac55e39ebf258c",
    );
    expect(PRIOR_SHIPPED_HASHES[skillRel]).toContain(
      "a2defe42d6fb6a5eed063a1e7b9bb9b5636c1619c1f5ea0f6e56838b9628fecd",
    );
    for (const [rel, hashes] of [
      [definitionRel, PRIOR_SHIPPED_HASHES[definitionRel]!],
      [skillRel, PRIOR_SHIPPED_HASHES[skillRel]!],
    ] as const) {
      for (const hash of hashes) expect(shippedCopyIsUnedited(rel, hash, {})).toBe(true);
    }
    // The shipped text is NEW: neither outgoing hash is the current one.
    const definition = readFileSync(path.join(assetsDir, "controller.definition.md"), "utf8");
    const skill = readFileSync(path.join(assetsDir, "controller-guide.skill.md"), "utf8");
    expect(PRIOR_SHIPPED_HASHES[definitionRel]).not.toContain(sha256Hex(definition));
    expect(PRIOR_SHIPPED_HASHES[skillRel]).not.toContain(sha256Hex(skill));
  });

  /**
   * Review finding 33: the assertions above compare the constant with its own
   * literals, which a WRONG hash would pass while every existing store kept
   * the stale doctrine forever. The historical bytes cannot be re-derived once
   * this change is committed (HEAD would hold the new text, and CI clones at
   * depth 1), so what is asserted here is the MECHANISM the hash list feeds:
   * a store copy this app is recorded as having written is really replaced by
   * the shipped one, for the two ruling-121 assets specifically.
   */
  it("upgrades a recorded copy of the controller doctrine and skill in place", async () => {
    const { seedDefaultAgentAssets } = await import("./default-assets.server");
    const definitionRel = path.join("agents", "definitions", "controller.md");
    const skillRel = path.join("skills", "controller-guide", "SKILL.md");
    const shipped = {
      [definitionRel]: readFileSync(path.join(assetsDir, "controller.definition.md"), "utf8"),
      [skillRel]: readFileSync(path.join(assetsDir, "controller-guide.skill.md"), "utf8"),
    };
    const root = mkdtempSync(path.join(tmpdir(), "viberr-ctl-upgrade-"));
    roots.push(root);
    const manifest: Record<string, string> = {};
    for (const rel of [definitionRel, skillRel]) {
      const older = `# an older shipped ${rel}\n`;
      const dest = path.join(root, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, older, "utf8");
      // What the app recorded when it last wrote that file — the same claim
      // every entry in PRIOR_SHIPPED_HASHES makes about a released version.
      manifest[rel] = sha256Hex(older);
    }
    mkdirSync(path.join(root, "state"), { recursive: true });
    writeFileSync(
      path.join(root, "state", "shipped-assets.json"),
      JSON.stringify(manifest),
      "utf8",
    );

    seedDefaultAgentAssets(root);

    for (const rel of [definitionRel, skillRel]) {
      expect(readFileSync(path.join(root, rel), "utf8")).toBe(shipped[rel]);
    }
    // A copy the app never wrote is still left alone.
    writeFileSync(path.join(root, definitionRel), "# mine now\n", "utf8");
    seedDefaultAgentAssets(root);
    expect(readFileSync(path.join(root, definitionRel), "utf8")).toBe("# mine now\n");
  });

  it("names the tools that exist and the context read, and no longer a comment that starts runs", () => {
    const definition = readFileSync(path.join(assetsDir, "controller.definition.md"), "utf8");
    const skill = readFileSync(path.join(assetsDir, "controller-guide.skill.md"), "utf8");
    for (const text of [definition, skill]) {
      expect(text).not.toContain("list_projects");
      expect(text).toContain("`whoami`");
      expect(text).toContain("update_task");
    }
    expect(definition).toContain("context block the server gathered when the turn started");
    expect(definition).toContain("A comment never starts a run by itself");
    expect(skill).toContain("## The context you are handed");
  });
});

/**
 * Ruling 462 (pass 40, F40-5): the controller's playbook says a project's
 * repository need not exist first and names `createRepository`. The outgoing
 * version is listed so an unedited store copy upgrades at boot.
 *
 * Canary: drop the bullet, or the outgoing hash, and the matching assertion
 * fails.
 */
describe("the controller playbook learns createRepository (ruling 462)", () => {
  const assetsDir = path.join(import.meta.dirname, "assets");
  it("names the flag and lists its outgoing version", async () => {
    const { PRIOR_SHIPPED_HASHES, shippedCopyIsUnedited } = await import(
      "./default-assets.server"
    );
    const skill = readFileSync(path.join(assetsDir, "controller-guide.skill.md"), "utf8");
    expect(skill).toContain("The repository does not have to exist first.");
    expect(skill).toContain("pass `createRepository` to `create_project`");
    expect(skill).not.toMatch(/[–—]/);
    const rel = path.join("skills", "controller-guide", "SKILL.md");
    const outgoing = "f58275ca76e09a6d149e8fa3b7e8bec73cd9a7f34627e642ced603fdb1dcfd91";
    expect(shippedCopyIsUnedited(rel, outgoing, {})).toBe(true);
    expect(PRIOR_SHIPPED_HASHES[rel]).not.toContain(sha256Hex(skill));
  });
});

/**
 * Ruling 463 (pass 40, F40-6): the controller's playbook sends it to
 * `list_github_connections` before `create_project`. The outgoing version is
 * listed so an unedited store copy upgrades at boot.
 *
 * Canary: drop the bullet, or the outgoing hash, and the matching assertion
 * fails.
 */
describe("the controller playbook learns list_github_connections (ruling 463)", () => {
  const assetsDir = path.join(import.meta.dirname, "assets");
  it("names the read and lists its outgoing version", async () => {
    const { PRIOR_SHIPPED_HASHES, shippedCopyIsUnedited } = await import(
      "./default-assets.server"
    );
    const skill = readFileSync(path.join(assetsDir, "controller-guide.skill.md"), "utf8");
    // Ruling 667 scoped the bullet to the board that needs a connection.
    expect(skill).toContain("For a software board, read the GitHub connections before you create anything.");
    expect(skill).toContain("`list_github_connections` first");
    expect(skill).not.toMatch(/[–—]/);
    const rel = path.join("skills", "controller-guide", "SKILL.md");
    const outgoing = "26672ee429c9089c9c676bc178b5afaf401927f90596c6cb2f36660da185c762";
    expect(shippedCopyIsUnedited(rel, outgoing, {})).toBe(true);
    expect(PRIOR_SHIPPED_HASHES[rel]).not.toContain(sha256Hex(skill));
  });
});

/**
 * Ruling 464 (pass 40, F40-7): the controller's playbook says to pass the
 * designed roster as `agents` and names the one removal it holds. The
 * outgoing version is listed so an unedited store copy upgrades at boot.
 *
 * Canary: drop the bullet, the removal sentence, or the outgoing hash, and the
 * matching assertion fails.
 */
describe("the controller playbook learns `agents` and remove_agent_deployment (ruling 464)", () => {
  const assetsDir = path.join(import.meta.dirname, "assets");
  it("names both and lists its outgoing version", async () => {
    const { PRIOR_SHIPPED_HASHES, shippedCopyIsUnedited } = await import(
      "./default-assets.server"
    );
    const skill = readFileSync(path.join(assetsDir, "controller-guide.skill.md"), "utf8");
    expect(skill).toContain("Pass the roster you designed as `agents` to `create_project`");
    expect(skill).toContain("The one removal you hold is `remove_agent_deployment`");
    expect(skill).not.toMatch(/[–—]/);
    const rel = path.join("skills", "controller-guide", "SKILL.md");
    const outgoing = "df3a250cbd5fbbaccdd7843199a1d9e23e836250119db2f87a7693e57b6a17d8";
    expect(shippedCopyIsUnedited(rel, outgoing, {})).toBe(true);
    expect(PRIOR_SHIPPED_HASHES[rel]).not.toContain(sha256Hex(skill));
  });
});

/**
 * Ruling 134 (pass 34, F34-11): the shipped operator doctrine says that
 * rework on an open PR is delivered with `deliver_for_review`, and that
 * pushing is never a person's or an agent's job. The outgoing sha256 is
 * listed so an unedited store copy upgrades at boot.
 *
 * Canary: revert the persona sentence (or drop the outgoing hash) and the
 * matching assertion fails.
 */
describe("the operator doctrine upgrade in place (ruling 134)", () => {
  const assetsDir = path.join(import.meta.dirname, "assets");
  it("carries the rework-delivery sentence and lists its outgoing version", async () => {
    const { PRIOR_SHIPPED_HASHES } = await import("./default-assets.server");
    const definition = readFileSync(path.join(assetsDir, "operator.definition.md"), "utf8");
    expect(definition).toContain("shows `pr.unpushedRevision`, call `deliver_for_review`");
    expect(definition).toContain("Pushing is never a person's job and never an agent's.");
    expect(definition).not.toMatch(/[–—]/);
    const rel = path.join("agents", "definitions", "operator.md");
    expect(PRIOR_SHIPPED_HASHES[rel]).toContain(
      "9462381afd6c87b991f5653610252ac2e7a4815b039709d818bbecec1db7532e",
    );
    expect(PRIOR_SHIPPED_HASHES[rel]).not.toContain(sha256Hex(definition));
  });
});

/**
 * Ruling 437 (F39-60): the operator's app skill told it to resolve any packet
 * that had become moot. `resolve_packet` refuses every packet the operator did
 * not raise, and operators planned it on agents' questions twice in half an
 * hour. The skill now draws the same line as the snapshot and the refusal.
 *
 * CANARY: restore "If a packet becomes moot because its input arrived another
 * way, resolve it." with no qualification.
 */
describe("ruling 437: the app skill says whose packets the operator may resolve", () => {
  const skill = readFileSync(
    path.join(import.meta.dirname, "assets/viberr-app-expertise.skill.md"),
    "utf8",
  );
  it("scopes the moot-packet rule to the operator's own packets and names `packet.yours`", () => {
    expect(skill).toContain("If a packet you raised becomes moot");
    expect(skill).toContain("`packet.yours: false` in `get_task`");
    expect(skill).not.toMatch(/If a packet becomes moot because/);
  });
});

/**
 * The seeded-prompt sweep (2026-09-23; `docs/validation/2026-09-23-doc-sweep.md`,
 * "Seeded agent prompts"). Ten sentences in the shipped prompts said things the
 * code at HEAD does not do, and every run that mounts them read them as fact:
 * the Developer "opens the review pull request" while its own run prompt
 * forbids `git push` and PRs; the Reviewer "raises typed quality flags" with no
 * such tool; the operator's playbook read an absent grant as "do not attempt"
 * while four capabilities resolve an absent grant to a default; the controller
 * created "only the first link's task" of a goal that ruling 398 fans out; and
 * the operator was told that "advancing a single `auto` boundary and stopping is
 * correct", which ruling 152(a) made a paid extra turn per stage.
 *
 * Each rewritten asset's outgoing version is a recorded prior hash, so an
 * unedited store copy upgrades at boot.
 *
 * CANARY: restore any retired sentence below, or drop an outgoing hash.
 */
describe("the seeded-prompt sweep: the shipped prompts say what the code does", () => {
  const assetsDir = path.join(import.meta.dirname, "assets");
  const read = (file: string): string => readFileSync(path.join(assetsDir, file), "utf8");

  function seededStore(): string {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-prompt-sweep-"));
    roots.push(dataRoot);
    return dataRoot;
  }

  it("the Developer commits and reports; Viberr pushes and opens the PR; the deliverer runs at every stage", () => {
    const definition = read("developer.definition.md");
    const skill = read("developer-expertise.skill.md");
    expect(definition).not.toContain("You open the review pull request");
    expect(definition).toContain(
      "Viberr pushes your branch and opens the review pull request when the operator delivers",
    );
    expect(skill).not.toContain("Open the review PR");
    expect(skill).not.toContain("the review PR is open");
    // Ruling 133: an engaged deliverer runs at EVERY stage.
    expect(skill).not.toContain("You do your work at the implementation stage");
    expect(skill).toContain("you run at EVERY stage");
    // The run prompt prefixes a commit with the task key, never a literal `[TASK]`.
    expect(skill).not.toContain("[TASK]");
    expect(skill).toContain("prefixed with the task key in brackets");
  });

  it("the Reviewer records its verdict through the outcome channel, writes no tests, and keeps raw output in the run logs", () => {
    const definition = read("reviewer.definition.md");
    const skill = read("reviewer-expertise.skill.md");
    expect(definition).not.toContain("typed quality flags");
    // The verdict is the envelope's; the prose classifier is only a fallback.
    expect(skill).not.toContain("the operator parses it");
    for (const text of [definition, skill]) expect(text).toContain("`report_outcome`");
    // No repo-write grant: it cannot author the suite.
    expect(skill).not.toMatch(/you author and run the validation suite/i);
    expect(skill).not.toContain("authors/runs");
    expect(skill).toContain("the seeded Reviewer holds no repo-write grant");
    // Evidence rows are short citations.
    expect(skill).not.toMatch(/raw \w+ output in evidence/);
    // The `desc` the operator selects agents by said the same three things.
    const reviewer = SEED_AGENT_PROFILES.find((p) => p.frontmatter.id === "reviewer");
    expect(reviewer?.description).not.toContain("typed quality flags");
    expect(reviewer?.description).not.toContain("authors");
    expect(reviewer?.description).not.toMatch(/raw validation output in evidence/);
  });

  it("the operator's playbook reads an absent grant the way the gates do, and promises read_board only where it is mounted", () => {
    const skill = read("viberr-app-expertise.skill.md");
    expect(skill).not.toContain("`human`, `off`, or missing");
    // `absentPolarityGate`'s four.
    for (const id of ["dispatch-agents", "use-web-search-fetch", "deliver-review-pr", "update-task-branch"]) {
      expect(skill).toContain(`\`${id}\``);
    }
    expect(skill).toContain("Missing from `operatorPolicy`: withheld, except four capabilities");
    // `read_board` is built only beside another Viberr tool, on either backend:
    // on Codex through Viberr's gateway (ruling 589).
    expect(skill).toContain("An agent that holds any other Viberr tool, on Claude or on");
    expect(skill).not.toContain("an agent on Codex gets no board read");
  });

  it("ruling 503: the controller's doctrine, guide and handbook say an epic holds nothing back and order is each task's own wait", async () => {
    // Ruling 398 taught these three that a chain started every link whose
    // wait was met. Ruling 503 retired the chains: an epic is a group, and
    // the one ordering is `blockedBy`. Canaries: bring back a chain sentence,
    // a goal-chain tool, or the handbook's goals bullet.
    const { seedDefaultAgentAssets } = await import("./default-assets.server");
    const dataRoot = seededStore();
    seedDefaultAgentAssets(dataRoot);
    const definition = read("controller.definition.md");
    const skill = read("controller-guide.skill.md");
    const handbook = readFileSync(
      path.join(dataRoot, "kb", "controller-handbook", "handbook.md"),
      "utf8",
    );
    expect(definition).not.toContain("You create only the first link's task up front");
    expect(skill).not.toContain("the first link's task is created immediately and later links wait");
    expect(handbook).not.toContain("as the previous link completes");
    expect(handbook).not.toContain("Goals decompose one outcome into links");
    for (const text of [definition, skill]) {
      expect(text).not.toContain("born held");
      expect(text).toContain("ruling 503");
      expect(text).toMatch(/an epic starts, orders and holds nothing/i);
      expect(text).toContain("`blockedBy`");
      expect(text).toContain("`create_epic`");
      expect(text).toContain("`update_epic`");
      for (const retired of ["`get_goal`", "`list_goals`", "`create_goal`", "`update_goal`", "`link 2`"]) {
        expect(text).not.toContain(retired);
      }
    }
    expect(handbook).toContain("An epic holds nothing back");
    expect(handbook).toContain("ruling 503");
  });

  /**
   * Ruling 530: a board may deliver results, not only software. Asked for a
   * board that turns an inventory into a calculator.aws estimate, the
   * controller followed the guide's toolchain and gate bullets and planned a
   * TypeScript estimate pipeline in the repository (aws-cost-calculator CALC-2
   * and CALC-4), when the owner wanted the board's agents to make the estimate.
   */
  it("ruling 530: the controller's doctrine, guide and handbook settle what a board delivers and build a results board out of the board itself", async () => {
    // CANARY: drop the doctrine's paragraph, the guide's first bring-up bullet
    // or its results section, or put the gate bullets back on every board, and
    // the controller plans software for a person who asked for results.
    const { seedDefaultAgentAssets } = await import("./default-assets.server");
    const dataRoot = seededStore();
    seedDefaultAgentAssets(dataRoot);
    const definition = read("controller.definition.md");
    const guide = read("controller-guide.skill.md");
    const handbook = readFileSync(
      path.join(dataRoot, "kb", "controller-handbook", "handbook.md"),
      "utf8",
    );
    expect(definition).toContain("settle what its board delivers (ruling 530)");
    expect(definition).toContain(
      "never plan an application, a pipeline or a toolchain to do what the agents would do on each task",
    );
    // Asked to "set up a project for our supplier invoice processing", a
    // controller told only to ask "when the words fit both" built a results
    // board without asking; words that only name the work fit both.
    expect(definition).toContain("words that only name the work");
    const bringUp = markdownSection(guide, "Bringing up a new project");
    const settle = bringUp.indexOf("**Settle what the board delivers before you design it** (ruling 530)");
    expect(settle, "the bring-up section opens by settling what the board delivers").toBeGreaterThan(-1);
    expect(settle).toBeLessThan(bringUp.indexOf("**For a software board, read the GitHub connections"));
    expect(bringUp).toContain("Words that only name the work");
    expect(bringUp).toContain("**On a software board, verify the toolchain before you promise a gate.**");
    expect(bringUp).toContain("**On a software board, declare the project's gates");
    const results = markdownSection(guide, "A board that delivers results");
    expect(results).toContain("the done signal is the required reviewer's approval of those files");
    expect(results).toContain("**Plan no software to do the agents' work.**");
    expect(handbook).not.toContain("Viberr manages AI software delivery");
    expect(handbook).toContain("A board delivers software");
  });

  /**
   * Rulings 667 and 668 (owner, 2026-10-06): "now this is a no-code development
   * board. So let's just make the github connection for this board type
   * optional", and the operator summarizes a task's result before it asks for
   * Done. The guide said "Every project still needs a repository", so the
   * controller asked for one on a board whose agents commit nothing: the AWS
   * calculator board's repository held 92 branches with no commit on them.
   */
  it("rulings 667 and 668: the shipped prompts know a board with no repository and the result a completion packet becomes, and their outgoing hashes are recorded", async () => {
    // CANARY: restore the guide's "still needs a repository" sentence, drop
    // the `delivers` bullet or the doctrine's sentence, drop the operator's
    // no-repository clause or its notes, or drop an outgoing hash.
    const { PRIOR_SHIPPED_HASHES, seedDefaultAgentAssets, shippedCopyIsUnedited } = await import(
      "./default-assets.server"
    );
    const dataRoot = seededStore();
    seedDefaultAgentAssets(dataRoot);
    const definition = read("controller.definition.md");
    const guide = read("controller-guide.skill.md");
    const operator = read("operator.definition.md");
    const handbook = readFileSync(path.join(dataRoot, "kb", "controller-handbook", "handbook.md"), "utf8");

    expect(definition).toContain("Say which one when you create the project (`delivers`, ruling 667).");
    expect(definition).toContain("never ask the person for a repository it will not use");
    const bringUp = markdownSection(guide, "Bringing up a new project");
    const say = bringUp.indexOf("**Say what the board delivers when you create it** (ruling 667)");
    expect(say, "the bring-up section says how a results board is created").toBeGreaterThan(-1);
    expect(say).toBeLessThan(bringUp.indexOf("**For a software board, read the GitHub connections"));
    const results = markdownSection(guide, "A board that delivers results");
    expect(guide).not.toContain("still needs a repository");
    expect(results).toContain("The\n  board needs no repository (ruling 667)");
    expect(results).toContain("**The result is summarized before it is accepted** (ruling 668).");
    expect(handbook).toContain("a board that delivers results needs none (ruling 667)");
    expect(operator).toContain("or that the project has no repository at all (ruling 667)");
    expect(operator).toContain("what stays on the task as its result once they do");
    for (const field of ["`considerations`", "`assumptions`", "`gaps`", "`completionPacket.resultFileCandidates`"]) {
      expect(operator, field).toContain(field);
    }

    const outgoing: [string, string, string][] = [
      [path.join("agents", "definitions", "controller.md"), "db6f4b2c06bd93b69a1aa140b0dfc008da77ffba7e23044e4802de594ff7f914", definition],
      [path.join("skills", "controller-guide", "SKILL.md"), "dd2f98c43aee05e60cfa84f9b078ae55ffbfcf84aac2e6080bc9daf08b2668b8", guide],
      [path.join("agents", "definitions", "operator.md"), "82224a585c7ba2ce6470e7da28ef41828164fe5bcb2a72b0b297a2827df020d8", operator],
      [path.join("kb", "controller-handbook", "handbook.md"), "864b8434eebe1577e1420d218e6136298c4d8ff9c2fe2fae2f9509a31662cf95", handbook],
    ];
    for (const [rel, hash, shipped] of outgoing) {
      expect(shippedCopyIsUnedited(rel, hash, {}), `${rel}'s outgoing hash is not recorded`).toBe(true);
      expect(PRIOR_SHIPPED_HASHES[rel], rel).not.toContain(sha256Hex(shipped));
    }
  });

  it("ruling 672: the shipped prompts know a board can start with no repository, how its operator asks for one, and how a board is switched to pull requests", async () => {
    // CANARY: drop the operator's `ask_for_repository` sentence or the tool
    // from its skill, the doctrine's or the guide's "can start without", the
    // guide's switching section, a grant id it names or its step that starts
    // the operators that waited, or an outgoing hash.
    const { PRIOR_SHIPPED_HASHES, seedDefaultAgentAssets, shippedCopyIsUnedited } = await import(
      "./default-assets.server"
    );
    const dataRoot = seededStore();
    seedDefaultAgentAssets(dataRoot);
    const definition = read("controller.definition.md");
    const guide = read("controller-guide.skill.md");
    const operator = read("operator.definition.md");
    const skill = read("viberr-app-expertise.skill.md");
    const handbook = readFileSync(path.join(dataRoot, "kb", "controller-handbook", "handbook.md"), "utf8");

    expect(operator).toContain("call `ask_for_repository` with the reason and stop (ruling 672)");
    expect(operator).toContain("while it stands the question is not yours to ask again");
    // The doctrine is the same text for every operator, so it says when the
    // tool is absent instead of telling an operator without it to call it.
    expect(operator).toContain(
      "The tool is in your toolkit only while the question is yours to ask. It is absent once a person decided the board keeps none",
    );
    expect(operator).toContain("and when opening decision packets is not granted to you. Without it, deliver what can be delivered as files");
    expect(skill).toContain("- `ask_for_repository` asks a person to connect a repository to a board that has none (ruling 672)");
    expect(definition).toContain("A board that builds software can start without one too (ruling 672)");
    expect(handbook).toContain("which it may connect later (ruling 672)");
    expect(markdownSection(guide, "Bringing up a new project")).toContain(
      "**A software board can start without its repository** (ruling 672).",
    );
    const switching = markdownSection(guide, "Switching a board to pull requests");
    expect(switching).toContain("`connect_project_repository` (`delivers: true`)");
    expect(switching).toContain("`no-repository-<project>.md`");
    // The four grants a board without a repository withholds, by the ids
    // `update_agent_deployment` takes.
    for (const id of ["execute-code-or-write-repo", "create-task-branch", "commit-push-branch", "open-review-pr"]) {
      expect(switching, id).toContain(`\`${id}\``);
    }
    // The operators that waited are the controller's to start: nothing else
    // does before ruling 330's sweep, fifteen minutes on.
    expect(switching).toContain("**Start the operators that waited.**");
    expect(switching).toContain("start each with `run_agent_on_task`");
    // A project admin's turn is refused a knowledge-base edit, so the guide
    // says what the controller does then.
    expect(switching).toContain("you name the passages for an org admin to change");

    const outgoing: [string, string, string][] = [
      [path.join("agents", "definitions", "controller.md"), "e69d11e6bc8cf0f4d49b4716e2450d5030968978222e057ff0cb1aceb86559cb", definition],
      [path.join("skills", "controller-guide", "SKILL.md"), "7dcc5f4f84cd603a5614931b99c860d79f1456f75c7c12fec186d44cd608a46f", guide],
      [path.join("agents", "definitions", "operator.md"), "5bdfa3077e700e497b231676e45c41e6005c91a5cb1b689eee7b614f21aaadf8", operator],
      [path.join("skills", "viberr-app-expertise", "SKILL.md"), "3b3e4bb97fb8650b7964288219708e54879d83b756875bce13fea009bdaa2b3b", skill],
      [path.join("kb", "controller-handbook", "handbook.md"), "627b7bdd1cf2eeedc3ece72bd1d713918054e5243059a18d312d7d6d8335b746", handbook],
    ];
    for (const [rel, hash, shipped] of outgoing) {
      expect(shippedCopyIsUnedited(rel, hash, {}), `${rel}'s outgoing hash is not recorded`).toBe(true);
      expect(PRIOR_SHIPPED_HASHES[rel], rel).not.toContain(sha256Hex(shipped));
    }
  });

  /**
   * Rulings 677 to 679: asked to make a delivered report a board's template,
   * the controller left it on the task that made it, and the skills it wrote
   * had outgrown what a run is given without a save ever saying so.
   */
  it("rulings 677 to 679: the guide keeps a board's template in a knowledge base, a skill within what a run is given, and names the reader of one correction", async () => {
    // CANARY: drop the guide's template bullet or the tool it names, its
    // sentence on a skill's size, `read_kb_correction`, or the outgoing hash.
    const { PRIOR_SHIPPED_HASHES, shippedCopyIsUnedited } = await import("./default-assets.server");
    const { SKILL_INJECTION_BUDGET } = await import("~/server/files/skill-body.server");
    const guide = read("controller-guide.skill.md");
    const results = markdownSection(guide, "A board that delivers results");
    expect(results).toContain("**A file the result must follow lives in a knowledge base, not on a task** (ruling 678).");
    expect(results).toContain("rulings knowledge base with `copy_task_file_to_knowledge_base`");
    expect(results).toContain("an archived task hands nothing over");
    expect(results).toContain("Carry the step into the\n  skill of the agent that makes the result and of the reviewer that checks it");
    // The number is the budget's own, so a change to one is a change to both.
    expect(results).toContain(
      `gets at most ${SKILL_INJECTION_BUDGET.toLocaleString("en-US")} characters of them, and \`save_skill\` says when\n  one is past that (ruling 679)`,
    );
    expect(markdownSection(guide, "Keeping a project's rulings current")).toContain("(`read_kb_correction` reads one\n  whole)");
    const rel = path.join("skills", "controller-guide", "SKILL.md");
    expect(
      shippedCopyIsUnedited(rel, "a79f832fe1ac95d577e0a8a6915126558a5ff5516347fb87c16afacb03cb70fd", {}),
      "the guide's outgoing hash is not recorded",
    ).toBe(true);
    expect(PRIOR_SHIPPED_HASHES[rel]).not.toContain(sha256Hex(guide));
  });

  it("a GitHub read needs membership, not maintainer", () => {
    const skill = read("controller-guide.skill.md");
    expect(skill).not.toContain("reading GitHub state at depth need maintainer");
    expect(skill).toContain("so does every GitHub read");
  });

  it("ruling 152(a): the shipped operator definition and the system prompt around it both walk auto boundaries in one turn", async () => {
    // The whole prompt a real operator gets: the STORE's definition (seeded)
    // plus the non-negotiable rules appended after it. Both said the opposite.
    const { seedDefaultAgentAssets } = await import("./default-assets.server");
    const { buildOperatorSystemPrompt } = await import("~/server/runtimes/operator-prompt.server");
    const dataRoot = seededStore();
    seedDefaultAgentAssets(dataRoot);
    const { prompt } = buildOperatorSystemPrompt(
      {
        policy: new Map<string, CapabilityMode>([["transition-to-done", "human"]]),
        autonomy: "supervised",
        backend: "claude",
        model: "sonnet",
        effort: "",
        name: "Operator",
        skills: [],
        kb: [],
        mcps: [],
        persona: null,
        deployed: true,
        humanGatedBeforeWork: false,
      },
      dataRoot,
    );
    // The store copy was read, not the baked fallback.
    expect(prompt).toContain("triage quality gate");
    expect(prompt).not.toContain("advancing a single `auto` boundary");
    expect(prompt).not.toContain("Every transition re-invokes you");
    expect(prompt.match(/consecutive `auto` boundaries are walked in one turn/gi)).toHaveLength(2);
  });

  it("every rewritten asset's outgoing version is a recorded prior hash, and the shipped version is not", async () => {
    const { PRIOR_SHIPPED_HASHES, seedDefaultAgentAssets, shippedCopyIsUnedited } = await import(
      "./default-assets.server"
    );
    // Two versions where PR #321 ("Instance settings") shipped in between.
    const outgoing = {
      [path.join("agents", "definitions", "controller.md")]: [
        "d7387a588a1c5425648c030293a893e6dee648bac2576231ab9386e083da1fb0",
        "589e93e91662e060ee303ba78802f582d541275de328a8bc237926578c983f54",
      ],
      [path.join("skills", "controller-guide", "SKILL.md")]: [
        "6bb9b30dcae4b9c6f6504899ab476c63c00f76b417535c113f355a1165d5195a",
        "7ef616ce31f8f0821caa59e8a0532813bb24b4782e4ae103a1cacfd9dc3bd63f",
      ],
      [path.join("agents", "definitions", "operator.md")]: [
        "96d88b2c779416d83501463cf8c3023f77d05504938bd3d578eb680edea2c778",
      ],
      [path.join("skills", "viberr-app-expertise", "SKILL.md")]: [
        "2eaebf8040fe4a8047dc7f78f39482549b15cafeeb2ad18d127264a15113ecc8",
      ],
      [path.join("skills", "developer-expertise", "SKILL.md")]: [
        "d22b14d8171f832b7f67e79b4899f1e84c97e6d093ed022efd970ed9b0c30cb0",
      ],
      [path.join("skills", "reviewer-expertise", "SKILL.md")]: [
        "eb2e5ebd17f890a65377d8ce016ddc6e105d92a260d7ee4f9d1ef0262be18774",
      ],
      [path.join("kb", "controller-handbook", "handbook.md")]: [
        "a3072990165c8cd4a67d3227d032825bdcb9f33ab82ab7752edf0d6afee9d08b",
        "3237777fc90a1082f0e01b72f843ec6b68d70639628a55403ed7d2b5f61baa27",
      ],
      [path.join("agents", "profiles", "developer.md")]: [
        "bf84fe28d0f2d21172f415f4c49ceb2aaf10bc824d14bc01d82e391d90bbde19",
      ],
      [path.join("agents", "profiles", "reviewer.md")]: [
        "cbb114a5d3e41103ddf201f40f7e549739de05c659f40ed9b87b3c35372f3055",
      ],
    } satisfies Record<string, readonly string[]>;
    // Ruling 503: the versions that still spoke of goal chains.
    const beforeEpics = {
      [path.join("agents", "definitions", "controller.md")]: [
        "70e659083faffa3b93564e77c5f9d0034bb5e60b1393b0cf84e415227ee0ace7",
      ],
      [path.join("skills", "controller-guide", "SKILL.md")]: [
        "b260db092146f736deaee68c5d328bf581e442c9368204c2725fcf466e7aee51",
      ],
      [path.join("agents", "definitions", "operator.md")]: [
        "919af42febe8d3a50cdae2fdc52c873a5d63c435e5ed73ed53068e2dc4248f67",
      ],
      [path.join("skills", "viberr-app-expertise", "SKILL.md")]: [
        "c267649f85bac274e0be3299f01ad59f0758d9ff43285054af8a7f630a3cc2f6",
      ],
      [path.join("kb", "controller-handbook", "handbook.md")]: [
        "2568ef5c92b776804b9beb20d40686071e04ea790fa78c9faef70e4708c9cdd5",
      ],
      [path.join("agents", "profiles", "controller.md")]: [
        "8d89f1bedb4a339b7541961051b69647539c092bd72bb0ceb6e265162e233e55",
      ],
    } satisfies Record<string, readonly string[]>;
    // Ruling 518: the operator's template while it still had a role ("Task
    // coordinator") and a "System role" scope line.
    const beforeOneOperator = {
      [path.join("agents", "profiles", "operator.md")]: [
        "557b495c6f42f3d0e0516ee33230dfbd5c6c4554dee0d4a3aa4db303c4ba6786",
      ],
    } satisfies Record<string, readonly string[]>;
    // Ruling 530: the controller's versions that planned every board as software.
    const beforeResultsBoards = {
      [path.join("agents", "definitions", "controller.md")]: [
        "a92a8bbfbdbdd69429784ea8ab1a6738987cb490e053ab1d968a4d66514cd21c",
      ],
      [path.join("skills", "controller-guide", "SKILL.md")]: [
        "a7accbb828fcaec17870ef180e4367f3238d3f25bae0e74d2ddcb4220dda6fed",
      ],
      [path.join("kb", "controller-handbook", "handbook.md")]: [
        "4977e270597f5dc9e70b54824c5e1d26246a1af4310bb94c6d590f877b6b0dd5",
      ],
    } satisfies Record<string, readonly string[]>;
    const dataRoot = seededStore();
    seedDefaultAgentAssets(dataRoot);
    // What this build ships, as the store's own manifest recorded it: that
    // covers the two templates and the handbook, which have no asset file.
    const shipped = manifestSchema.parse(
      JSON.parse(readFileSync(path.join(dataRoot, "state", "shipped-assets.json"), "utf8")),
    );
    for (const [rel, hashes] of [
      ...Object.entries(outgoing),
      ...Object.entries(beforeEpics),
      ...Object.entries(beforeOneOperator),
      ...Object.entries(beforeResultsBoards),
    ]) {
      expect(shipped[rel], rel).toBeDefined();
      for (const hash of hashes) {
        expect(shippedCopyIsUnedited(rel, hash, {}), rel).toBe(true);
        expect(shipped[rel], `${rel} still ships its outgoing version`).not.toBe(hash);
      }
      expect(PRIOR_SHIPPED_HASHES[rel], rel).not.toContain(shipped[rel]);
    }
  });
});
