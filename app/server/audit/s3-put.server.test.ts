import { describe, expect, it } from "vitest";
import { putObjectToS3, signingKey, type S3Config } from "./s3-put.server";

describe("SigV4 signing key (AWS published KAT)", () => {
  it("derives the SigV4 signing key matching an independent openssl HMAC chain", () => {
    // Cross-tool KAT: the same value openssl produces for the AWS example inputs
    // (secret/20150830/us-east-1/iam) via the HMAC chain
    //   AWS4<secret> -> date -> region -> service -> aws4_request.
    const key = signingKey(
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "20150830",
      "us-east-1",
      "iam",
    );
    expect(key.toString("hex")).toBe(
      "2c94c0cf5378ada6887f09bb697df8fc0affdb34ba1cdd5bda32b664bd55b73c",
    );
  });
});

const CONFIG: S3Config = {
  bucket: "viberr-audit",
  region: "eu-central-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secretExampleKey",
};

/** The URL and signed headers putObjectToS3 hands the network for one PUT. */
async function sent(
  config: S3Config,
  key: string,
  body: Buffer,
  contentType: string,
  isoNow: string,
): Promise<{ url: string; headers: Headers }> {
  const requests: { url: string; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response("", { status: 200 });
  };
  await putObjectToS3(config, key, body, { contentType, isoNow, fetchImpl });
  const [request] = requests;
  if (!request) throw new Error("putObjectToS3 sent no request");
  return request;
}

// F26-7: the canonical URI must include any base path the endpoint carries, or a
// path-style S3-compatible store (MinIO/Ceph) signs a different path than it
// receives and rejects every push with SignatureDoesNotMatch. The request URL is
// built from the same canonical URI the signature covers.
describe("the canonical URI a PUT goes to", () => {
  it.each<[string, string | undefined, string, string]>([
    [
      "keeps the key's slashes as separators and percent-encodes its segments",
      undefined,
      "audit/2026/exports/log 1.csv",
      "https://viberr-audit.s3.eu-central-1.amazonaws.com/audit/2026/exports/log%201.csv",
    ],
    [
      "percent-encodes the reserved characters in a segment",
      undefined,
      "a+b/c&d",
      "https://viberr-audit.s3.eu-central-1.amazonaws.com/a%2Bb/c%26d",
    ],
    [
      "is just the key path for a root endpoint",
      "https://minio.internal:9000/",
      "exports/log.csv",
      "https://minio.internal:9000/exports/log.csv",
    ],
    [
      "folds a path-style bucket prefix into the path",
      "https://minio.internal:9000/viberr-audit",
      "team/log.json",
      "https://minio.internal:9000/viberr-audit/team/log.json",
    ],
    [
      "re-encodes a base path exactly once (no double-encoding)",
      "https://minio.internal:9000/my%20bucket",
      "k.csv",
      "https://minio.internal:9000/my%20bucket/k.csv",
    ],
  ])("%s", async (_name, endpoint, key, url) => {
    const config = endpoint ? { ...CONFIG, endpoint } : CONFIG;
    const request = await sent(config, key, Buffer.from("x"), "text/csv", "2026-08-23T00:00:00.000Z");
    expect(request.url).toBe(url);
  });
});

describe("the signed request putObjectToS3 sends", () => {
  it("produces a deterministic, well-formed signed request", async () => {
    const body = Buffer.from("id,action\r\n1,task.created\r\n");
    const signed = await sent(
      CONFIG,
      "exports/log.csv",
      body,
      "text/csv; charset=utf-8",
      "2026-08-23T00:00:00.000Z",
    );
    expect(signed.url).toBe(
      "https://viberr-audit.s3.eu-central-1.amazonaws.com/exports/log.csv",
    );
    // The Authorization header carries the algorithm, the scoped credential, the
    // exact signed-header set, and a 64-hex signature.
    expect(signed.headers.get("Authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260823\/eu-central-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    // x-amz-content-sha256 is the real hash of the body, not UNSIGNED-PAYLOAD.
    expect(signed.headers.get("x-amz-content-sha256")).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.headers.get("x-amz-date")).toBe("20260823T000000Z");
    // A real clock is not midnight: its time of day reaches x-amz-date, its
    // milliseconds do not.
    const later = await sent(
      CONFIG,
      "exports/log.csv",
      body,
      "text/csv; charset=utf-8",
      "2026-08-23T11:22:33.444Z",
    );
    expect(later.headers.get("x-amz-date")).toBe("20260823T112233Z");

    // Signing the same inputs again is byte-identical (no clock/nonce inside).
    const again = await sent(
      CONFIG,
      "exports/log.csv",
      body,
      "text/csv; charset=utf-8",
      "2026-08-23T00:00:00.000Z",
    );
    expect(again.headers.get("Authorization")).toBe(signed.headers.get("Authorization"));
  });

  it("honors a prefix and a custom endpoint (S3-compatible store)", async () => {
    const signed = await sent(
      { ...CONFIG, prefix: "team/", endpoint: "https://minio.internal:9000/viberr-audit" },
      "log.json",
      Buffer.from("[]"),
      "application/json",
      "2026-08-23T00:00:00.000Z",
    );
    expect(signed.url).toBe("https://minio.internal:9000/viberr-audit/team/log.json");
    // F26-7: the path-style bucket prefix must be SIGNED, not just present in the
    // URL — otherwise the server 403s. Signing the same key against the same host
    // WITHOUT the `/viberr-audit` base path must produce a different signature; if
    // the base path were dropped from the canonical URI (the bug), these would be
    // byte-identical.
    const withoutBasePath = await sent(
      { ...CONFIG, prefix: "team/", endpoint: "https://minio.internal:9000" },
      "log.json",
      Buffer.from("[]"),
      "application/json",
      "2026-08-23T00:00:00.000Z",
    );
    expect(withoutBasePath.headers.get("Authorization")).not.toBe(
      signed.headers.get("Authorization"),
    );
  });

  it("changing the body changes the signature (payload is signed)", async () => {
    const a = await sent(CONFIG, "k", Buffer.from("A"), "text/plain", "2026-08-23T00:00:00.000Z");
    const b = await sent(CONFIG, "k", Buffer.from("B"), "text/plain", "2026-08-23T00:00:00.000Z");
    expect(a.headers.get("Authorization")).not.toBe(b.headers.get("Authorization"));
    expect(a.headers.get("x-amz-content-sha256")).not.toBe(
      b.headers.get("x-amz-content-sha256"),
    );
  });
});

describe("putObjectToS3", () => {
  it("PUTs the signed request and reports success", async () => {
    let seen: { url: string; method?: string; auth: string | null } | null = null;
    const fetchImpl: typeof fetch = async (url, init) => {
      seen = {
        url: String(url),
        method: init?.method,
        auth: new Headers(init?.headers).get("Authorization"),
      };
      return new Response("", { status: 200 });
    };

    const result = await putObjectToS3(CONFIG, "exports/log.csv", Buffer.from("x"), {
      contentType: "text/csv",
      isoNow: "2026-08-23T00:00:00.000Z",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(seen!.method).toBe("PUT");
    expect(seen!.auth).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("returns the S3 error body on a non-2xx rather than throwing", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    const result = await putObjectToS3(CONFIG, "k", Buffer.from("x"), {
      contentType: "text/plain",
      isoNow: "2026-08-23T00:00:00.000Z",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toContain("AccessDenied");
  });
});
