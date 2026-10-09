import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { sha256Hex } from "~/server/files/content-hash.server";
import { getBuildInfo } from "~/server/ops/build-info.server";
/**
 * The shipped default agent assets, read from `assets/` at runtime.
 *
 * These files are the shipped-by-default SOURCE OF TRUTH (tracked in git;
 * `data/` is generated and gitignored). Editing them updates what ships; the
 * boot step writes them into the store's `skills/` + `agents/definitions/` on
 * first run.
 *
 * They used to be pulled in with Vite's `?raw`, which bundles them into the
 * server build — but that loader only exists under Vite. The moment
 * `seed.server.ts` began emitting the shipped personas (P13-AP-03) this module
 * joined the import graph of `tsx scripts/seed.ts`, and the DOCUMENTED INSTALL
 * STEP `npm run seed` died with `ERR_UNKNOWN_FILE_EXTENSION ".md"`. Vitest and
 * the Vite build both handled `?raw`, so typecheck, 1663 unit tests and the
 * build were all green while a fresh install was broken — the e2e job was the
 * only gate that ran a real CLI entrypoint.
 *
 * Reading from disk works under every runtime (Vite SSR output, tsx, node,
 * vitest). Resolution tries the module's own directory first (correct from
 * source), then `<cwd>/app/server/seed/assets` (correct for the container,
 * whose Dockerfile copies `app/` next to the build output), and finally fails
 * LOUDLY rather than shipping an agent with an empty persona.
 */
const ASSET_DIR_CANDIDATES = [
  path.join(import.meta.dirname, "assets"),
  path.resolve(process.cwd(), "app/server/seed/assets"),
];

function readAsset(file: string): string {
  for (const dir of ASSET_DIR_CANDIDATES) {
    const abs = path.join(dir, file);
    if (existsSync(abs)) return readFileSync(abs, "utf8");
  }
  throw new Error(
    `Viberr default asset ${file} was not found. Looked in: ${ASSET_DIR_CANDIDATES.join(", ")}. ` +
      "These files ship with the app under app/server/seed/assets/.",
  );
}

const viberrSkillMd = readAsset("viberr-app-expertise.skill.md");
const developerSkillMd = readAsset("developer-expertise.skill.md");
const reviewerSkillMd = readAsset("reviewer-expertise.skill.md");
const writerSkillMd = readAsset("writer-expertise.skill.md");
const editorSkillMd = readAsset("editor-expertise.skill.md");
const diagrammerSkillMd = readAsset("diagrammer-expertise.skill.md");
const coverDesignerSkillMd = readAsset("cover-designer-expertise.skill.md");
const operatorDefinitionMd = readAsset("operator.definition.md");
const developerDefinitionMd = readAsset("developer.definition.md");
const reviewerDefinitionMd = readAsset("reviewer.definition.md");
const writerDefinitionMd = readAsset("writer.definition.md");
const editorDefinitionMd = readAsset("editor.definition.md");
const diagrammerDefinitionMd = readAsset("diagrammer.definition.md");
const coverDesignerDefinitionMd = readAsset("cover-designer.definition.md");
const operatorProfileMd = readAsset("operator.profile.md");
const controllerSkillMd = readAsset("controller-guide.skill.md");
const controllerDefinitionMd = readAsset("controller.definition.md");
const controllerProfileMd = readAsset("controller.profile.md");
import { getDataRoot } from "~/server/files/file-store-root.server";
import { serializeAgentProfile } from "~/server/files/agent-profile-file.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { logger } from "~/server/logging/logger.server";
import {
  LIBRARY_AGENT_PROFILES,
  SEED_AGENT_PROFILES,
  type SeedAgentProfile,
} from "./agent-catalog.server";
import { toError } from "~/shared/errors";

// F10-30: the built-in specialist PERSONA is the profile's own markdown body —
// ONE authoring source. Previously the rich persona shipped as a SEPARATE
// `agents/definitions/<id>.md` that overrode the profile body at run time, so a
// built-in profile behaved differently from an equivalent custom one and editing
// the profile body had no effect. We now fold each specialist's persona into its
// profile-template body; the definition-file precedence is removed
// (specialist-prompt.server.ts). Only the operator keeps a dedicated definition
// (it is a system profile with its own persona path).
const SPECIALIST_PERSONA_BY_ID = new Map<string, string>([
  ["developer", splitFrontmatter(developerDefinitionMd).body.trim()],
  ["reviewer", splitFrontmatter(reviewerDefinitionMd).body.trim()],
  ["writer", splitFrontmatter(writerDefinitionMd).body.trim()],
  ["editor", splitFrontmatter(editorDefinitionMd).body.trim()],
  ["diagrammer", splitFrontmatter(diagrammerDefinitionMd).body.trim()],
  ["cover-designer", splitFrontmatter(coverDesignerDefinitionMd).body.trim()],
]);

/**
 * Ships Viberr's DEFAULT agent assets — the operator PLUS the base specialists
 * (Developer, Reviewer) — into the live store: each agent's expertise
 * skill, its detailed definition (persona), and its profile template. Writes
 * each into `${VIBERR_DATA_ROOT}` the first time a store lacks it, so the agent
 * runtimes can load them from the store (file-native, so a user can then edit
 * them), and refreshes a copy that is still byte-identical to an older shipped
 * version. An edited file is never clobbered.
 *
 * Every agent run has a baked-in fallback persona, so a store without these
 * assets still works; this makes the richer, editable, skill-backed versions
 * available so the built-in agents are usable across every board.
 */

/** The base specialist profile ids shipped into every store (built-in agents). */
const DEFAULT_SPECIALIST_IDS: ReadonlySet<string> = new Set(["developer", "reviewer"]);

/**
 * Every specialist template this app ships: the base roster's two, then the
 * library's (ruling 692). The boot backfill below writes these; `npm run seed`
 * writes the same two catalogs whole (the operator's template with them), and
 * `seed.server.test.ts` holds its count, so neither ships a specialist the
 * other does not.
 */
function shippedSpecialistProfiles(): SeedAgentProfile[] {
  return [
    ...SEED_AGENT_PROFILES.filter((p) => DEFAULT_SPECIALIST_IDS.has(p.frontmatter.id)),
    ...LIBRARY_AGENT_PROFILES,
  ];
}

/** Static prose assets bundled from `assets/` (skills + definitions + operator
 *  profile template). */
/** The controller's own knowledge base (ruling 99): what THIS instance is and
 *  how its pieces fit, told to the controller model. Admins edit it freely in
 *  the KB browser; an edited copy is never clobbered (same manifest contract
 *  as every shipped asset). */
const CONTROLLER_HANDBOOK_MD = `# Controller handbook

## What this instance is

Viberr manages the work AI agents do. Projects are boards of tasks; each task is a
markdown file that carries its own state, timeline, decisions and evidence. Agents
do the execution work; humans keep flow, review and acceptance. Every active task
has its own operator agent that coordinates specialists through the workflow.
A board delivers software, where each task changes the project's repository and
ships as a pull request, or results, where each task is one piece of a person's
work and the result comes back on that task (ruling 530).

## The pieces you manage

- Users hold an org role (admin or member) and, per project, a project role
  (admin, maintainer, contributor, viewer). Org admins pass project gates
  through an audited override.
- Projects carry stages, workflow boundaries (auto, approval, human), members,
  deployed agents and, on a board that delivers software, a GitHub repository,
  which it may connect later (ruling 672);
  a board that delivers results needs none (ruling 667). The move into the
  final stage is always a human decision.
- Knowledge bases, skills and MCP connections are org resources granted to
  agent profiles. Deleting and renaming them is done by admins in Instance
  settings → Agent resources.
- Epics group the tasks of one outcome inside a project, like a Jira epic or a
  Linear project (ruling 503). Tasks join and leave one at a time, and an
  epic's progress is counted from its tasks. An epic holds nothing back: order
  is what each task waits on (\`blockedBy\`), and Viberr releases a task when
  every task it names is done.

## House rules for you

- The asking person's own permissions are the ceiling; the server enforces them
  on every tool call, and a refusal is the correct answer to relay.
- Ground every claim in a tool read from the same turn.
- Never fabricate progress: task stages, run states and an epic's progress
  come from reads, not from optimism.
`;


const STATIC_ASSETS: { rel: string; content: string }[] = [
  // Skills — one operating manual per agent role.
  { rel: path.join("skills", "viberr-app-expertise", "SKILL.md"), content: viberrSkillMd },
  { rel: path.join("skills", "developer-expertise", "SKILL.md"), content: developerSkillMd },
  { rel: path.join("skills", "reviewer-expertise", "SKILL.md"), content: reviewerSkillMd },
  // Ruling 692: the Writer's and the Editor's manuals, for a board whose result
  // is prose a person puts their name to.
  { rel: path.join("skills", "writer-expertise", "SKILL.md"), content: writerSkillMd },
  { rel: path.join("skills", "editor-expertise", "SKILL.md"), content: editorSkillMd },
  // Ruling 699: the Diagrammer's and the Cover Designer's manuals, for a board
  // whose result carries pictures somebody has to draw.
  { rel: path.join("skills", "diagrammer-expertise", "SKILL.md"), content: diagrammerSkillMd },
  { rel: path.join("skills", "cover-designer-expertise", "SKILL.md"), content: coverDesignerSkillMd },
  { rel: path.join("skills", "controller-guide", "SKILL.md"), content: controllerSkillMd },
  // Definitions — the OPERATOR and the CONTROLLER keep dedicated definition
  // files (system profiles). Specialist personas live in their profile-template
  // BODY (F10-30), so developer/reviewer definition files are no longer seeded.
  { rel: path.join("agents", "definitions", "operator.md"), content: operatorDefinitionMd },
  { rel: path.join("agents", "definitions", "controller.md"), content: controllerDefinitionMd },
  // The operator PROFILE template — so an operator deployment resolves (kind,
  // backends, capabilities) in a store that was never demo-seeded, which is what
  // makes the operator preinstalled everywhere.
  { rel: path.join("agents", "profiles", "operator.md"), content: operatorProfileMd },
  // Ruling 99: the CONTROLLER — one per instance, ships through the boot
  // backfill alone (never via SEED_AGENT_PROFILES: that array feeds project
  // deployments, and the controller is not deployable). Its own KB ships as a
  // static doc below, so the profile's kb grant never dangles in a bare store.
  { rel: path.join("agents", "profiles", "controller.md"), content: controllerProfileMd },
  {
    rel: path.join("kb", "controller-handbook", "handbook.md"),
    content: CONTROLLER_HANDBOOK_MD,
  },
];


// ------------------------------------------- shipped-version refresh (B-OP1)

/**
 * Where the store records the SHA-256 of the asset bytes this app last shipped
 * into it, per store-relative path. It is the app's own bookkeeping, not user
 * content, so it lives beside the other machine state.
 */
const SHIPPED_MANIFEST_REL = path.join("state", "shipped-assets.json");

/**
 * Hashes of asset versions this app shipped BEFORE the manifest existed —
 * generated from the git history of `assets/` (`git log --follow` per file,
 * hashing each blob). A store whose copy still hashes to one of these was
 * written by an older Viberr and never touched by a human, so refreshing it is
 * safe; anything else is treated as user-owned and left alone.
 *
 * When you edit a shipped asset, APPEND the outgoing version's hash here so
 * stores seeded before the manifest keep converging. Stores seeded from the
 * manifest onward need no maintenance — they carry their own record. A hash we
 * cannot recognize only ever fails SAFE: the store copy is preserved.
 */
interface PriorShippedHashes {
  /** Store-relative asset path → every hash this app has ever shipped for it. */
  readonly [assetRel: string]: readonly string[];
}

const PRIOR_SHIPPED_HASHES: PriorShippedHashes = {
  [path.join("agents", "definitions", "controller.md")]: [
    // Ruling 672 (owner, 2026-10-06): before the doctrine said a board that
    // builds software can start with no repository, and named the guide's
    // section on switching a board to pull requests.
    "e69d11e6bc8cf0f4d49b4716e2450d5030968978222e057ff0cb1aceb86559cb",
    // Ruling 667 (owner, 2026-10-06): before the doctrine said to state what
    // the board delivers at creation and that a results board needs no
    // repository. Every project took one, and the AWS calculator board kept a
    // repository it never committed to.
    "db6f4b2c06bd93b69a1aa140b0dfc008da77ffba7e23044e4802de594ff7f914",
    // Ruling 530 (owner, 2026-09-27): before the doctrine said to settle what
    // a board delivers, software or results, and never to plan an application
    // to do what a results board's agents do on each task. Asked for a board
    // that makes AWS estimates, the controller planned a TypeScript estimate
    // pipeline in the repository (aws-cost-calculator CALC-2 and CALC-4).
    "a92a8bbfbdbdd69429784ea8ab1a6738987cb490e053ab1d968a4d66514cd21c",
    // Ruling 503 (owner, 2026-09-26): before goal chains became epics. The
    // doctrine named `get_goal`, goal links as waits and a chained-goals
    // paragraph (links started by the server, the Goals panel).
    "70e659083faffa3b93564e77c5f9d0034bb5e60b1393b0cf84e415227ee0ace7",
    // Pass 34 A14: before the blockedBy sentences (ruling 131).
    "e600925f824e5ec43ca962c56304e5099ae76a1ad41dff8bc94a431666756712",
    // ruling 121 outgoing: named the non-existent `list_projects`, claimed a
    // comment mention could start a run, and knew nothing of the per-turn
    // context read or `update_task`.
    "8dcb2d1bb8f3668bcc9337af2d07be196ed704b66d70b699b2ac55e39ebf258c",
    // Seeded-prompt sweep (2026-09-23): before the goal paragraph learned
    // ruling 398. It said only the first link's task is created up front and
    // each next one when the previous link completes, and that a waiting
    // link's task is born held; every link whose wait is satisfied starts.
    "d7387a588a1c5425648c030293a893e6dee648bac2576231ab9386e083da1fb0",
    // The same text after PR #321 renamed "Org settings" to "Instance
    // settings", which shipped without recording its outgoing hash.
    "589e93e91662e060ee303ba78802f582d541275de328a8bc237926578c983f54",
    // Owner, 2026-09-25 ("this wall of text"): before the reply paragraph set
    // an order (what the person must decide first), bold line labels, links
    // in place of restated evidence and a length of about eight lines.
    "86f1e309de8bdb5393156fc6f12bc93a035597c43ae74c02b6b6f2c94c1b488b",
  ],
  [path.join("skills", "controller-guide", "SKILL.md")]: [
    // Ruling 692's note of 2026-10-09: before the guide said to deploy the
    // Editor at high effort, with what a review took at each.
    "a9ff90ee8fc6a085586d661a8d56cccdb5e52f489027afd4f0db9d71db5bd3e7",
    // Ruling 699's third note of 2026-10-08: before the guide said to deploy
    // the two drawing agents at high effort, with what each effort took.
    "56c5a3ff8a12958bdd1b0307b5eb3f9ad9b9d31fb273dba734dc7b915a6acf53",
    // Ruling 699 (2026-10-08): before "A board that delivers results" said a
    // result that carries pictures starts from the shipped Diagrammer and
    // Cover Designer, each at the stage where its step happens.
    "e51e4710c9719b8bae32484e443a0c8be92e5fe6298e03dd53bc78eb26abb208",
    // Rulings 690 to 692 (owner, 2026-10-07, on a board asked to write blog
    // posts): before "A board that delivers results" said a person is asked
    // only what they alone know, that a board whose result is prose starts
    // from the shipped Writer and Editor, that the account's name is not the
    // author's, and that a result keeps its sources and a page is pictured.
    // The controller wrote a writer and an editor from nothing and named the
    // signed-in account as the author.
    "f7adbea417510f20ea5c6e52aeea0fe47df4248beafe8f65d26d59b38d02a53d",
    // Rulings 684 and 685 (owner, 2026-10-07: "why would controller make the
    // template with data?"): before the guide said a template is made from an
    // example and is never the example, that a flow names no task, and that
    // the controller continues on a task's acceptance. It told the controller
    // to copy the report a person liked into the knowledge base as it stood.
    "e0635450d0c8c60a1a1086a3eb1d46a4ef5df8c64ecb80730daf857d13f03ca9",
    // Rulings 677 to 679 (2026-10-07): before "A board that delivers results"
    // said a file the result must follow is copied into a knowledge base with
    // `copy_task_file_to_knowledge_base` and that a skill stays within what a
    // run is given, and before the rulings section named `read_kb_correction`.
    // Asked to make a delivered report a board's template, the controller left
    // it on the task that made it.
    "a79f832fe1ac95d577e0a8a6915126558a5ff5516347fb87c16afacb03cb70fd",
    // Ruling 672 (owner, 2026-10-06): before "Bringing up a new project" said
    // a software board can start without its repository, and before
    // "Switching a board to pull requests" existed.
    "7dcc5f4f84cd603a5614931b99c860d79f1456f75c7c12fec186d44cd608a46f",
    // Rulings 667 and 668 (owner, 2026-10-06): before "Bringing up a new
    // project" said a results board is created with no repository, and "A
    // board that delivers results" said the operator summarizes the result
    // before it is accepted. It said every project still needs a repository.
    "dd2f98c43aee05e60cfa84f9b078ae55ffbfcf84aac2e6080bc9daf08b2668b8",
    // Ruling 637 (2026-10-03): before "Keeping a project's rulings current"
    // named `edit_knowledge_base_doc` for amending a passage and for the edit
    // after an undo refuses. It named `save_knowledge_base`, whose only ways to
    // change part of a document were a whole replace or a rebuild by appends.
    "5e48eafda1f249b350a641060d2d56117b16e2ed3b130d07240e3a55151342b4",
    // Ruling 530 (owner, 2026-09-27): before "Bringing up a new project"
    // opened by settling what the board delivers, scoped its toolchain and
    // gate bullets to a software board, and "A board that delivers results"
    // said how the board itself becomes the workflow. Those two bullets were
    // CALC-2's plan: a repository foundation whose measured commands "can be
    // declared as the project's gates".
    "a7accbb828fcaec17870ef180e4367f3238d3f25bae0e74d2ddcb4220dda6fed",
    // Ruling 503 (owner, 2026-09-26): before "Chained goals" became "Epics"
    // and the done-signal rule's last sentence named a read TASK in the
    // delivery task's epic instead of a read link.
    "b260db092146f736deaee68c5d328bf581e442c9368204c2725fcf466e7aee51",
    // Ruling 498 (owner, 2026-09-26): before "Keeping a project's rulings
    // current" said agents' corrections are written straight into the document
    // and named `undo_kb_correction` and `kbCorrections`, with proposals only
    // as the ones documents still hold, and before the gates line stopped
    // saying to promote a proposal. The owner: "proposal spam is exhausting".
    "a8e1cd90673ab1b2eccf08aeeff10f1e7f8ae181a4dc0c82518b08303dd5ba85",
    // Ruling 492 (pass 40, F40-69): before "Creating a task" and "Chained
    // goals" said a done signal is something the task can show before
    // acceptance, and that a proof only the merged or deployed code can show
    // is a follow-up read task. The controller wrote goal-1 links 9 and 11 on
    // akinozer-com with such a proof as their done signal.
    "ce538f0db704167a768cdab3848110ad5c46ff7843919330927bf59efda22a57",
    // Rulings 482 and 483 (pass 40, F40-52, F40-59): before "Bringing up a new
    // project" named `set_project_gates` and the rulings paragraph stopped
    // listing "the gate commands" as prose to write there (every directive
    // re-typed them and agents reported their exit codes, the claim a person
    // could not check), and before "Keeping a project's rulings current" named
    // `resolve_kb_proposal`, the open proposals in its turn context and
    // `get_project`, and the Promote and Dismiss buttons that ask it (two WEB-1
    // proposals sat unpromoted while the next packet asked the owner to act on
    // a "not binding" setting).
    "7418f3499b14e1c8ce8a0cc46d6efdec850370712f1ec56728c1130302fcb948",
    // Ruling 464 (pass 40, F40-7): before "Bringing up a new project" said to
    // pass the designed roster as `agents`, and before "No deletes" named
    // `remove_agent_deployment`. The controller deployed its six specialists
    // beside the generic Developer and Reviewer and could not take them off.
    "df3a250cbd5fbbaccdd7843199a1d9e23e836250119db2f87a7693e57b6a17d8",
    // Ruling 463 (pass 40, F40-6): before "Bringing up a new project" said to
    // read `list_github_connections` first. The controller could not see the
    // connection its own `create_project` needs and wrote that it could not.
    "26672ee429c9089c9c676bc178b5afaf401927f90596c6cb2f36660da185c762",
    // Ruling 462 (pass 40, F40-5): before "Bringing up a new project" said the
    // repository need not exist first and named `createRepository`. The
    // controller had no way to make one, so the owner made it by hand.
    "f58275ca76e09a6d149e8fa3b7e8bec73cd9a7f34627e642ced603fdb1dcfd91",
    // Seeded-prompt sweep (2026-09-23): before the goal section learned
    // ruling 398 (same sentences as the definition), and before the gate line
    // stopped saying GitHub reads need maintainer (they need membership).
    "6bb9b30dcae4b9c6f6504899ab476c63c00f76b417535c113f355a1165d5195a",
    // The same text after PR #321's "Instance settings" rename.
    "7ef616ce31f8f0821caa59e8a0532813bb24b4782e4ae103a1cacfd9dc3bd63f",
    // Pass 38 F38-5: before the dispatch sentence stopped telling the controller to
    // "push a task forward" with an @operator comment, a route ruling 252 made
    // start nothing (four controller comments on the shopify board followed it).
    "67be04268e1b187ee87c6333bb85fa64cb3c0b6ec2a45cc90fe9f6bba5850005",
    // Pass 34 A14: before the blockedBy sentence (ruling 131).
    "69805ce6bb7bd0180014e164ae6d863268813bd4fb6a0f61bfa4e333b6674608",
    // ruling 121 outgoing (same rewrite).
    "a2defe42d6fb6a5eed063a1e7b9bb9b5636c1619c1f5ea0f6e56838b9628fecd",
  ],
  [path.join("agents", "definitions", "operator.md")]: [
    // Rulings 690, 691 and 693 (2026-10-07): before the completion-packet
    // paragraph said that what the task took is printed beside the packet,
    // that a task keeps the sources its result rests on, and that Viberr
    // pictures each result file that is a page.
    "256e070e5a130fa506fd889646088420f522410dbd806f01e9fc0941128cc7c5",
    // Ruling 672 (owner, 2026-10-06): before the doctrine said what to do
    // when a task on a board with no repository needs one: ask once with
    // `ask_for_repository`, and never again once a person decided to keep none.
    "5bdfa3077e700e497b231676e45c41e6005c91a5cb1b689eee7b614f21aaadf8",
    // Rulings 667 and 668 (owner, 2026-10-06): before the doctrine knew a
    // project with no repository, and before the completion packet said what
    // to weigh, what was assumed and what is missing, named the result's files
    // on a task delivered as files, and stayed on the accepted task as its
    // result.
    "82224a585c7ba2ce6470e7da28ef41828164fe5bcb2a72b0b297a2827df020d8",
    // Ruling 531 (owner, 2026-09-28): before the triage gate said when a task
    // whose deliverable is a result is concrete, and the delivery paragraph
    // said such a task is delivered on the task, never in a pull request. The
    // aws-cost-calculator CALC-4 pilot estimate went out as PR #4.
    "e3abc19158dc27db39cd9efd29b3a2cceb1a0cf78eaf852b46738e783b159b89",
    // Ruling 521 (owner, 2026-09-27): before every acceptance offer carried
    // the completion packet (`write_completion_packet`).
    "c966e35ad36af27b8d5f60595da3e0a980495912af5ddca5db6c68d59493df71",
    // Ruling 503 (owner, 2026-09-26): before goal links left `set_dependencies`
    // and the done-signal paragraph read the task's `epic` instead of
    // `goalChain`.
    "919af42febe8d3a50cdae2fdc52c873a5d63c435e5ed73ed53068e2dc4248f67",
    // Ruling 494's review: the doctrine as ruling 494 first shipped it, with
    // its `baseBehindBy` sentences between `update_branch_from_base`'s own
    // sentences and the "Never call it" that pointed back to the tool, so
    // "it" read as the packet or the count. The sentence now names the tool.
    "43a9a0b59ee0c6d6e58cbc5c6807467005b5b343f7e5f7909d622a944d23d5e4",
    // Ruling 494 (pass 40, F40-70): before the doctrine said a behind count is
    // true only of the head it was counted on (`baseComparedHead`), to check
    // it against the head just pushed and never to state one in a packet for
    // another head. Live on WEB-16 two packets told the owner the branch was 6
    // commits behind `main` five minutes after a push that carried `main`.
    // Ruling 492 (pass 40, F40-69): before the doctrine said a done signal is
    // something the task can show before acceptance, and that a proof only
    // the merged or deployed code can show is raised as a `create_task`
    // option for a read task that waits on this one. Live on WEB-16 the
    // operator's own option drafted a goal done only "after the merge".
    "ee212fda34ef04e0447ed1edd1a2f50b6c1cd92cde5ac498956cea61dbcfb6d8",
    // Ruling 557 (AWSC-4 to AWSC-7, 2026-09-28): before the doctrine named
    // `take_from_task`, the way a task takes a file another task made. Live,
    // four benchmark tasks asked the owner to attach their inputs by hand.
    "e3929b89b637f3318a6178dfe06ad0f8f7570a60a5d5f9096a3b1e9eee22b4ab",
    // Ruling 488 (pass 40, F40-67): before the doctrine said text meant for
    // another task is posted there with `relay_to_task` (an agent's with its
    // `relay` entries), and never handed to a person to copy over or confirm.
    // Live on WEB-9 the acceptance packet asked the owner to confirm two
    // attachments had been pasted onto WEB-8 by hand.
    "474502b29f913396ec86de5f2fd8088d7a0a221a12342e5972ea815cc8d1fa0c",
    // Ruling 487 (pass 40, F40-65): before a wait on a clock was scheduled
    // with `schedule_task_action` and a hold a pending schedule explains
    // needed no packet. "Never leave a pre-work or `auto` stage with nothing
    // done and no packet" sent every hold to one, and live on WEB-9 the
    // operator asked the owner to route a 12:25Z run through the controller
    // and opened a packet only to record the wait.
    "0386467b19815de69f8a814134081b78813e2d99414c7ab45b563da84bf26786",
    // Ruling 475 (pass 40, F40-20): before a conflict went to the delivering
    // agent. The doctrine said "A CONFLICT is not yours to settle" and a
    // blocking packet went to a person, who could only confirm the packet's
    // own recommendation to have the deliverer resolve it.
    "5199e8721937aec65fe858818ec587beaf75a39985a3ab82c280993aeb8bc862",
    // Ruling 468 (pass 40, F40-12): before the doctrine said an empty
    // repository is Viberr's to initialize. Nothing told the operator so, and
    // live on WEB-1 it opened a packet asking the owner to push a README.
    "1763e3889a2da992052bebd5accbe51854baea010bc80d7e8d7aa96266715c13",
    // Seeded-prompt sweep (2026-09-23): before "advancing a single `auto`
    // boundary and stopping is correct" gave way to ruling 152(a): the
    // operator's own transition starts no new turn, so it walks consecutive
    // `auto` boundaries in one.
    "96d88b2c779416d83501463cf8c3023f77d05504938bd3d578eb680edea2c778",
    // Pass 37 F37-56: before the pronoun sentence. Agents had written "asking
    // him to choose" and "Her words" about the SAME owner in one project, which
    // is the record inventing a fact about a real person two incompatible ways.
    "b5f35eeffb19ffc7b3f3f484c78f4b18efe7c10e813d100483950b721d24eada",
    // Pass 37 ruling 232: before the operator was told that a directive handed
    // to a specialist reaches only that specialist, so a person named inside
    // one notifies nobody. Until then it read "the mention is what notifies
    // them" with no qualification, which the ruling made false for directives.
    "a48b34dbaffc37bb7c1839fd8e7119f5554e5f28d423cd5df9759bd55452c7d8",
    // Pass 35 cluster review: before the ruling-85 clause stopped telling the
    // operator to OFFER the profile grant as an option the ruling-164 door
    // refuses, and before the acceptance-stage move was keyed on the pull
    // request rather than on `notAcceptableReason`.
    "0a65da9c91b81dee99de6cc9e5b641cf59850e5c14e9feed9fb3c243b5210608",
    // Pass 35 S18: before the option-title-is-a-promise paragraph (ruling 164).
    "da74b11b369961a7b99065589cfb7cab3eb3c33ee8901311fd6e3c76e233a47a",
    // Pass 35 S15: before the acceptance-time refresh and the
    // `notAcceptableReason` sentences (rulings 162 and 163).
    "2e05f1546999a3a5924b90565d8ccfdeff9182cb6f3e573f589199028161327a",
    // Pass 34 A19: before the ruling-133 rework paragraph.
    "dd42d1a7614df74f937519f53a0e9690affa0e0eb8a89da07d38cac4fc580752",
    // Pass 34 A13: before the set_dependencies sentence (ruling 131).
    "9731f0a69b6a8b5824277c4d1a2d4ad18cc126c2ca827a844369f9f0ed9ef3f6",
    // pass-34 outgoing (ruling 134: rework reaches the open PR through
    // `deliver_for_review`; pushing is never a person's or an agent's job).
    "9462381afd6c87b991f5653610252ac2e7a4815b039709d818bbecec1db7532e",
    "c316e4838955513f00d16b69c972bce8c9dfb3b7c355d8c71a2afa99af76d862",
    // outgoing before the rework-routing guidance (reworkStages)
    "6c67b50034ccc80b28563c8415722d5efb9b8da2f854d6339461036f1a46e71d",
    "03a4f8b7a1c2ed9e7414654e5086288e6dcc187b48f9bd16b1ef141b3eca4f34",
    "128c0e733d181ce93c6b3c15c71e890fc629c592f39b08d03a44b6b77afd0d1c",
    "197eaf0b400f61d690d0ec32198fafbd120fa518ef27f00e13b4b427f8bf5856",
    "2693d1381b637cac935db3b2d95f9fd8f6e4a1eb6228ea3d331e8a890e8e7a32",
    // pass-21 outgoing (F21-21 / F21-14 / F21-16 rewrite of the workspace,
    // acceptance and policy-scope paragraphs).
    "34a6ce3e9601f96ae5f49b403f4eca0cb5d6e356005b6780d8b1ce63a2c9b87d",
    "429216ebbe1d9b413608c34dd83e04794351915d1b9e2cc535f3e97b64c95a1b",
    "5340ad240553d280336600b1f3341931158a8b0926e487ace802d5e00bfa71ae",
    "70501e7100afef430d79e8d63497326b8e6504258a4743002217c920867cf96f",
    "71cff546b99aeb53b340c3ae2b4c6359c7f7c4cb3d5e9126b96b6f2ff3ab3e57",
    "849d977503fe2a3b04776379b4017d40e50d95ed394770f28ef825e8513085d6",
    "94f27a1217287b14e8f7e83283dbf96b0e30ea6d5952dd705d4d1061b9bcfc3c",
    "9aac2f1a1617cc40aa38da67837c1db4698be80ed45585609078a1041a6bb411",
    "a6a8db269d6eb547e220cbef22c03b00ddcfc48b70a0c31562f48adcdf4f19c7",
    "d0475c39c69c6055ce5bf86e2fb0fd98c1488b473919f8dd205a125f83b55f46",
    "da9cf46677bd3987796585ec45c683d48e1885ad723b190cd612693fffe6ac6f",
    "ef9e653a6bd7e19fa78a34a0dfdc48c26cbc0cdba8c83493ad9789642cb289b4",
    // pass-21 outgoing (humanizer sweep: em/en dashes rewritten as plain
    // sentences; instructions unchanged).
    "9380e0473a0b8a0e2edb5b8175fb5457c595d0a91955b9d3333e09ec50323525",
    // pass-24 outgoing (B-3): the default-branch guidance no longer names a
    // Claude-only tool or claims "you have no shell" — it defers to the
    // per-backend anchored read the workspace section now describes.
    "51a2ebfd35bf4b2c49428732357514b364e2dc55a46fb0afc707517023de03ae",
    // pass-25 outgoing (F25-3): the "your working directory holds task.md AND a
    // read-only checkout" line was Claude-accurate but false for the Codex
    // operator (its writable cwd is the isolated .operator-scratch since B-1);
    // it now defers to the per-backend workspace section for exact paths.
    "7e42028407b0f59873086d97229d60e5e9237f39cb1b7dc480675c8a78d1b82c",
  ],
  // Ruling 503 (owner, 2026-09-26): the controller profile's first recorded
  // version, whose description said it "defines and advances chained goals".
  [path.join("agents", "profiles", "controller.md")]: [
    "8d89f1bedb4a339b7541961051b69647539c092bd72bb0ceb6e265162e233e55",
  ],
  [path.join("agents", "profiles", "operator.md")]: [
    "339ad23dd69f63e57bf52d110b263a2da4ae683bdbf5b020039eaf075115dec4",
    "36120600048af6ca9c1d54b8d7354a960364073e4f744be76dbffb218440891a",
    "95077f7f75564d1d53fb8dca1e03ad1612594edf4107a31e7eb5eeffb055ac46",
    "cc78f1ebfe2088ba67176ce7d05a129fdc1606cfc35a7b4ad508d7447c77d611",
    "f2e7ad4f9164b6cccf22c43b6705b64c61136180866908b29ff2881687a40d71",
    "ffd61e7721ce8550571d22692bab521b4c60bafa1c3d81b536ba0ce1c58ee07c",
    // dynamic-dispatch outgoing (2026-08-29): the assign/summon capability
    // pair, replaced by `dispatch-agents`.
    "d3c186ee40962eff069c577e026843e4ce3c97fed269b99384e5bdad2fd9e108",
    // Ruling 518 (owner, 2026-09-27): before the operator lost its role
    // ("Task coordinator") and its "System role" scope line.
    "557b495c6f42f3d0e0516ee33230dfbd5c6c4554dee0d4a3aa4db303c4ba6786",
  ],
  [path.join("skills", "viberr-app-expertise", "SKILL.md")]: [
    // Ruling 672 (owner, 2026-10-06): before the tool list named
    // `ask_for_repository`.
    "3b3e4bb97fb8650b7964288219708e54879d83b756875bce13fea009bdaa2b3b",
    // Ruling 619 (AWSC-75, 2026-10-01): before a rework that passes a later
    // stage carried an earlier stage's fix through that stage's own file.
    "c58c22c5e04de01ae5ccd0114869c560e1a16376a4be2420b6ce5cb618dfa3d4",
    // Ruling 594 (AWSC-33, 2026-09-29): before agents could open another
    // task's files with `read_task_attachment`.
    "2b0c3e15b00fa87b91ce46eea3f2835e9e9142a47bf6d8d5a7ead34d875efd4d",
    // Ruling 589 (AWSC-24, 2026-09-29): before a Codex agent read the board
    // and a timeline entry through Viberr's gateway, and before the skill said
    // `read_board` returns each standing verdict's report (ruling 569).
    "1189f5a7ef226e5c7fc7514b5b6f7052b3b4ac313bee6350f585422bb081b80a",
    // Ruling 588 (AWSC-29, 2026-09-29): before it said only a Codex run
    // without Viberr's gateway has no correction tool (ruling 585).
    "ed747472c439b25857d173e7ab845b8d6e2044237d431b9628fd0b6dce39de49",
    // Ruling 584 (owner, 2026-09-29): before `edit_comment`, when a comment's
    // words were a project admin's to remove (ruling 582).
    "cd431119ac1f2379c1703aee285044854605dffc6213100085209da34409fb34",
    // Ruling 581 (AWSC-18, 2026-09-29): before `correct_knowledge_doc` said
    // an empty `text` deletes the passage.
    "c993e8f18bffedc4a48244624aac745a3dad502c4a9e49ac1f125620a59ca786",
    // Ruling 557 (AWSC-4 to AWSC-7, 2026-09-28): before the Tools list named
    // `take_from_task`.
    "2292c6376abda42e210cc73af4f8cf8b9ecbc12e32272c24b79e4af34278710a",
    // Ruling 503 (owner, 2026-09-26): before the `goalChain` bullet became the
    // task's `epic` and the Tools list named `set_epic`.
    "c267649f85bac274e0be3299f01ad59f0758d9ff43285054af8a7f630a3cc2f6",
    // Ruling 498 (owner, 2026-09-26): before `propose_kb_correction` became
    // `correct_knowledge_doc`, which writes the correction into the document
    // (the exact passage it replaces, the text in its place) instead of filing
    // a proposal a person had to promote.
    "195516db43c82959b5d0ec94806e15de0a1b90fd68f02525c95e43d7effdae2d",
    // Ruling 488 (pass 40, F40-67): before the Tools list named
    // `relay_to_task`, the way text moves between tasks of a project.
    "a0e0896423dc9a9344d814181c90346c65a6068f84b7512d4820d6994cbf3bc7",
    // Ruling 483 (pass 40, F40-53): before `propose_ruling` became
    // `propose_kb_correction`, which reaches any knowledge base a run on the
    // task was given and relays a correction an agent proved. Live on WEB-3 the
    // operator answered "I'm not changing them myself" while the dossier and
    // runbook kept sending agents to stale lines.
    "20acdfcb363f22622c38a48ca0f5963a5a09399aa76f87cccace59c15a2c2509",
    // Pass 35 S15: before the acceptance-stage clause on update_branch_from_base.
    "92e91052fbe1e5f3bd9898e450172de9ea87b125d52e330536b0e1d5ff2cd9ff",
    "2350a2f50e425868056d9866d885b70078b183e9934b925f1469ea0e7cc5f989",
    "4b92cd7cb4b0c050faca518f76cb3328119d26c5f76c8b12367c2fd053f5fa26",
    "73d05eb921a0763f0f3f2312e90fdc367dbe820d740008f884fb17c7c619b40e",
    "766312af226010792d1f34583e252de853e336d8ceb801b303d7e0c84efd5a6a",
    "809d3b3bc666c1cd8c0e64d6d5a5a1d68037d040854d925a429e3b19a022776d",
    "aba6b1e161806c63097a88e88d5c48c0cc47613afa3616500111f6ffda298294",
    "c7343d37eb460545861218a9b312d25f8e3884423e92da1329c2169c0acde227",
    "e64e110e43b851b7e8809973a7f060d95e35b4e723648749f1b57bf4528ea07a",
    // pass-21 outgoing (humanizer sweep).
    "0ad7af1782e6f525f11daa8b9e8533a555f34baeffc918ca91b51d0aadfcae4f",
    // dynamic-dispatch outgoing (2026-08-29): the engage/prompt/run tool trio,
    // replaced by the single `run_agent`.
    "877c65d247e8c1be0852191469bdcb78910e2897baa6130e11b74a3e4c6f3e93",
    // dispatch-hunt outgoing (2026-08-29): the Hand-off-truth line that claimed
    // the server delivers on entering Review (contradicting R15-2), and a Tools
    // list omitting deliver_for_review / update_branch_from_base.
    "11715eaceefcc11c7cc408e66eb037ab324b637c26ee5792e6824763887ec0b7",
    // Seeded-prompt sweep (2026-09-23): before a missing grant stopped reading
    // as "do not attempt" (four capabilities resolve an absent grant to a
    // default) and `read_board` stopped being promised to every agent (Claude
    // only, beside another Viberr tool).
    "2eaebf8040fe4a8047dc7f78f39482549b15cafeeb2ad18d127264a15113ecc8",
  ],
  [path.join("skills", "developer-expertise", "SKILL.md")]: [
    // Ruling 488 (pass 40, F40-67): before the reporting rules said what
    // belongs on another task goes in the outcome's `relay` entries, never in
    // an attachment or a report for a person to copy over.
    "6c22506cf4bb40c40011d2c0afefbdd7f59d0bd891a8ecdf3df0c1ec00a5392a",
    // Seeded-prompt sweep (2026-09-23): before the Developer stopped being told
    // to open the review PR (the server does, on `deliver_for_review`), to work
    // only at the implementation stage (ruling 133), and to prefix commits with
    // a literal `[TASK]`.
    "d22b14d8171f832b7f67e79b4899f1e84c97e6d093ed022efd970ed9b0c30cb0",
    "2cd21e2f0b11a3d35ca0188bf1d42af66f4149b5d7ad3bbb2162cdeb712d91fa",
    "9eed9c7c574b54491362374b8feff9760ab3401b48b60d077b889e60999ebe1f",
    // pass-21 outgoing (humanizer sweep).
    "d7c78f20730ef44a8e1d490cc2efbb2a1cf1cd1c5bb21a63bf8343df7ba1b17e",
  ],
  [path.join("skills", "writer-expertise", "SKILL.md")]: [
    // Ruling 706 (2026-10-09): before the manual said a record that grows
    // goes stale inside itself, and that the latest entry is what holds.
    "92789f682bfe7b9bc16780687ce552ad79b729a9af4a768be5ef36b63935004f",
    // Ruling 699's second note of 2026-10-08, after the first live post:
    // before the manual kept out of the writer's note what a later picture
    // makes untrue (a count of the whole file, "no pictures").
    "d6d81936257867a5e9989e6986262d8cbcc034a69b4f350c6f15eaaa21da6c11",
    // Ruling 699 (2026-10-08): before the manual left the diagrams and the
    // cover to a board's drawing agent where it has one.
    "8c133fa610e494f0497b114cf71f64f08d91c9d08e6974634f1f4129fb64e870",
    // Ruling 695 (2026-10-08): before the manual said a person's own words
    // are material and not quotations, and that the evidence stays out of
    // the narration.
    "7f3e87f2478e5c2b798d2b45884ff95f9e62f81f25faa5cefc92161bd1166244",
  ],
  [path.join("skills", "editor-expertise", "SKILL.md")]: [
    // Ruling 706 (2026-10-09): before the manual read a record that grows
    // beyond the entry cited, for a later one that changes what the piece says.
    "4db16badd8b3fccd4e2e0bcbe9a09709da677d53584de03baf77adb230a18709",
    // Ruling 699 (2026-10-08): before the manual had the Editor open every
    // picture and judge a diagram against the sources and a cover against
    // the piece.
    "62e62eed5108c4228e92c228d082d9815cb79c450d64b8d79f07beab7e30538a",
    // Ruling 695 (2026-10-08): before the cold read named a narrator who
    // cites their own records, and "I chose" on the strength of a record.
    "26b0210af906fd9b5495af1f5b343654422cee54986f86808e6285c3508cf253",
  ],
  [path.join("skills", "diagrammer-expertise", "SKILL.md")]: [
    // Ruling 699's note of 2026-10-08: before the manual judged how a diagram
    // reads from a half-size look at the drawing, and stopped the run reading
    // the writer's brief and proving by hash that the piece was unchanged.
    "e9fc50d6d8b5faec3d5cc42c1769c1294f754b1c646e8b4a7bbd2149f9041cb4",
    // Ruling 699's second note of 2026-10-08, after the first live post:
    // before the manual said what the agent does not prove (no hash, copy,
    // diff or second render) and that a file of fields is never pictured.
    "dee86c6136a016eeaf393b461996152fd62ee49ac879b9ad61a7ece73dbb3564",
  ],
  [path.join("skills", "cover-designer-expertise", "SKILL.md")]: [
    // Ruling 699's note of 2026-10-08: before the manual kept a first cover's
    // look at their earlier covers to the covers themselves.
    "2d5812d25c1d2a95b4dbc865c37fba3eec8c743bf4b0923fdcb51bf88940f5e0",
    // Ruling 699's second note of 2026-10-08, after the first live post:
    // before the manual said what the agent does not prove, and that a
    // change to a file beside the piece is an exact replacement.
    "943933d71103d9fc7665ba1ce87f887129cc87394d5171ecb09c81d857afbf78",
  ],
  [path.join("skills", "reviewer-expertise", "SKILL.md")]: [
    // Ruling 706 (2026-10-09): before the guardrails had a record that grows
    // searched for a later entry on what the work states.
    "6703e3624becd424684c32a912b403fddf5d71994023d706fdac6613d724def7",
    // Ruling 690 (2026-10-07): before the guardrails said to check a claim
    // against the source kept on the task, and that a claim with no kept
    // source is a finding.
    "68da19df9295f7c307fd16ce6d823a485494f9be6f5a92c5a3cc4b819997def3",
    "67b14be125a5f8b213a9ad3de6682c4762bdef703a40dc32ba1c907a267e1c31",
    "7aa79a7c54156f0556f437f525a31a5c12b2dd89a5465282974da61337bc041c",
    // outgoing before the evidence-rows-are-citations guidance
    "b2fdfb7f86bb294beabf836f59050d1d57eb429a9d787937783eb972b5a33c85",
    "c32401d03e628093ddaec888efdac35ad79e4ee3604502104fb5bf016adda025",
    // Seeded-prompt sweep (2026-09-23): before the verdict moved from a parsed
    // `Verdict:` line to the outcome channel, the Reviewer stopped authoring
    // the suite (no repo-write grant), and raw output left the evidence rows.
    "eb2e5ebd17f890a65377d8ce016ddc6e105d92a260d7ee4f9d1ef0262be18774",
    // Ruling 526: before an evidence row carried its result and a pass, fail
    // or info mark, which the timeline draws as the verdict's checklist.
    "0fea5d36f4a35643d4352cccfc35183018a76907bc9387c4c2b34bb9abbbb57a",
  ],
  // Seeded-prompt sweep (2026-09-23): the first recorded versions of three
  // assets the sweep rewrote. The handbook said each next goal task is created
  // as the previous link completes (ruling 398). The Developer and Reviewer
  // templates carry their persona as the body (F10-30), so their hashes moved
  // with `developer.definition.md` ("opens the review pull request") and
  // `reviewer.definition.md` ("typed quality flags") and the Reviewer's `desc`.
  [path.join("kb", "controller-handbook", "handbook.md")]: [
    "a3072990165c8cd4a67d3227d032825bdcb9f33ab82ab7752edf0d6afee9d08b",
    // PR #321's "Instance settings → Agent resources" version.
    "3237777fc90a1082f0e01b72f843ec6b68d70639628a55403ed7d2b5f61baa27",
    // Ruling 503 (owner, 2026-09-26): before "Goals decompose one outcome into
    // links" became the epics bullet.
    "2568ef5c92b776804b9beb20d40686071e04ea790fa78c9faef70e4708c9cdd5",
    // Ruling 530 (owner, 2026-09-27): before "Viberr manages AI software
    // delivery" gave way to a board that delivers software or results.
    "4977e270597f5dc9e70b54824c5e1d26246a1af4310bb94c6d590f877b6b0dd5",
    // Ruling 667 (owner, 2026-10-06): before "The pieces you manage" said a
    // board that delivers results needs no repository.
    "864b8434eebe1577e1420d218e6136298c4d8ff9c2fe2fae2f9509a31662cf95",
    // Ruling 672 (owner, 2026-10-06): before it said a board that delivers
    // software may connect its repository later.
    "627b7bdd1cf2eeedc3ece72bd1d713918054e5243059a18d312d7d6d8335b746",
  ],
  [path.join("agents", "profiles", "developer.md")]: [
    "bf84fe28d0f2d21172f415f4c49ceb2aaf10bc824d14bc01d82e391d90bbde19",
  ],
  [path.join("agents", "profiles", "reviewer.md")]: [
    "cbb114a5d3e41103ddf201f40f7e549739de05c659f40ed9b87b3c35372f3055",
  ],
};

/**
 * Whether a store's copy of a shipped asset is still EXACTLY something this app
 * wrote — the manifest's record of the last write, or a version shipped before
 * the manifest existed. Anything else belongs to a human and is never rewritten.
 */
export function shippedCopyIsUnedited(
  rel: string,
  onDiskHash: string,
  manifest: ShippedAssetManifest,
): boolean {
  if (manifest[rel] === onDiskHash) return true;
  return (PRIOR_SHIPPED_HASHES[rel] ?? []).includes(onDiskHash);
}

/** What this app last wrote into the store, per store-relative asset path. */
export interface ShippedAssetManifest {
  [assetRel: string]: string;
}

/**
 * The manifest file's contents. Tolerant PER ENTRY, exactly as the hand-rolled
 * decoder it replaces was: an entry whose value is not a hash string is dropped
 * (that asset is then simply unknown to the manifest and falls back to the
 * historical list), never the whole file. A non-object file fails the parse and
 * leaves an empty manifest.
 */
const shippedManifestSchema = z
  .record(z.string(), z.string().nullable().catch(null))
  .transform((entries) => {
    const manifest: ShippedAssetManifest = {};
    for (const [rel, hash] of Object.entries(entries)) {
      if (hash !== null) manifest[rel] = hash;
    }
    return manifest;
  });

/** The store's shipped-asset manifest; `{}` when absent or unreadable. */
function readShippedManifest(store: string): ShippedAssetManifest {
  try {
    const raw = readFileSync(path.join(store, SHIPPED_MANIFEST_REL), "utf8");
    const parsed = shippedManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function writeShippedManifest(store: string, manifest: ShippedAssetManifest): void {
  try {
    const dest = path.join(store, SHIPPED_MANIFEST_REL);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (error) {
    // Bookkeeping only — a store that cannot record it simply falls back to the
    // historical hash list on the next boot.
    logger.warn("failed writing the shipped-asset manifest", {
      err: toError(error),
    });
  }
}

/**
 * The canonical on-disk bytes for ONE built-in agent profile template.
 *
 * P13-AP-03: this is the SINGLE source both template writers use — the boot
 * backfill below AND `runSeed` (seed.server.ts). They used to disagree: seed
 * wrote the 2-sentence catalog blurb as the body while only the backfill wrote
 * the shipped persona, and the backfill skips files that already exist. On the
 * documented install order (`npm run seed` → `npm run dev`) the rich personas
 * in `assets/{developer,reviewer}.definition.md` therefore never reached disk
 * and every built-in agent ran on a blurb system prompt. Both writers now emit
 * identical bytes.
 *
 * `kbGrants` is the ONE deliberate difference between the two callers: the boot
 * backfill installs on-disk skills but no knowledge bases, so a KB grant there
 * would dangle in every non-seeded store as the "N of 0" ghost (2026-07-18
 * owner fix). `npm run seed` also runs `seedOrgResources`, which creates the
 * backing KBs, so it keeps them.
 */
export function builtinAgentProfileTemplate(
  profile: SeedAgentProfile,
  opts: { kbGrants?: boolean } = {},
): string {
  return serializeAgentProfile({
    // Non-mutating copy — SEED_AGENT_PROFILES is shared with the demo fixture.
    // The short scannable `desc` stays in frontmatter (what the operator picks
    // on); the BODY is the full persona (F10-30).
    frontmatter: {
      ...profile.frontmatter,
      desc: profile.frontmatter.desc || profile.description,
      resources: {
        ...profile.frontmatter.resources,
        kb: opts.kbGrants ? profile.frontmatter.resources.kb : [],
      },
    },
    description:
      SPECIALIST_PERSONA_BY_ID.get(profile.frontmatter.id) ?? profile.description,
  });
}

/**
 * The specialist profile templates, generated from the catalog so a deployment
 * resolves (kind, backends, capabilities, resources) in a store that was never
 * demo-seeded: the counterpart of the operator profile template that makes
 * Developer/Reviewer preinstalled everywhere, and what puts the Writer and the
 * Editor in every instance's library (ruling 692).
 */
function specialistProfileAssets(): { rel: string; content: string }[] {
  return shippedSpecialistProfiles().map((p) => ({
    rel: path.join("agents", "profiles", `${p.frontmatter.id}.md`),
    content: builtinAgentProfileTemplate(p),
  }));
}

/**
 * Write the default agent assets into the store: absent ones are created, and
 * an UNEDITED copy of an older shipped version is refreshed to the current one.
 * Never throws.
 *
 * B-OP1: "only writes when the destination is missing" meant a store seeded
 * before a doctrine rewrite ran the OLD doctrine forever — live, an operator
 * kept following a standard operating procedure whose tools (`assign_specialist`,
 * `prompt_specialist`) no longer exist, because `readOperatorDefinition` prefers
 * the store copy over the shipped asset. A store copy is refreshed only when its
 * hash still matches something this app shipped (the manifest it wrote, or a
 * historical version); anything a human edited is left exactly as it is — and
 * WARNED about (B7), so a store pinned to old doctrine is visible at boot
 * instead of being an invisible behaviour difference between two installs.
 *
 * Returns the store-relative paths of the copies it REFRESHED, for the audit
 * row boot writes once the database is open (`recordShippedAssetRefresh`).
 */
export function seedDefaultAgentAssets(dataRoot?: string): string[] {
  const store = getDataRoot(dataRoot);
  const assets = [...STATIC_ASSETS, ...specialistProfileAssets()];
  const manifest = readShippedManifest(store);
  const refreshed: string[] = [];
  let manifestChanged = false;
  const record = (rel: string, hash: string): void => {
    if (manifest[rel] === hash) return;
    manifest[rel] = hash;
    manifestChanged = true;
  };
  for (const asset of assets) {
    try {
      const dest = path.join(store, asset.rel);
      const shippedHash = sha256Hex(asset.content);
      if (existsSync(dest)) {
        const onDiskHash = sha256Hex(readFileSync(dest, "utf8"));
        if (onDiskHash === shippedHash) {
          // Already current — adopt it into the manifest so a store that
          // predates the manifest is refreshable from the NEXT rewrite on.
          record(asset.rel, shippedHash);
          continue;
        }
        // A human owns an edited file — never clobber it. But say so: B7 found
        // the live `./data` store pinned to an operator.md that hashes to no
        // version this app ever shipped (hand-edited, or from an unmerged
        // branch) and still names the deleted `prompt_specialist` /
        // `assign_specialist` tools. The fail-safe was working exactly as
        // designed; what was missing is that NOTHING told anyone their operator
        // was running doctrine 15 releases old. The refresh path already logs,
        // so the divergent path staying silent read as "nothing to do here".
        if (!shippedCopyIsUnedited(asset.rel, onDiskHash, manifest)) {
          logger.warn(
            "shipped agent asset diverged; keeping the store's copy, which may be stale",
            {
              asset: asset.rel,
              onDisk: onDiskHash.slice(0, 12),
              shipped: shippedHash.slice(0, 12),
              path: dest,
              hint:
                "This copy matches no version Viberr shipped, so it is treated as " +
                "yours and never overwritten. Delete it to adopt the shipped one.",
            },
          );
          continue;
        }
        writeFileSync(dest, asset.content, "utf8");
        record(asset.rel, shippedHash);
        refreshed.push(asset.rel);
        logger.info("refreshed an unedited shipped agent asset", {
          asset: asset.rel,
          was: onDiskHash.slice(0, 12),
          now: shippedHash.slice(0, 12),
        });
        continue;
      }
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, asset.content, "utf8");
      record(asset.rel, shippedHash);
      logger.info("seeded default agent asset", { asset: asset.rel });
    } catch (error) {
      logger.error("failed seeding default agent asset", {
        asset: asset.rel,
        err: toError(error),
      });
    }
  }
  if (manifestChanged) writeShippedManifest(store, manifest);
  return refreshed;
}

const SHIPPED_ASSETS_REFRESHED_ACTION = "org.shipped_assets.refreshed";

/**
 * Ruling 681(f): the record of an upgrade's refresh.
 *
 * A refresh replaces a skill, a definition or a profile template that agents
 * read, and left only a line in the boot log: an admin asking why the
 * operator's playbook changed had no row to find. One row per boot that
 * refreshed anything names the build and each file it replaced. It is the
 * instance's row and is on no board's Activity (the owner, 2026-10-07): an
 * unedited shipped file is part of the product, as the prompts in code are,
 * and an upgrade is not a decision anyone on a board made. A boot that
 * refreshed nothing writes nothing.
 */
export function recordShippedAssetRefresh(db: DatabaseSync, refreshed: readonly string[]): void {
  if (refreshed.length === 0) return;
  const build = getBuildInfo();
  recordAudit(db, {
    action: SHIPPED_ASSETS_REFRESHED_ACTION,
    actor: SYSTEM_ACTOR,
    details: { assets: [...refreshed], version: build.version, revision: build.revision },
  });
}
