import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  routeArgs,
  setupAppTest,
  type AppTestContext,
} from "../../test-support/test-app";
import { getS3AuditConfigView } from "~/server/audit/s3-config.server";

/**
 * Audit export: the org-admin download route (CSV/JSON) and the S3 config +
 * push action. The S3 PUT's fetch is stubbed so no network is touched; the
 * SigV4 signing itself is unit-tested in s3-put.server.test.ts.
 */

let app: AppTestContext;
let ardaId: string;
let elifId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda; // org admin
  elifId = userIds.elif; // not admin
});
afterAll(() => app.cleanup());
afterEach(() => vi.unstubAllGlobals());

async function download(userId: string, format: string): Promise<Response> {
  const { loader } = await import("~/routes/org.settings.audit-export");
  const { cookie } = await app.cookieFor(userId);
  const request = app.request(`/org/settings/audit-export?format=${format}`, {
    cookie,
  });
  return loader({ request });
}

async function post(
  userId: string,
  fields: Record<string, string>,
): Promise<{ ok: boolean; toast?: string; error?: string }> {
  const { action } = await import("~/routes/org.settings");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set("_csrf", csrf);
  const request = app.request("/org/settings", { method: "POST", body: fd, cookie });
  const result = await action(routeArgs(request, {}, "/org/settings"));
  return "data" in result ? result.data : result;
}

describe("audit-export download route", () => {
  it("streams a CSV attachment for an admin", async () => {
    const res = await download(ardaId, "csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /attachment; filename="viberr-audit-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    const body = await res.text();
    expect(body.split("\r\n")[0]).toContain("id,occurredAt,");
  });

  it("streams JSON for format=json", async () => {
    const res = await download(ardaId, "json");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const parsed = JSON.parse(await res.text());
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("refuses a non-admin", async () => {
    await expect(download(elifId, "csv")).rejects.toMatchObject({ status: 403 });
  });
});

describe("S3 audit-export config + push", () => {
  it("saves the config (secret sealed, never echoed) and exports to S3", async () => {
    const saved = await post(ardaId, {
      intent: "s3-config-save",
      bucket: "viberr-audit",
      region: "eu-central-1",
      prefix: "audit/",
      endpoint: "",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "topsecret",
    });
    expect(saved.ok).toBe(true);
    const view = getS3AuditConfigView(app.db)!;
    expect(view.bucket).toBe("viberr-audit");
    expect(view.hasSecret).toBe(true);
    // The view never carries the secret.
    expect(JSON.stringify(view)).not.toContain("topsecret");

    // Stub the network: capture the signed PUT and answer 200.
    let put: { url: string; method?: string; auth: string | null } | null = null;
    const stub: typeof fetch = async (url, init) => {
      put = {
        url: String(url),
        method: init?.method,
        auth: new Headers(init?.headers).get("Authorization"),
      };
      return new Response("", { status: 200 });
    };
    vi.stubGlobal("fetch", stub);
    const exported = await post(ardaId, { intent: "audit-export-s3", format: "json" });
    expect(exported.ok).toBe(true);
    expect(exported.toast).toMatch(/Exported \d+ audit rows to S3/);
    expect(put!.method).toBe("PUT");
    expect(put!.url).toContain("viberr-audit.s3.eu-central-1.amazonaws.com/audit/");
    expect(put!.auth).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("surfaces an S3 error instead of claiming success", async () => {
    await post(ardaId, {
      intent: "s3-config-save",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "AKIA",
      secretAccessKey: "sekret",
    });
    const stub: typeof fetch = async () =>
      new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    vi.stubGlobal("fetch", stub);
    const exported = await post(ardaId, { intent: "audit-export-s3", format: "csv" });
    expect(exported.ok).toBe(false);
    expect(exported.error).toMatch(/S3 upload failed \(HTTP 403\)/);
  });

  it("export-to-S3 fails cleanly when nothing is configured", async () => {
    await post(ardaId, { intent: "s3-config-clear" });
    const exported = await post(ardaId, { intent: "audit-export-s3", format: "json" });
    expect(exported.ok).toBe(false);
    expect(exported.error).toMatch(/No S3 target is configured/);
  });
});
