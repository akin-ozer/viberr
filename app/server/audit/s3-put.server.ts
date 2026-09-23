import { createHmac } from "node:crypto";
import { sha256Hex } from "~/server/files/content-hash.server";

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

/**
 * F26-7: the canonical URI for a request, folding in any BASE PATH the endpoint
 * carries.
 *
 * A path-style S3-compatible endpoint (MinIO/Ceph default, `https://host:9000/
 * bucket`) puts the bucket — or any base prefix — in the endpoint's path. That
 * path rides into the real request URL (`origin + key`), so the SIGNED canonical
 * URI must include it too, or every push fails `SignatureDoesNotMatch` (the
 * server signs `/bucket/key`, we signed `/key`). The default AWS virtual-hosted
 * endpoint has an empty path, so this is a no-op there.
 *
 * `basePath` comes off `URL.pathname` (already percent-encoded), so its segments
 * are DECODED before re-encoding, exactly once, to match `encodeSegment`'s rule.
 */
export function canonicalRequestUri(basePath: string, key: string): string {
  const baseSegments = basePath
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeSegment(decodeURIComponent(seg)));
  const keySegments = key.split("/").map((seg) => encodeSegment(seg));
  return "/" + [...baseSegments, ...keySegments].join("/");
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
  // Region case matters: it is part of the credential SCOPE the server rebuilds,
  // so a mixed-case region signs a scope the server never forms (F26-11).
  const region = config.region.toLowerCase();
  const origin =
    config.endpoint ??
    `https://${config.bucket}.${SERVICE}.${region}.amazonaws.com`;
  const originUrl = new URL(origin);
  const host = originUrl.host;
  const fullKey = `${config.prefix ?? ""}${objectKey}`.replace(/^\/+/, "");
  // F26-7: fold the endpoint's base path (e.g. `/bucket` for a path-style store)
  // into the canonical URI so the signature covers the SAME path the request URL
  // carries. Empty for the default virtual-hosted endpoint.
  const canonicalUri = canonicalRequestUri(originUrl.pathname, fullKey);
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

  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = createHmac(
    "sha256",
    signingKey(config.secretAccessKey, dateStamp, region),
  )
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization =
    `${ALGORITHM} Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    // Build from protocol + host + the (base-path-inclusive) canonical URI, NOT
    // `origin + canonicalUri`: the canonical URI now already carries the endpoint's
    // base path, so concatenating it onto `origin` (which also has that path) would
    // double it.
    url: `${originUrl.protocol}//${host}${canonicalUri}`,
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
