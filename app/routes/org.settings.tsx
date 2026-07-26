import { data } from "react-router";
import type { Route } from "./+types/org.settings";
import { OrgSettingsPage } from "~/features/org-settings/org-settings-page";
import { assertCsrf } from "~/server/auth/csrf.server";
import { appErrorResponse } from "~/server/auth/form-action.server";
import {
  requireRole,
  requireRoleAuth,
} from "~/server/auth/require-user.server";
import { disableUser, enableUser } from "~/server/auth/user-admin.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  createConnection,
  removeConnection,
  replaceConnectionToken,
  setDefaultConnection,
} from "~/server/org/connections.server";
import {
  deleteGlobalAgentProfile,
  saveGlobalAgentProfile,
} from "~/server/org/gagents.server";
import {
  addDomain,
  createLocalAccount,
  deleteOrgUser,
  removeDomain,
  resetLocalPassword,
  setOrgUserRole,
  updateOrgUser,
  whitelistGithubUser,
  whitelistGoogleAccount,
} from "~/server/org/org-users.server";
import { getOrgSettingsView } from "~/server/org/org-view.server";
import {
  deleteKnowledgeBase,
  deleteMcpServer,
  deleteSkill,
  reindexKnowledgeBase,
  resolveStoreTarget,
  saveKnowledgeBase,
  saveMcpServer,
  saveSkill,
  testMcpServer,
} from "~/server/org/resources.server";
import {
  createStoreFolder,
  deleteStoreNode,
  importGithubSnapshot,
  readStoreDoc,
  writeStoreDoc,
  writeStoreFiles,
  type UploadFileInput,
} from "~/server/org/store-files.server";

/**
 * /org/settings — the instance-level admin surface (org-settings spec),
 * replacing the phase-4 placeholder. Admin-only (org RBAC, phase-2
 * requireRole). Loader returns every slice (connections, users & domains,
 * agent resources incl. real disk-scanned kb/skill trees). Every mutation
 * is a CSRF-checked POST intent; toast copy is computed server-side
 * (phase-5 pattern) and errors come back as `{ ok:false, error }` for the
 * open dialog's `.cred-warn` / a toast. StoreBrowser uploads arrive as
 * multipart with per-file relative paths (structure-preserving).
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: "Viberr settings" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireRole(request, "admin");
  return { view: getOrgSettingsView(getDb()), meId: user.id };
}

type Ok = { ok: true; toast?: string } & Record<string, unknown>;

function ok(toast?: string, extra: Record<string, unknown> = {}): Ok {
  return { ok: true, ...(toast ? { toast } : {}), ...extra };
}

function fail(error: string, status = 400) {
  return data({ ok: false as const, error }, { status });
}

function parseRole(raw: string): "admin" | "member" {
  return raw === "admin" ? "admin" : "member";
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

export async function action({ request }: Route.ActionArgs) {
  // One session lookup for both the admin-role gate and the CSRF session id
  // (WI-12) — requireRole + requireAuth used to authenticate twice per mutation.
  const ctx = await requireRoleAuth(request, "admin");
  const admin = ctx.user;
  const db = getDb();
  const formData = await request.formData();
  await assertCsrf(request, ctx.sessionId, formData);
  const actor = { userId: admin.id, label: admin.email };
  const field = (name: string) => String(formData.get(name) ?? "");
  const intent = field("intent");

  try {
    switch (intent) {
      // ------------------------------------------------- connections
      case "connection-add": {
        const result = await createConnection(
          db,
          { owner: field("owner"), token: field("token"), userId: admin.id },
          actor,
        );
        if (result.status !== "saved") return fail(result.message);
        return ok(result.toast);
      }
      case "connection-replace": {
        const result = await replaceConnectionToken(
          db,
          { connectionId: field("connectionId"), token: field("token") },
          actor,
        );
        if (result.status !== "saved") {
          return fail(result.message, result.status === "not_found" ? 404 : 400);
        }
        return ok(result.toast);
      }
      case "connection-default": {
        const result = setDefaultConnection(db, field("connectionId"), actor);
        if (result.status !== "ok") {
          return fail("That connection no longer exists.", 404);
        }
        return ok(result.toast);
      }
      case "connection-remove": {
        const result = removeConnection(db, field("connectionId"), actor);
        if (result.status === "not_found") {
          return fail("That connection no longer exists.", 404);
        }
        if (result.status === "is_default") return fail(result.message, 409);
        return ok(result.toast);
      }

      // ------------------------------------------------- users & access
      case "user-role": {
        const role = parseRole(field("role"));
        if (field("userId") === admin.id && role !== "admin") {
          return fail("You can't demote yourself", 409);
        }
        const user = setOrgUserRole(db, { userId: field("userId"), role }, actor);
        return ok(`${user.name} → ${role}`);
      }
      case "user-edit": {
        const role = parseRole(field("role"));
        const isSelf = field("userId") === admin.id;
        if (isSelf && role !== "admin") {
          return fail("You can't demote yourself", 409);
        }
        const user = updateOrgUser(
          db,
          {
            userId: field("userId"),
            name: field("name"),
            email: field("email"),
            role,
          },
          actor,
        );
        return ok(isSelf ? "Profile updated" : `${user.name} updated`);
      }
      case "user-reset-password": {
        const result = await resetLocalPassword(db, field("userId"), actor);
        return ok(result.toast, { tempPassword: result.tempPassword });
      }
      case "user-remove": {
        if (field("userId") === admin.id) {
          return fail("You can't remove your own account", 409);
        }
        // UI-29: now async — it also prunes the account from every project.md
        // membership list before deleting the identity.
        const result = await deleteOrgUser(db, field("userId"), actor);
        return ok(result.toast);
      }
      case "user-disable": {
        if (field("userId") === admin.id) {
          return fail("You can't disable your own account", 409);
        }
        // Kills their sessions + blocks sign-in (login.server + require-user
        // already gate on `disabled`); last-admin guard lives in updateUser.
        const user = disableUser(db, field("userId"), actor);
        return ok(`${user.name} disabled — they can't sign in`);
      }
      case "user-enable": {
        const user = enableUser(db, field("userId"), actor);
        return ok(`${user.name} re-enabled`);
      }
      case "invite-github": {
        const result = whitelistGithubUser(
          db,
          { handle: field("handle"), role: parseRole(field("role")) },
          actor,
        );
        return ok(result.toast);
      }
      case "invite-google": {
        const result = await whitelistGoogleAccount(
          db,
          { email: field("email"), role: parseRole(field("role")) },
          actor,
        );
        return ok(result.toast);
      }
      case "invite-domain": {
        const result = addDomain(
          db,
          { domain: field("email"), role: parseRole(field("role")) },
          actor,
        );
        if (result.status === "invalid") return fail(result.message);
        if (result.status === "duplicate") return fail(result.message, 409);
        return ok(result.toast);
      }
      case "invite-local": {
        const result = await createLocalAccount(
          db,
          {
            name: field("name"),
            email: field("email"),
            role: parseRole(field("role")),
          },
          actor,
        );
        return ok(result.toast, {
          tempPassword: result.tempPassword,
          email: result.user.email,
        });
      }
      case "domain-remove": {
        const result = removeDomain(db, field("domainId"), actor);
        return ok(result.toast);
      }

      // ------------------------------------------------- agent resources
      case "kb-save": {
        const result = await saveKnowledgeBase(
          db,
          {
            id: field("kbId") || null,
            name: field("name"),
            refresh: field("refresh"),
          },
          actor,
        );
        return ok(result.toast);
      }
      case "kb-delete":
        return ok((await deleteKnowledgeBase(db, field("kbId"), actor)).toast);
      case "kb-reindex":
        return ok(reindexKnowledgeBase(db, field("kbId"), actor).toast);
      case "mcp-save": {
        const result = await saveMcpServer(
          db,
          {
            id: field("mcpId") || null,
            name: field("name"),
            transport: field("transport"),
            target: field("target"),
            cred: field("cred"),
            clearCred: field("clearCred") === "1",
          },
          actor,
        );
        return ok(result.toast);
      }
      case "mcp-test":
        return ok((await testMcpServer(db, field("mcpId"))).toast);
      case "mcp-delete":
        return ok((await deleteMcpServer(db, field("mcpId"), actor)).toast);
      case "skill-save": {
        const result = await saveSkill(
          db,
          {
            id: field("skillId") || null,
            name: field("name"),
            summary: field("summary"),
            body: field("body"),
            clearBody: field("clearBody") === "1",
            contentMode: field("contentMode") === "files" ? "files" : "write",
          },
          actor,
        );
        return ok(result.toast);
      }
      case "skill-delete":
        return ok((await deleteSkill(db, field("skillId"), actor)).toast);
      case "agent-save": {
        const result = saveGlobalAgentProfile(
          db,
          {
            id: field("profileId") || null,
            name: field("name"),
            backend: field("backend") === "claude" ? "claude" : "codex",
            summary: field("summary"),
            persona: field("persona"),
            stages: parseJsonStringArray(field("stages")),
            skills: parseJsonStringArray(field("skills")),
            mcps: parseJsonStringArray(field("mcps")),
            kbs: parseJsonStringArray(field("kbs")),
          },
          actor,
        );
        return ok(result.toast);
      }
      case "agent-delete": {
        const result = deleteGlobalAgentProfile(db, field("profileId"), actor);
        if (result.status === "in_use") return fail(result.message, 409);
        return ok(result.toast);
      }

      // ------------------------------------------------- store browser
      case "store-upload": {
        const target = resolveStoreTarget(db, field("kind"), field("id"));
        if (!target) return fail("That resource no longer exists.", 404);
        const dirPath = parseJsonStringArray(field("path"));
        const rawFiles = formData
          .getAll("files")
          .filter((f): f is File => f instanceof File);
        const relPaths = formData.getAll("filePaths").map(String);
        const files: UploadFileInput[] = await Promise.all(
          rawFiles.map(async (file, i) => ({
            relPath: relPaths[i] || file.name,
            data: Buffer.from(await file.arrayBuffer()),
          })),
        );
        const result = writeStoreFiles(db, target, dirPath, files, actor);
        const atPath = [target.rootUri, ...dirPath].join("/") + "/";
        // P13-UI-08 residual: an upload that wrote nothing answered with a bare
        // `ok()` — no toast at all, so a drop the server dropped (every path a
        // dot-file) looked exactly like one it stored. Both halves of that now
        // report: the client for a selection it filtered itself, this for one
        // the server's own `cleanRelPath` rejected.
        const skipped = files.length - result.added;
        if (result.added === 0) {
          return ok(
            skipped > 0
              ? `Nothing uploaded to ${atPath} — ${skipped} hidden file${skipped === 1 ? "" : "s"} skipped (names starting with “.” are never stored).`
              : `Nothing uploaded — that selection had no files.`,
          );
        }
        const skippedNote =
          skipped > 0
            ? ` · ${skipped} hidden file${skipped === 1 ? "" : "s"} skipped`
            : "";
        const toast =
          (field("mode") === "folder" && result.topLevelDirs.length > 0
            ? `Folder “${result.topLevelDirs.join(", ")}” uploaded as-is — ${result.added} file${result.added === 1 ? "" : "s"}`
            : `${result.added} file${result.added === 1 ? "" : "s"} added to ${atPath}`) +
          skippedNote;
        return ok(toast, {
          ...(result.capturedSkillMd
            ? {
                captureToast:
                  "SKILL.md content captured — fully editable in the skill editor",
              }
            : {}),
        });
      }
      case "store-write-doc": {
        const target = resolveStoreTarget(db, field("kind"), field("id"));
        if (!target) return fail("That resource no longer exists.", 404);
        const result = writeStoreDoc(
          db,
          target,
          parseJsonStringArray(field("path")),
          field("name"),
          field("body"),
          actor,
          // P14-UI-59: writing was create-OR-overwrite behind one "saved" toast,
          // so authoring a name that already existed destroyed the old file with
          // a success message. The server refuses a collision unless the UI's
          // replace confirm says otherwise.
          { overwrite: field("overwrite") === "1" },
        );
        return ok(
          `${result.path.join("/")} ${result.replaced ? "replaced" : "saved"} — ${result.bytes} bytes`,
        );
      }
      // P14-KM-08/UI-61: `readStoreDoc` shipped in pass 13 with no production
      // caller, so an existing document could not be opened or edited at all —
      // the only in-app edit was a blind overwrite by retyping its name.
      case "store-read-doc": {
        const target = resolveStoreTarget(db, field("kind"), field("id"));
        if (!target) return fail("That resource no longer exists.", 404);
        const doc = readStoreDoc(target, parseJsonStringArray(field("path")));
        if (!doc) return fail("That file no longer exists.", 404);
        return ok(undefined, { text: doc.text, truncated: doc.truncated });
      }
      case "store-mkdir": {
        const target = resolveStoreTarget(db, field("kind"), field("id"));
        if (!target) return fail("That resource no longer exists.", 404);
        const result = createStoreFolder(
          db,
          target,
          parseJsonStringArray(field("path")),
          field("name"),
          actor,
        );
        return ok(`Folder ${result.createdPath.join("/")}/ ready`);
      }
      case "store-delete": {
        const target = resolveStoreTarget(db, field("kind"), field("id"));
        if (!target) return fail("That resource no longer exists.", 404);
        const result = deleteStoreNode(
          db,
          target,
          parseJsonStringArray(field("path")),
          actor,
        );
        return ok(
          result.wasDir ? `Folder “${result.name}” deleted` : `“${result.name}” deleted`,
        );
      }
      case "store-import-github": {
        const target = resolveStoreTarget(db, field("kind"), field("id"));
        if (!target) return fail("That resource no longer exists.", 404);
        const result = await importGithubSnapshot(db, target, field("url"), actor, {
          // P14-KM-08: the import ignored the browsed folder and always wrote to
          // the store root, so imports could not be organised from the UI.
          dirPath: parseJsonStringArray(field("path")),
        });
        if (result.status !== "imported") return fail(result.message);
        return ok(result.toast, { folder: result.folder });
      }

      default:
        return fail("Unknown action.");
    }
  } catch (error) {
    return appErrorResponse(error);
  }
}

export default function OrgSettings({ loaderData }: Route.ComponentProps) {
  return <OrgSettingsPage view={loaderData.view} meId={loaderData.meId} />;
}
