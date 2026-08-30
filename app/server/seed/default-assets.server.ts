import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
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
const operatorDefinitionMd = readAsset("operator.definition.md");
const developerDefinitionMd = readAsset("developer.definition.md");
const reviewerDefinitionMd = readAsset("reviewer.definition.md");
const operatorProfileMd = readAsset("operator.profile.md");
const controllerSkillMd = readAsset("controller-guide.skill.md");
const controllerDefinitionMd = readAsset("controller.definition.md");
const controllerProfileMd = readAsset("controller.profile.md");
import { getDataRoot } from "~/server/files/file-store-root.server";
import { serializeAgentProfile } from "~/server/files/agent-profile-file.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { logger } from "~/server/logging/logger.server";
import {
  SEED_AGENT_PROFILES,
  type SeedAgentProfile,
} from "./agent-catalog.server";

// F10-30: the built-in specialist PERSONA is the profile's own markdown body —
// ONE authoring source. Previously the rich persona shipped as a SEPARATE
// `agents/definitions/<id>.md` that overrode the profile body at run time, so a
// built-in profile behaved differently from an equivalent custom one and editing
// the profile body had no effect. We now fold each specialist's persona into its
// profile-template body; the definition-file precedence is removed
// (specialist-run.server.ts). Only the operator keeps a dedicated definition
// (it is a system profile with its own persona path).
const SPECIALIST_PERSONA_BY_ID = new Map<string, string>([
  ["developer", splitFrontmatter(developerDefinitionMd).body.trim()],
  ["reviewer", splitFrontmatter(reviewerDefinitionMd).body.trim()],
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

/** Static prose assets bundled from `assets/` (skills + definitions + operator
 *  profile template). */
/** The controller's own knowledge base (ruling 99): what THIS instance is and
 *  how its pieces fit, told to the controller model. Admins edit it freely in
 *  the KB browser; an edited copy is never clobbered (same manifest contract
 *  as every shipped asset). */
const CONTROLLER_HANDBOOK_MD = `# Controller handbook

## What this instance is

Viberr manages AI software delivery. Projects are boards of tasks; each task is a
markdown file that carries its own state, timeline, decisions and evidence. Agents
do the execution work; humans keep flow, review and acceptance. Every active task
has its own operator agent that coordinates specialists through the workflow.

## The pieces you manage

- Users hold an org role (admin or member) and, per project, a project role
  (admin, maintainer, contributor, viewer). Org admins pass project gates
  through an audited override.
- Projects carry stages, workflow boundaries (auto, approval, human), members,
  deployed agents and a GitHub repository. The move into the final stage is
  always a human decision.
- Knowledge bases, skills and MCP connections are org resources granted to
  agent profiles. Deleting and renaming them is done by admins in Org settings.
- Goal chains decompose one outcome into an ordered chain of tasks; the server
  creates each next task as the previous link completes.

## House rules for you

- The asking person's own permissions are the ceiling; the server enforces them
  on every tool call, and a refusal is the correct answer to relay.
- Ground every claim in a tool read from the same turn.
- Never fabricate progress: task stages, run states and chain links come from
  reads, not from optimism.
`;


const STATIC_ASSETS: { rel: string; content: string }[] = [
  // Skills — one operating manual per agent role.
  { rel: path.join("skills", "viberr-app-expertise", "SKILL.md"), content: viberrSkillMd },
  { rel: path.join("skills", "developer-expertise", "SKILL.md"), content: developerSkillMd },
  { rel: path.join("skills", "reviewer-expertise", "SKILL.md"), content: reviewerSkillMd },
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

export const PRIOR_SHIPPED_HASHES: PriorShippedHashes = {
  [path.join("agents", "definitions", "operator.md")]: [
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
  ],
  [path.join("skills", "viberr-app-expertise", "SKILL.md")]: [
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
  ],
  [path.join("skills", "developer-expertise", "SKILL.md")]: [
    "2cd21e2f0b11a3d35ca0188bf1d42af66f4149b5d7ad3bbb2162cdeb712d91fa",
    "9eed9c7c574b54491362374b8feff9760ab3401b48b60d077b889e60999ebe1f",
    // pass-21 outgoing (humanizer sweep).
    "d7c78f20730ef44a8e1d490cc2efbb2a1cf1cd1c5bb21a63bf8343df7ba1b17e",
  ],
  [path.join("skills", "reviewer-expertise", "SKILL.md")]: [
    "67b14be125a5f8b213a9ad3de6682c4762bdef703a40dc32ba1c907a267e1c31",
    "7aa79a7c54156f0556f437f525a31a5c12b2dd89a5465282974da61337bc041c",
    // outgoing before the evidence-rows-are-citations guidance
    "b2fdfb7f86bb294beabf836f59050d1d57eb429a9d787937783eb972b5a33c85",
    "c32401d03e628093ddaec888efdac35ad79e4ee3604502104fb5bf016adda025",
  ],
};

export function assetHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

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
      err: error instanceof Error ? error : new Error(String(error)),
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
 * The base specialist profile templates, generated from SEED_AGENT_PROFILES so
 * a deployment resolves (kind, backends, capabilities, resources) in a store
 * that was never demo-seeded — the counterpart of the operator profile template
 * that makes Developer/Reviewer preinstalled everywhere.
 */
function specialistProfileAssets(): { rel: string; content: string }[] {
  return SEED_AGENT_PROFILES.filter((p) =>
    DEFAULT_SPECIALIST_IDS.has(p.frontmatter.id),
  ).map((p) => ({
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
 */
export function seedDefaultAgentAssets(dataRoot?: string): void {
  const store = getDataRoot(dataRoot);
  const assets = [...STATIC_ASSETS, ...specialistProfileAssets()];
  const manifest = readShippedManifest(store);
  let manifestChanged = false;
  const record = (rel: string, hash: string): void => {
    if (manifest[rel] === hash) return;
    manifest[rel] = hash;
    manifestChanged = true;
  };
  for (const asset of assets) {
    try {
      const dest = path.join(store, asset.rel);
      const shippedHash = assetHash(asset.content);
      if (existsSync(dest)) {
        const onDiskHash = assetHash(readFileSync(dest, "utf8"));
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
            "shipped agent asset diverged — keeping the store's copy, which may be stale",
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
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  if (manifestChanged) writeShippedManifest(store, manifest);
}
