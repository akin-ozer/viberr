import { describe, expect, it } from "vitest";
import {
  canonicalKeyPath,
  canonicalRequestUri,
  putObjectToS3,
  sigV4Dates,
  signS3Put,
  signingKey,
  type S3Config,
} from "./s3-put.server";

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

describe("sigV4Dates", () => {
  it("splits an ISO instant into amzDate + dateStamp", () => {
    expect(sigV4Dates("2026-08-23T11:22:33.444Z")).toEqual({
      amzDate: "20260823T112233Z",
      dateStamp: "20260823",
    });
  });
});

describe("canonicalKeyPath", () => {
  it("keeps slashes as separators and percent-encodes segments", () => {
    expect(canonicalKeyPath("audit/2026/exports/log 1.csv")).toBe(
      "/audit/2026/exports/log%201.csv",
    );
    expect(canonicalKeyPath("a+b/c&d")).toBe("/a%2Bb/c%26d");
  });
});

// F26-7: the canonical URI must include any base path the endpoint carries, or a
// path-style S3-compatible store (MinIO/Ceph) signs a different path than it
// receives and rejects every push with SignatureDoesNotMatch.
describe("canonicalRequestUri", () => {
  it("is just the key path for a root (virtual-hosted) endpoint", () => {
    expect(canonicalRequestUri("/", "exports/log.csv")).toBe(
      "/exports/log.csv",
    );
    expect(canonicalRequestUri("", "exports/log.csv")).toBe("/exports/log.csv");
  });
  it("folds a path-style bucket prefix into the signed path", () => {
    expect(canonicalRequestUri("/viberr-audit", "team/log.json")).toBe(
      "/viberr-audit/team/log.json",
    );
  });
  it("re-encodes a base path exactly once (no double-encoding)", () => {
    expect(canonicalRequestUri("/my%20bucket", "k.csv")).toBe(
      "/my%20bucket/k.csv",
    );
  });
});

const CONFIG: S3Config = {
  bucket: "viberr-audit",
  region: "eu-central-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secretExampleKey",
};

describe("signS3Put", () => {
  it("produces a deterministic, well-formed signed request", () => {
    const body = Buffer.from("id,action\r\n1,task.created\r\n");
    const signed = signS3Put(CONFIG, "exports/log.csv", body, {
      contentType: "text/csv; charset=utf-8",
      isoNow: "2026-08-23T00:00:00.000Z",
    });
    expect(signed.url).toBe(
      "https://viberr-audit.s3.eu-central-1.amazonaws.com/exports/log.csv",
    );
    // The Authorization header carries the algorithm, the scoped credential, the
    // exact signed-header set, and a 64-hex signature.
    expect(signed.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260823\/eu-central-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    // x-amz-content-sha256 is the real hash of the body, not UNSIGNED-PAYLOAD.
    expect(signed.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.headers["x-amz-date"]).toBe("20260823T000000Z");

    // Signing the same inputs again is byte-identical (no clock/nonce inside).
    const again = signS3Put(CONFIG, "exports/log.csv", body, {
      contentType: "text/csv; charset=utf-8",
      isoNow: "2026-08-23T00:00:00.000Z",
    });
    expect(again.headers.Authorization).toBe(signed.headers.Authorization);
  });

  it("honors a prefix and a custom endpoint (S3-compatible store)", () => {
    const signed = signS3Put(
      { ...CONFIG, prefix: "team/", endpoint: "https://minio.internal:9000/viberr-audit" },
      "log.json",
      Buffer.from("[]"),
      { contentType: "application/json", isoNow: "2026-08-23T00:00:00.000Z" },
    );
    expect(signed.url).toBe("https://minio.internal:9000/viberr-audit/team/log.json");
    // F26-7: the path-style bucket prefix must be SIGNED, not just present in the
    // URL — otherwise the server 403s. Signing the same key against the same host
    // WITHOUT the `/viberr-audit` base path must produce a different signature; if
    // the base path were dropped from the canonical URI (the bug), these would be
    // byte-identical.
    const withoutBasePath = signS3Put(
      { ...CONFIG, prefix: "team/", endpoint: "https://minio.internal:9000" },
      "log.json",
      Buffer.from("[]"),
      { contentType: "application/json", isoNow: "2026-08-23T00:00:00.000Z" },
    );
    expect(withoutBasePath.headers.Authorization).not.toBe(
      signed.headers.Authorization,
    );
  });

  it("changing the body changes the signature (payload is signed)", () => {
    const a = signS3Put(CONFIG, "k", Buffer.from("A"), {
      contentType: "text/plain",
      isoNow: "2026-08-23T00:00:00.000Z",
    });
    const b = signS3Put(CONFIG, "k", Buffer.from("B"), {
      contentType: "text/plain",
      isoNow: "2026-08-23T00:00:00.000Z",
    });
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
    expect(a.headers["x-amz-content-sha256"]).not.toBe(
      b.headers["x-amz-content-sha256"],
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
