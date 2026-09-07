import { data } from "react-router";
import { pageTitle } from "~/shared/page-title";
import { z } from "zod";
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
  drainRunQueue,
  runConcurrencySnapshot,
} from "~/server/runtimes/run-service.server";
import { setMaxConcurrentRuns } from "~/server/settings/instance-settings.server";
import {
  clearS3AuditConfig,
  getS3AuditConfigForUse,
  getS3AuditConfigView,
  setS3AuditConfig,
} from "~/server/audit/s3-config.server";
import {
  EXPORT_FORMATS,
  isAuditExportFormat,
  queryAuditEventsForExport,
  serializeAuditExport,
} from "~/server/audit/audit-export.server";
import { putObjectToS3 } from "~/server/audit/s3-put.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { listRecentAuditEvents } from "~/server/audit/audit-browse.server";
import {
  controllerSectionLocks,
  resolveControllerConfig,
  saveControllerConfig,
} from "~/server/controller/controller-profile.server";
import { oauthCallbackUrl } from "~/shared/auth/auth-paths";
import {
  testOAuthCredentials,
  type OAuthProvider,
} from "~/server/auth/oauth-credential-test.server";
import {
  deleteOAuthProvider,
  getOAuthProviderRow,
  readOAuthSecret,
  recordOAuthVerification,
  saveOAuthProvider,
  setOAuthProviderEnabled,
} from "~/server/auth/oauth-providers.server";
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
 * open dialog's `.form-err` / a toast. StoreBrowser uploads arrive as
 * multipart with per-file relative paths (structure-preserving).
 */

export function meta() {
  return [{ title: pageTitle("Instance settings") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireRole(request, "admin");
  return {
    view: getOrgSettingsView(getDb()),
    meId: user.id,
    // R19-16: computed server-side from the request rather than
    // `window.location`, so the callback URL the card tells an admin to
    // register is identical in the SSR markup and after hydration.
    callbackOrigin: new URL(request.url).origin,
    // Instance run-concurrency: the configured cap and the live/queued counts,
    // for the admin control below StorageLine.
    runConcurrency: runConcurrencySnapshot(getDb()),
    // The S3 audit-export target (never carries the secret key).
    s3Audit: getS3AuditConfigView(getDb()),
    // PG26-A: the recent audit events for the in-app browse panel — the only way
    // to READ org/instance-scoped events (sign-ins, PAT changes, user admin) in
    // the app; the project Activity page is project-scoped and the export is a file.
    auditEvents: listRecentAuditEvents(getDb()),
    // Ruling 99: the controller configuration the admin tab edits.
    controllerConfig: resolveControllerConfig(),
    // Ruling 108: which of its sections this DEPLOYMENT allows editing.
    controllerLocks: controllerSectionLocks(),
  };
}

/**
 * The success reply every intent in this action answers with. `toast` is the
 * server-computed copy the default client handler pushes; every other field is
 * a per-intent payload a specific panel reads. All of them are OMITTED unless
 * that intent produced one — the panels key their follow-up UI on the key being
 * there, not on its value.
 */
type SettingsOk = {
  ok: true;
  toast?: string;
  /** `user-invite` / `user-reset-password`: the one-time local password, shown
   *  once, with the account it belongs to. */
  tempPassword?: string;
  email?: string;
  /** `store-upload`: a second toast when a SKILL.md body was captured. */
  captureToast?: string;
  /** `store-read-doc`: the document body and whether the read was cut short. */
  text?: string;
  truncated?: boolean;
  /** `store-import-github`: the store-relative folder the snapshot landed in. */
  folder?: string;
};

/** The per-intent half of `SettingsOk` — what a case hands `ok()` beyond copy. */
type SettingsOkPayload = Omit<SettingsOk, "ok" | "toast">;

function ok(toast?: string, extra: SettingsOkPayload = {}): SettingsOk {
  const reply: SettingsOk = { ok: true };
  if (toast) reply.toast = toast;
  return { ...reply, ...extra };
}

function fail(error: string, status = 400) {
  return data({ ok: false as const, error }, { status });
}

function parseRole(raw: string): "admin" | "member" {
  return raw === "admin" ? "admin" : "member";
}

function parseOAuthProvider(raw: string): OAuthProvider | null {
  return raw === "github" || raw === "google" ? raw : null;
}

function providerLabel(provider: OAuthProvider): string {
  return provider === "github" ? "GitHub" : "Google";
}

/** Store paths travel as a JSON array of segments. Anything that is not a list
 *  of strings names no path, and a junk MEMBER is dropped rather than voiding
 *  the whole path the admin actually browsed to. */
const storePath = z
  .array(z.string().nullable().catch(null))
  .transform((segments) => segments.filter((seg) => seg !== null))
  .catch([]);

function parseJsonStringArray(raw: string): string[] {
  try {
    return storePath.parse(JSON.parse(raw));
  } catch {
    // Not JSON at all — the field named no path.
    return [];
  }
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
      // ------------------------------------------------- run concurrency
      case "set-concurrency": {
        const raw = Number(field("maxConcurrentRuns"));
        if (!Number.isFinite(raw) || raw < 0) {
          return fail("Enter a whole number (0 = unlimited).");
        }
        const applied = setMaxConcurrentRuns(db, raw);
        // A raised (or lifted) cap frees slots right away — promote any runs
        // that were waiting behind the old, lower limit.
        drainRunQueue(db);
        return ok(
          applied === 0
            ? "Run concurrency is now unlimited."
            : `Agent runs are now capped at ${applied} at a time.`,
        );
      }
      // ------------------------------------------------- audit S3 export
      case "s3-config-save": {
        try {
          setS3AuditConfig(db, {
            bucket: field("bucket"),
            region: field("region"),
            prefix: field("prefix"),
            endpoint: field("endpoint"),
            accessKeyId: field("accessKeyId"),
            // Blank keeps the existing sealed secret (edit without re-typing).
            secretAccessKey: field("secretAccessKey"),
          }, actor);
        } catch (error) {
          return fail(
            error instanceof Error ? error.message : "Could not save the S3 target.",
          );
        }
        return ok("S3 audit-export target saved.");
      }
      case "s3-config-clear": {
        clearS3AuditConfig(db, actor);
        return ok("S3 audit-export target removed.");
      }
      case "audit-export-s3": {
        const config = getS3AuditConfigForUse(db);
        if (!config) {
          return fail(
            "No S3 target is configured (or its secret could not be read). Save one first.",
          );
        }
        const formatRaw = field("format") || "json";
        const format = isAuditExportFormat(formatRaw) ? formatRaw : "json";
        const rows = queryAuditEventsForExport(db);
        const body = Buffer.from(serializeAuditExport(rows, format), "utf8");
        const spec = EXPORT_FORMATS[format];
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const objectKey = `viberr-audit-${stamp}.${spec.ext}`;
        // F26-11: putObjectToS3 returns a result for an HTTP error, but a
        // network-level failure (DNS, connection refused, TLS) makes `fetch`
        // THROW — without this catch it escaped the crafted message and
        // re-threw raw (appErrorResponse only maps AppError), surfacing a
        // stack-shaped 500 instead of "S3 upload failed".
        let result;
        try {
          result = await putObjectToS3(config, objectKey, body, {
            contentType: spec.contentType,
            isoNow: new Date().toISOString(),
          });
        } catch (error) {
          return fail(
            `S3 upload failed: could not reach the bucket. ${
              error instanceof Error ? error.message : String(error)
            }`.slice(0, 240),
          );
        }
        if (!result.ok) {
          return fail(
            `S3 upload failed (HTTP ${result.status}). ${result.error.slice(0, 200)}`.trim(),
          );
        }
        // Shipping the whole audit log off-box is itself a governed action —
        // and the only record of it used to be the object in the bucket, which
        // is precisely the place someone covering their tracks controls.
        recordAudit(db, {
          action: "org.audit_export.shipped",
          actor,
          subjectKind: "s3_audit_config",
          subjectId: "s3",
          details: {
            bucket: config.bucket,
            region: config.region,
            objectKey,
            format,
            rowCount: rows.length,
            bytes: body.byteLength,
          },
        });
        return ok(`Exported ${rows.length} audit rows to S3 (${objectKey}).`);
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
        return ok(`${user.name} disabled. They can't sign in`);
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
      case "controller-save": {
        // Ruling 99: only org admins modify the controller itself (this whole
        // action is admin-gated above).
        const splitNames = (raw: string) =>
          raw
            .split("\n")
            .map((n) => n.trim())
            .filter(Boolean);
        saveControllerConfig(
          db,
          {
            model: field("model"),
            effort: field("effort"),
            definition: field("definition"),
            skills: splitNames(field("skills")),
            kb: splitNames(field("kb")),
            mcps: splitNames(field("mcps")),
          },
          actor,
        );
        return ok("Controller updated. Changes apply from its next turn");
      }
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
      // ---- R19-16: sign-in providers, configured in the app ----
      case "oauth-save": {
        const provider = parseOAuthProvider(field("provider"));
        if (!provider) return fail("Unknown sign-in provider.");
        const clientId = field("clientId").trim();
        if (!clientId) return fail("Paste the client ID.");
        const secret = field("clientSecret").trim();
        if (!secret && !getOAuthProviderRow(db, provider)) {
          return fail("Paste the client secret.");
        }
        saveOAuthProvider(
          db,
          { provider, clientId, clientSecret: secret || null },
          actor,
        );
        return ok(
          `${providerLabel(provider)} credentials saved. Test them to switch sign-in on.`,
        );
      }
      case "oauth-test": {
        const provider = parseOAuthProvider(field("provider"));
        if (!provider) return fail("Unknown sign-in provider.");
        const row = getOAuthProviderRow(db, provider);
        const secret = readOAuthSecret(db, provider);
        if (!row || !secret) {
          return fail("Save the client ID and secret first.");
        }
        const result = await testOAuthCredentials(
          provider,
          row.clientId,
          secret,
          {
            // The callback this deployment actually serves — the same string
            // the card tells the admin to register. Google echoes
            // `redirect_uri` back during the probe, so sending the real one
            // keeps the test honest.
            redirectUri: oauthCallbackUrl(
              new URL(request.url).origin,
              provider,
            ),
          },
        );
        recordOAuthVerification(
          db,
          provider,
          result.ok
            ? { ok: true, detail: result.detail }
            : { ok: false, detail: result.reason },
          actor,
        );
        return result.ok
          ? ok(`${providerLabel(provider)} accepted the credentials.`)
          : fail(result.reason);
      }
      case "oauth-toggle": {
        const provider = parseOAuthProvider(field("provider"));
        if (!provider) return fail("Unknown sign-in provider.");
        const enabled = field("enabled") === "1";
        const result = setOAuthProviderEnabled(db, provider, enabled, actor);
        if (!result.ok) return fail(result.reason);
        return ok(
          enabled
            ? `${providerLabel(provider)} sign-in is on.`
            : `${providerLabel(provider)} sign-in is off.`,
        );
      }
      case "oauth-remove": {
        const provider = parseOAuthProvider(field("provider"));
        if (!provider) return fail("Unknown sign-in provider.");
        deleteOAuthProvider(db, provider, actor);
        return ok(`${providerLabel(provider)} configuration removed.`);
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
        const result = await saveGlobalAgentProfile(
          db,
          {
            id: field("profileId") || null,
            name: field("name"),
            backend: field("backend") === "claude" ? "claude" : "codex",
            summary: field("summary"),
            role: field("role"),
            persona: field("persona"),
            stages: parseJsonStringArray(field("stages")),
            skills: parseJsonStringArray(field("skills")),
            mcps: parseJsonStringArray(field("mcps")),
            kbs: parseJsonStringArray(field("kbs")),
            // Ruling 156: the modal's "copy these grants" box; this route is
            // org-admin only, so the propagation stays an org admin's act.
            propagate: field("propagate") === "1",
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
              ? `Nothing uploaded to ${atPath}. ${skipped} hidden file${skipped === 1 ? "" : "s"} skipped (names starting with “.” are never stored).`
              : `Nothing uploaded: that selection had no files.`,
          );
        }
        const skippedNote =
          skipped > 0
            ? ` · ${skipped} hidden file${skipped === 1 ? "" : "s"} skipped`
            : "";
        const toast =
          (field("mode") === "folder" && result.topLevelDirs.length > 0
            ? `Folder “${result.topLevelDirs.join(", ")}” uploaded as-is · ${result.added} file${result.added === 1 ? "" : "s"}`
            : `${result.added} file${result.added === 1 ? "" : "s"} added to ${atPath}`) +
          skippedNote;
        const uploaded: SettingsOkPayload = {};
        if (result.capturedSkillMd)
          uploaded.captureToast =
            "SKILL.md content captured, fully editable in the skill editor";
        return ok(toast, uploaded);
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
          `${result.path.join("/")} ${result.replaced ? "replaced" : "saved"} · ${result.bytes} bytes`,
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
  return (
    <OrgSettingsPage
      view={loaderData.view}
      meId={loaderData.meId}
      callbackOrigin={loaderData.callbackOrigin}
      runConcurrency={loaderData.runConcurrency}
      s3Audit={loaderData.s3Audit}
      auditEvents={loaderData.auditEvents}
      controllerConfig={loaderData.controllerConfig}
      controllerLocks={loaderData.controllerLocks}
    />
  );
}
