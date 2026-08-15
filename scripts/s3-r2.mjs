#!/usr/bin/env node
// AWS SigV4 and the handful of S3 verbs R2 needs, hand-implemented on node:crypto
// because an SDK's transitive tree is a worse risk on the release path than sixty
// lines of signing code. This module reports what R2 answered and never decides
// whether an answer is acceptable.
import { createHash, createHmac } from "node:crypto";
import { redactSecrets, redactedExcerpt } from "./publication-contract.mjs";

const ALGORITHM = "AWS4-HMAC-SHA256";
// host, the SigV4 headers, the conditional guard, and every header that becomes part
// of the permanent object: exactly the headers whose alteration in flight must
// invalidate the signature. Content-Length is set by the transport, so it is excluded.
const SIGNABLE = /^(?:host|if-none-match|if-match|cache-control|content-(?!length$)[a-z0-9-]+|x-amz-[a-z0-9-]+)$/;

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function md5Base64(bytes) {
  return createHash("md5").update(bytes).digest("base64");
}

function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function encodeObjectKey(key) {
  return String(key)
    .split("/")
    .map((segment) => encodeSegment(segment))
    .join("/");
}

export function r2Endpoint(accountId) {
  if (!/^[0-9a-f]{32}$/i.test(String(accountId ?? "")))
    throw new Error("a Cloudflare account ID is required to build the R2 S3 endpoint");
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function amzTimestamp(now) {
  return `${now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")}`;
}

export function signS3Request({
  method,
  url,
  headers = {},
  payloadSha256,
  accessKeyId,
  secretAccessKey,
  region = "auto",
  service = "s3",
  now = new Date(),
}) {
  if (!accessKeyId || !secretAccessKey) throw new Error("R2 credentials are required to sign a request");
  if (!/^[0-9a-f]{64}$/.test(payloadSha256 ?? "")) throw new Error("a payload SHA-256 is required to sign a request");
  const target = new URL(url);
  const amzDate = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = target.pathname
    .split("/")
    .map((segment) => encodeSegment(decodeURIComponent(segment)))
    .join("/");
  const canonicalQuery = [...target.searchParams.entries()]
    .map(([name, value]) => [encodeSegment(name), encodeSegment(value)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

  const candidates = {
    ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
    host: target.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadSha256,
  };
  const signable = Object.entries(candidates)
    .filter(([name, value]) => SIGNABLE.test(name) && value !== undefined && value !== null)
    .sort(([left], [right]) => (left < right ? -1 : 1));
  const signedHeaders = signable.map(([name]) => name).join(";");
  const canonicalHeaders = signable
    .map(([name, value]) => `${name}:${String(value).trim().replace(/\s+/g, " ")}\n`)
    .join("");

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadSha256].join(
    "\n",
  );
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
  const signingKey = [dateStamp, region, service, "aws4_request"].reduce(
    (key, step) => hmac(key, step),
    `AWS4${secretAccessKey}`,
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    // Every supplied header is sent; only the signable subset is covered by the
    // signature, so an unsignable header can never be silently dropped instead. Host
    // is signed but never sent: fetch derives it from the URL.
    headers: {
      ...Object.fromEntries(
        Object.entries(candidates)
          .filter(([name, value]) => name !== "host" && value !== undefined && value !== null)
          .map(([name, value]) => [name, String(value)]),
      ),
      authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
  };
}

function objectUrl({ endpoint, bucket, key }) {
  const base = String(endpoint).replace(/\/$/, "");
  if (bucket === undefined) return `${base}/`;
  return key === undefined
    ? `${base}/${encodeSegment(bucket)}`
    : `${base}/${encodeSegment(bucket)}/${encodeObjectKey(key)}`;
}

function plainHeaders(response) {
  return Object.fromEntries([...response.headers].map(([name, value]) => [name.toLowerCase(), value]));
}

async function bodyExcerpt(response, credentials) {
  try {
    return redactedExcerpt(await response.text(), [credentials?.secretAccessKey, credentials?.accessKeyId]);
  } catch {
    return "<response body unavailable>";
  }
}

async function send({
  method,
  endpoint,
  bucket,
  key,
  body,
  headers = {},
  credentials,
  fetchImpl = fetch,
  signal,
  now,
}) {
  const url = objectUrl({ endpoint, bucket, key });
  const payload = body ?? Buffer.alloc(0);
  const signed = signS3Request({
    method,
    url,
    headers,
    payloadSha256: sha256Hex(payload),
    accessKeyId: credentials?.accessKeyId,
    secretAccessKey: credentials?.secretAccessKey,
    now: now ? now() : new Date(),
  });
  try {
    return await fetchImpl(url, {
      method,
      headers: signed.headers,
      body: method === "GET" || method === "HEAD" || method === "DELETE" ? undefined : payload,
      signal,
    });
  } catch (error) {
    throw new Error(
      `R2 ${method} ${key ?? bucket ?? "/"} could not be reached: ${redactSecrets(error?.message ?? error, [
        credentials?.secretAccessKey,
        credentials?.accessKeyId,
      ])}`,
    );
  }
}

// Create-only: `If-None-Match: *` makes R2 refuse to replace an existing key, and
// `Content-MD5` makes it refuse a truncated upload. Reporting "exists" is not the same
// as accepting it; the caller must prove byte identity before continuing.
export async function putObjectCreateOnly({
  endpoint,
  bucket,
  key,
  body,
  headers = {},
  credentials,
  fetchImpl,
  signal,
  now,
}) {
  const response = await send({
    method: "PUT",
    endpoint,
    bucket,
    key,
    body,
    headers: { ...headers, "content-md5": md5Base64(body), "if-none-match": "*" },
    credentials,
    fetchImpl,
    signal,
    now,
  });
  if (response.ok) return { outcome: "created", status: response.status, headers: plainHeaders(response) };
  if (response.status === 412 || response.status === 409)
    return {
      outcome: "exists",
      status: response.status,
      headers: plainHeaders(response),
      detail: await bodyExcerpt(response, credentials),
    };
  throw new Error(
    `R2 create-only PUT of ${key} failed with HTTP ${response.status}: ${await bodyExcerpt(response, credentials)}`,
  );
}

export async function getObject({ endpoint, bucket, key, credentials, fetchImpl, signal, now }) {
  const response = await send({ method: "GET", endpoint, bucket, key, credentials, fetchImpl, signal, now });
  const headers = plainHeaders(response);
  if (!response.ok)
    return { status: response.status, bytes: null, headers, detail: await bodyExcerpt(response, credentials) };
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()), headers };
}

export async function headObject({ endpoint, bucket, key, credentials, fetchImpl, signal, now }) {
  const response = await send({ method: "HEAD", endpoint, bucket, key, credentials, fetchImpl, signal, now });
  return { status: response.status, headers: plainHeaders(response) };
}

export async function headBucket({ endpoint, bucket, credentials, fetchImpl, signal, now }) {
  const response = await send({ method: "HEAD", endpoint, bucket, credentials, fetchImpl, signal, now });
  return { status: response.status };
}

// A credential scoped to one bucket is denied here, and that denial is itself the
// evidence preflight wants: the caller reads `denied` as "correctly scoped".
export async function listBuckets({ endpoint, credentials, fetchImpl, signal, now }) {
  const response = await send({ method: "GET", endpoint, credentials, fetchImpl, signal, now });
  if (response.status === 403) return { denied: true, status: response.status, buckets: null };
  if (!response.ok)
    throw new Error(`R2 ListBuckets failed with HTTP ${response.status}: ${await bodyExcerpt(response, credentials)}`);
  const xml = await response.text();
  return {
    denied: false,
    status: response.status,
    buckets: [...xml.matchAll(/<Name>([^<]*)<\/Name>/g)].map((m) => m[1]),
  };
}

export async function deleteObject({ endpoint, bucket, key, credentials, fetchImpl, signal, now }) {
  const response = await send({ method: "DELETE", endpoint, bucket, key, credentials, fetchImpl, signal, now });
  if (!response.ok && response.status !== 404)
    throw new Error(
      `R2 DELETE of ${key} failed with HTTP ${response.status}: ${await bodyExcerpt(response, credentials)}`,
    );
  return { status: response.status };
}
