import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { updateUserFields } from "~/server/auth/user-store.server";
import {
  loginTargetFor,
  recordBackendLogin,
  setBackendApiKey,
} from "./backend-credentials.server";
import {
  principalRefusalMessage,
  resolveTaskRunPrincipal,
  resolveUserRunPrincipal,
  type RunPrincipalRefusal,
} from "./run-principal.server";
import {
  claudeLoginCredentialPath,
  ensureBackendAccountHome,
} from "./user-homes.server";

/**
 * Ruling 127: every run bills ONE person — the task owner on a task, the asker
 * on the controller — and a run that cannot name that person does not start.
 */

const CLAUDE_KEY = "sk-ant-api03-viberr-principal-test";

let ctx: TestDbContext;
let store: TestStore;

/** A provider that accepts the pasted key, so a person can be "connected"
 *  without a network. */
const acceptingProvider: typeof fetch = () =>
  Promise.resolve(new Response("{}", { status: 200 }));

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});

afterEach(() => {
  ctx.cleanup();
});

function writeOwnedTask(key: string, ownerUserId: string | null): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, { ownerUserId }),
  });
}

async function connectClaude(userId: string, label: string): Promise<void> {
  await setBackendApiKey(
    store.db,
    { userId, label },
    "claude",
    "api_key",
    CLAUDE_KEY,
    { fetchImpl: acceptingProvider },
  );
}

describe("resolveTaskRunPrincipal", () => {
  it("resolves to the task OWNER when they have the backend connected", async () => {
    await connectClaude(store.users.murat.id, store.users.murat.email);
    writeOwnedTask("VIB-1", store.users.murat.id);

    const resolution = resolveTaskRunPrincipal(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      "claude",
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // The owner — never the person who pressed the button, never the viewer.
    expect(resolution.principal.userId).toBe(store.users.murat.id);
    expect(resolution.principal.label).toBe(store.users.murat.email);
    expect(resolution.principal.name).toBe(store.users.murat.name);
    expect(resolution.health.available).toBe(true);
    expect(resolution.health.kind).toBe("api_key");
  });

  it("refuses an UNOWNED task and names the task in the sentence", () => {
    writeOwnedTask("VIB-2", null);
    const resolution = resolveTaskRunPrincipal(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-2",
      "codex",
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.refusal).toEqual({ kind: "unowned", taskKey: "VIB-2" });

    const message = principalRefusalMessage(resolution.refusal, "codex");
    expect(message).toContain("Codex runs on VIB-2 need a task owner");
    expect(message).toContain("Assign me");
    expect(message).toContain("No agent process was started.");
  });

  it("treats a task file that is not there as unowned, not as a crash", () => {
    const resolution = resolveTaskRunPrincipal(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-404",
      "claude",
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.refusal.kind).toBe("unowned");
  });

  it("refuses when the owner's account is DISABLED", async () => {
    await connectClaude(store.users.selin.id, store.users.selin.email);
    updateUserFields(store.db, store.users.selin.id, { disabled: true });
    writeOwnedTask("VIB-3", store.users.selin.id);

    const resolution = resolveTaskRunPrincipal(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-3",
      "claude",
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.refusal).toEqual({
      kind: "owner-missing",
      ownerUserId: store.users.selin.id,
    });
    const message = principalRefusalMessage(resolution.refusal, "claude");
    expect(message).toContain("owner account is disabled or gone");
    expect(message).toContain("Assign a new owner");
    expect(message).toContain("No agent process was started.");
  });

  it("refuses when the owner row is GONE", () => {
    writeOwnedTask("VIB-4", "u_deleted_person");
    const resolution = resolveTaskRunPrincipal(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-4",
      "claude",
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.refusal).toEqual({
      kind: "owner-missing",
      ownerUserId: "u_deleted_person",
    });
  });

  it("refuses when the owner has not connected that backend, and says whose it is", () => {
    writeOwnedTask("VIB-5", store.users.murat.id);
    const resolution = resolveTaskRunPrincipal(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-5",
      "codex",
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    if (resolution.refusal.kind !== "no-credential") {
      throw new Error(`expected no-credential, got ${resolution.refusal.kind}`);
    }
    expect(resolution.refusal.owner.userId).toBe(store.users.murat.id);
    expect(resolution.refusal.backend).toBe("codex");
    expect(resolution.refusal.health.available).toBe(false);

    const message = principalRefusalMessage(resolution.refusal, "codex");
    expect(message).toContain(
      `Codex isn't connected for ${store.users.murat.name} (${store.users.murat.email}), the task owner.`,
    );
    expect(message).toContain("Profile → Agent accounts");
    expect(message).toContain("No agent process was started.");
    // The generic "not connected" health line adds nothing the first sentence
    // did not already say, so it is not repeated.
    expect(message).not.toContain("Connect it on your Profile");
  });

  it("appends the specific reason when the owner's sign-in FILE is the problem", () => {
    const target = loginTargetFor(store.db, store.users.murat.id, "claude");
    recordBackendLogin(
      store.db,
      { userId: store.users.murat.id, label: store.users.murat.email },
      "claude",
      "claudeai",
      { authMethod: "claudeai" },
      target,
    );
    writeOwnedTask("VIB-6", store.users.murat.id);

    const resolution = resolveTaskRunPrincipal(
      store.db,
      { dataRoot: store.dataRoot, platform: "linux" },
      store.slug,
      "VIB-6",
      "claude",
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    const message = principalRefusalMessage(resolution.refusal, "claude");
    expect(message).toContain("isn't connected for");
    expect(message).toContain("sign-in file is missing from this server");

    // …and the moment the file is back — in the account's own home (ruling
    // 507) — the same task resolves.
    const { home } = ensureBackendAccountHome(
      store.users.murat.id,
      "claude",
      target,
      store.dataRoot,
    );
    writeFileSync(claudeLoginCredentialPath(home), "{}");
    const healed = resolveTaskRunPrincipal(
      store.db,
      { dataRoot: store.dataRoot, platform: "linux" },
      store.slug,
      "VIB-6",
      "claude",
    );
    expect(healed.ok).toBe(true);
  });
});

describe("resolveUserRunPrincipal (the controller's asker)", () => {
  it("resolves the asker themselves", async () => {
    await connectClaude(store.users.arda.id, store.users.arda.email);
    const resolution = resolveUserRunPrincipal(
      store.db,
      store.users.arda.id,
      "claude",
      { dataRoot: store.dataRoot },
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.principal).toEqual({
      userId: store.users.arda.id,
      label: store.users.arda.email,
      name: store.users.arda.name,
    });
  });

  it("refuses an asker with nothing connected — and can never be 'unowned'", () => {
    const resolution = resolveUserRunPrincipal(
      store.db,
      store.users.elif.id,
      "claude",
      { dataRoot: store.dataRoot },
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.refusal.kind).toBe("no-credential");
  });

  it("refuses a disabled asker", () => {
    updateUserFields(store.db, store.users.elif.id, { disabled: true });
    const resolution = resolveUserRunPrincipal(
      store.db,
      store.users.elif.id,
      "claude",
      { dataRoot: store.dataRoot },
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.refusal.kind).toBe("owner-missing");
  });
});

describe("principalRefusalMessage", () => {
  it("uses the ruling-92 backend labels", () => {
    const unowned = { kind: "unowned", taskKey: "VIB-9" } as const;
    expect(principalRefusalMessage(unowned, "claude").startsWith("Claude runs on VIB-9")).toBe(true);
    expect(principalRefusalMessage(unowned, "codex").startsWith("Codex runs on VIB-9")).toBe(true);
  });

  it("names no environment variable — ruling 127 left none to set", () => {
    // CANARY: bring back the deployment-wide answer (a key, a token or a home
    // to set) in any of the three sentences and this fails.
    writeOwnedTask("VIB-5", store.users.murat.id);
    for (const backend of ["claude", "codex"] as const) {
      const resolution = resolveTaskRunPrincipal(
        store.db,
        { dataRoot: store.dataRoot },
        store.slug,
        "VIB-5",
        backend,
      );
      if (resolution.ok) throw new Error("expected the owner to have no account");
      expect(resolution.refusal.kind).toBe("no-credential");
      const refusals: RunPrincipalRefusal[] = [
        { kind: "unowned", taskKey: "VIB-9" },
        { kind: "owner-missing", ownerUserId: "u_gone" },
        resolution.refusal,
      ];
      for (const refusal of refusals) {
        const message = principalRefusalMessage(refusal, backend);
        for (const gone of [
          "ANTHROPIC_API_KEY",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CONFIG_DIR",
          "CODEX_API_KEY",
          "OPENAI_API_KEY",
          "CODEX_HOME",
          "VIBERR_CODEX_USE_CLI_AUTH",
          "VIBERR_CLAUDE_USE_CLI_AUTH",
        ]) {
          expect(message, `${refusal.kind} · ${backend}`).not.toContain(gone);
        }
      }
    }
  });
});
