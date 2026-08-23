import { createHash, createHmac } from "node:crypto";

/**
 * Minimal AWS Signature Version 4 signer for a single S3 PUT — enough to stream
 * an audit export to a bucket with NO aws-sdk dependency (the SDK is ~20 MB of
 * transitive deps for one signed request). Virtual-hosted-style by default;
 * `endpoint` overrides for S3-compatible stores (MinIO, R2, …).
 *
 * The signing primitives are pure and exported so the KAT test can pin the
 * HMAC chain against AWS's published signing-key vector.
 */

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional key prefix (folder) — "audit/" style, joined with the object key. */
  prefix?: string;
  /** Override the host origin for an S3-compatible endpoint (no trailing slash).
   *  Default: https://<bucket>.s3.<region>.amazonaws.com */
  endpoint?: string;
}

const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * The SigV4 signing key: HMAC chain over "AWS4"+secret → date → region →
 * service → "aws4_request". Exported for the known-answer test.
 */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string = SERVICE,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** Percent-encode one path SEGMENT per RFC 3986 (S3's canonical URI rule).
 *  Slashes are handled by the caller splitting the key — they are separators. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The canonical (encoded) URI path for an object key, keeping "/" separators. */
export function canonicalKeyPath(key: string): string {
  return (
    "/" +
    key
      .split("/")
      .map((seg) => encodeSegment(seg))
      .join("/")
  );
}

/** The two time forms SigV4 needs, from an ISO instant. */
export interface SigV4Dates {
  /** YYYYMMDDTHHMMSSZ */
  amzDate: string;
  /** YYYYMMDD */
  dateStamp: string;
}

/** Split an ISO instant into the amzDate + dateStamp SigV4 needs. */
export function sigV4Dates(iso: string): SigV4Dates {
  // 2026-08-23T11:22:33.444Z → 20260823T112233Z
  const compact = iso.replace(/[-:]/g, "").replace(/\.\d+/, "");
  const amzDate = compact.endsWith("Z") ? compact : `${compact}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Build a signed S3 PUT request (url + headers) for an object key and body. The
 * `amzDate` is injected (not read from a clock) so the signature is deterministic
 * and testable; callers pass `new Date().toISOString()`.
 */
export function signS3Put(
  config: S3Config,
  objectKey: string,
  body: Buffer,
  opts: { contentType: string; isoNow: string },
): SignedRequest {
  const { amzDate, dateStamp } = sigV4Dates(opts.isoNow);
  const origin =
    config.endpoint ??
    `https://${config.bucket}.${SERVICE}.${config.region}.amazonaws.com`;
  const host = new URL(origin).host;
  const fullKey = `${config.prefix ?? ""}${objectKey}`.replace(/^\/+/, "");
  const canonicalUri = canonicalKeyPath(fullKey);
  const payloadHash = sha256Hex(body);

  // Canonical headers are sorted, lowercase, with trimmed values. These four are
  // the ones we sign (and send); content-type is signed so a proxy can't swap it.
  // Built as sorted [name, value] pairs (not a dictionary) so no dynamic string
  // index is needed to serialize them.
  const headerPairs: [string, string][] = [
    ["content-type", opts.contentType],
    ["host", host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate],
  ];
  headerPairs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const signedHeaders = headerPairs.map(([name]) => name).join(";");
  const canonicalHeaders = headerPairs
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = createHmac(
    "sha256",
    signingKey(config.secretAccessKey, dateStamp, config.region),
  )
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization =
    `${ALGORITHM} Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `${origin}${canonicalUri}`,
    headers: {
      "Content-Type": opts.contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: authorization,
    },
  };
}

export interface S3PutResult {
  ok: boolean;
  status: number;
  url: string;
  /** S3 error body text on failure (empty on success). */
  error: string;
}

/**
 * Sign and PUT a body to S3. Network I/O via fetch; a non-2xx is returned (not
 * thrown) with the S3 error body so the caller can surface it to the admin.
 *
 * `fetchImpl` is injectable so a test drives it without a real bucket.
 */
export async function putObjectToS3(
  config: S3Config,
  objectKey: string,
  body: Buffer,
  opts: { contentType: string; isoNow: string; fetchImpl?: typeof fetch },
): Promise<S3PutResult> {
  const signed = signS3Put(config, objectKey, body, opts);
  const doFetch = opts.fetchImpl ?? fetch;
  // fetch's BodyInit lists a concrete-ArrayBuffer view, not Node's Buffer nor a
  // Buffer's ArrayBufferLike-backed view; `Uint8Array.from` gives a fresh
  // ArrayBuffer-backed copy that satisfies it. Exports are small (one string).
  const bytes = Uint8Array.from(body);
  const res = await doFetch(signed.url, {
    method: "PUT",
    headers: signed.headers,
    body: bytes,
  });
  const error = res.ok ? "" : await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, url: signed.url, error };
}
