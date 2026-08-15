#!/usr/bin/env node
// R2 access through the AWS CLI, which is preinstalled on GitHub runners and already
// speaks S3 conditional writes. This module knows nothing about releases: it reports
// what R2 answered and never decides whether an answer is acceptable.
//
// Credentials are passed to the child process through its environment, never through
// argv, so they cannot appear in a process listing or in a workflow log.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { redactSecrets, redactedExcerpt } from "./publication-contract.mjs";

export const AWS_BIN = "aws";

export function md5Base64(bytes) {
  return createHash("md5").update(bytes).digest("base64");
}

export function r2Endpoint(accountId) {
  if (!/^[0-9a-f]{32}$/i.test(String(accountId ?? "")))
    throw new Error("a Cloudflare account ID is required to build the R2 S3 endpoint");
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export function commandEnvironment({ credentials, endpoint, env = process.env }) {
  return {
    ...env,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_DEFAULT_REGION: "auto",
    AWS_ENDPOINT_URL: endpoint,
    // aws-cli v2 adds a CRC32 checksum to every upload by default, which R2 rejects.
    // The integrity check that matters here is the Content-MD5 sent with the object.
    AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
    AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
    AWS_PAGER: "",
  };
}

// Unlike a throwing runner, this one reports a non-zero exit: a rejected conditional
// write is an expected answer, not a crash, and only the caller can tell them apart.
export function commandRunner(args, { env, signal } = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(AWS_BIN, args, { env, signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      fail(new Error(`the aws CLI could not be started: ${error.message}; it must be installed on this runner`)),
    );
    child.on("close", (code) => ok({ code: code ?? 1, stdout, stderr }));
  });
}

async function invoke(args, { credentials, endpoint, run = commandRunner, signal }) {
  return run(args, { env: commandEnvironment({ credentials, endpoint }), signal });
}

function failure(action, result, credentials) {
  const detail = redactedExcerpt(`${result.stderr}${result.stdout}`, [
    credentials?.secretAccessKey,
    credentials?.accessKeyId,
  ]);
  return new Error(`${action} failed (aws exited ${result.code}): ${detail}`);
}

const REJECTED = /PreconditionFailed|412|ConditionalRequestConflict/i;
const ABSENT = /NoSuchKey|NoSuchBucket|Not Found|404/i;
const DENIED = /AccessDenied|InvalidAccessKeyId|403/i;

function parseJson(action, source) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${action} returned output that is not JSON`);
  }
}

function describedMetadata(described) {
  return {
    httpMetadata: {
      "content-type": described.ContentType,
      "content-disposition": described.ContentDisposition,
      "cache-control": described.CacheControl,
    },
    metadata: described.Metadata ?? {},
    size: described.ContentLength,
  };
}

// Create-only: `If-None-Match: *` makes R2 refuse to replace an existing key, and
// `Content-MD5` makes it refuse a truncated upload. Reporting "exists" is not the
// same as accepting it; the caller must prove byte identity before continuing.
export async function putObjectCreateOnly({
  endpoint,
  bucket,
  key,
  bodyPath,
  contentMd5,
  httpMetadata,
  metadata,
  credentials,
  run,
  signal,
}) {
  const result = await invoke(
    [
      "s3api",
      "put-object",
      "--bucket",
      bucket,
      "--key",
      key,
      "--body",
      bodyPath,
      "--if-none-match",
      "*",
      "--content-md5",
      contentMd5,
      "--content-type",
      httpMetadata["content-type"],
      "--content-disposition",
      httpMetadata["content-disposition"],
      "--cache-control",
      httpMetadata["cache-control"],
      "--metadata",
      JSON.stringify(metadata),
    ],
    { credentials, endpoint, run, signal },
  );
  if (result.code === 0) return { outcome: "created" };
  if (REJECTED.test(result.stderr)) return { outcome: "exists" };
  throw failure(`R2 create-only put of ${key}`, result, credentials);
}

export async function getObject({ endpoint, bucket, key, credentials, run, signal }) {
  const directory = await mkdtemp(resolve(tmpdir(), "sqlc-d1-r2-"));
  const download = resolve(directory, "object");
  try {
    const result = await invoke(["s3api", "get-object", "--bucket", bucket, "--key", key, download], {
      credentials,
      endpoint,
      run,
      signal,
    });
    if (result.code !== 0) {
      if (ABSENT.test(result.stderr)) return { status: 404, bytes: null };
      throw failure(`R2 get of ${key}`, result, credentials);
    }
    return {
      status: 200,
      bytes: await readFile(download),
      ...describedMetadata(parseJson(`R2 get of ${key}`, result.stdout)),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function headObject({ endpoint, bucket, key, credentials, run, signal }) {
  const result = await invoke(["s3api", "head-object", "--bucket", bucket, "--key", key], {
    credentials,
    endpoint,
    run,
    signal,
  });
  if (result.code === 0) return { status: 200, ...describedMetadata(parseJson(`R2 head of ${key}`, result.stdout)) };
  if (ABSENT.test(result.stderr)) return { status: 404 };
  throw failure(`R2 head of ${key}`, result, credentials);
}

export async function headBucket({ endpoint, bucket, credentials, run, signal }) {
  const result = await invoke(["s3api", "head-bucket", "--bucket", bucket], { credentials, endpoint, run, signal });
  if (result.code === 0) return { status: 200 };
  if (ABSENT.test(result.stderr)) return { status: 404 };
  if (DENIED.test(result.stderr)) return { status: 403 };
  throw failure(`R2 head of bucket ${bucket}`, result, credentials);
}

// A credential scoped to one bucket is denied here, and that denial is itself the
// evidence preflight wants: the caller reads `denied` as "correctly scoped".
export async function listBuckets({ endpoint, credentials, run, signal }) {
  const result = await invoke(["s3api", "list-buckets"], { credentials, endpoint, run, signal });
  if (result.code !== 0) {
    if (DENIED.test(result.stderr)) return { denied: true, buckets: null };
    throw failure("R2 list-buckets", result, credentials);
  }
  const listed = parseJson("R2 list-buckets", result.stdout);
  return { denied: false, buckets: (listed.Buckets ?? []).map(({ Name }) => Name) };
}

export async function deleteObject({ endpoint, bucket, key, credentials, run, signal }) {
  const result = await invoke(["s3api", "delete-object", "--bucket", bucket, "--key", key], {
    credentials,
    endpoint,
    run,
    signal,
  });
  if (result.code !== 0 && !ABSENT.test(result.stderr)) throw failure(`R2 delete of ${key}`, result, credentials);
  return { status: result.code === 0 ? 204 : 404 };
}

export async function awsVersion({ run = commandRunner } = {}) {
  const result = await run(["--version"], { env: process.env });
  return redactSecrets(`${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "unknown", []);
}
