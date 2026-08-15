#!/usr/bin/env node
// The only module that owns order of operations. Everything permanent happens here in
// one sequence, and the sequence is the safety property: the R2 version key is written
// once, every surface is downloaded and hashed independently, and the GitHub Release —
// the moment a version becomes publicly advertised — is the last write of all.
//
// Credentials arrive through the environment only, never as arguments, so they cannot
// appear in a process listing or a workflow log.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalManifestFilename, validateCandidateBundle } from "./release-contract.mjs";
import {
  R2_BUCKET,
  annotation,
  assertBodyAgreesWithManifest,
  assertHttpMetadata,
  buildReleaseBody,
  canonicalObjectKey,
  createPublicationRecord,
  isVersionKey,
  objectHttpMetadata,
  objectUserMetadata,
  publicUrlForKey,
  redactSecrets,
  rehearsalObjectKey,
  validatePublicationRecord,
  writePublicationJson,
} from "./publication-contract.mjs";
import {
  commandRunner,
  deleteObject,
  getObject,
  headBucket,
  headObject,
  listBuckets,
  md5Base64,
  putObjectCreateOnly,
  r2Endpoint,
} from "./r2-cli.mjs";
import {
  createDraftRelease,
  deleteRelease,
  deleteReleaseAsset,
  downloadReleaseAsset,
  findDraftRelease,
  getImmutableReleases,
  getRelease,
  listReleaseAssets,
  publishRelease,
  resolveTagCommit,
  uploadReleaseAsset,
} from "./github-release-api.mjs";

export const ENVIRONMENT = "release-publication";
const PUBLIC_ATTEMPTS = 30;
const PUBLIC_INTERVAL_MS = 2_000;
const READ_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;
const FAILURE_DETAIL_LIMIT = 2000;
const ABSENT_PROBE_KEY = "plugins/publication-preflight-probe-absent.wasm";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readTimeout = () => AbortSignal.timeout(READ_TIMEOUT_MS);
const uploadTimeout = () => AbortSignal.timeout(UPLOAD_TIMEOUT_MS);

export function credentialsFromEnvironment(env = process.env) {
  return {
    githubToken: env.GITHUB_TOKEN ?? "",
    accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
    accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "",
  };
}

function assertCredentials(credentials) {
  const missing = [
    ["GITHUB_TOKEN", credentials?.githubToken],
    ["R2_ACCESS_KEY_ID", credentials?.accessKeyId],
    ["R2_SECRET_ACCESS_KEY", credentials?.secretAccessKey],
    ["CLOUDFLARE_ACCOUNT_ID", credentials?.accountId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length)
    throw new Error(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} empty; add the missing secret or variable to the ${ENVIRONMENT} environment`,
    );
}

function reporter({ logger = (line) => process.stdout.write(`${line}\n`), credentials } = {}) {
  const secrets = [credentials?.secretAccessKey, credentials?.githubToken, credentials?.accessKeyId];
  const clean = (message) => redactSecrets(message, secrets);
  return {
    clean,
    say: (message) => logger(`==> ${clean(message)}`),
    note: (message) => {
      for (const line of clean(message).split("\n")) logger(`    ${line}`);
    },
    annotate: (message) => logger(annotation(clean(message))),
  };
}

// The one sentence an operator needs: which side of the permanent boundary this
// failure landed on, and therefore what they may safely do next.
export function recoveryGuidance({ mode = "publish", version, tag, key, digest, keyExists, published }) {
  if (published)
    return "the GitHub Release is published and immutable; do not delete the tag, assets, or R2 object. Add a superseded notice to the release notes and publish a corrected version.";
  if (mode === "dry-run")
    return `this was a dry run: the rehearsal key ${key} and the draft release are removed by teardown, and no version was consumed.`;
  if (keyExists)
    return `R2 key ${key} exists and is permanent. Version ${version} is bound to SHA-256 ${digest}. Rerun this workflow run to resume with the retained candidate; changed bytes require a new version. Do not delete or overwrite the object.`;
  return `no R2 version key exists for ${version}; the version is still free. Delete tag ${tag ?? `v${version}`}, fix the cause, and recreate the tag.`;
}

export async function preflightPublication({
  repository,
  intent,
  credentials,
  fetchImpl = fetch,
  run = commandRunner,
  logger,
  now = () => new Date(),
  output,
}) {
  const { say, note, annotate, clean } = reporter({ logger, credentials });
  say(`[preflight] Proving the publication surfaces are configured for ${repository}`);
  assertCredentials(credentials);

  const endpoint = r2Endpoint(credentials.accountId);
  const r2Options = () => ({ endpoint, credentials, run, signal: readTimeout() });
  const checks = [];
  const check = async (name, probe) => {
    try {
      const result = await probe();
      checks.push({ name, status: result.status, detail: result.detail });
      note(`${result.status.padEnd(14)} ${name}: ${result.detail}`);
      return result;
    } catch (error) {
      const detail = clean(String(error?.message ?? error)).slice(0, FAILURE_DETAIL_LIMIT);
      checks.push({ name, status: "failed", detail });
      note(`${"failed".padEnd(14)} ${name}: ${detail}`);
      return { status: "failed", detail };
    }
  };

  const immutable = await check("immutable-releases", async () => {
    const setting = await getImmutableReleases({ repository, token: credentials.githubToken, fetchImpl });
    if (!setting.enabled)
      throw new Error(
        `immutable releases are disabled; enable them with "gh api -X PUT repos/${repository}/immutable-releases" before publishing`,
      );
    return { status: "passed", detail: `enabled (enforced by owner: ${setting.enforced_by_owner})`, setting };
  });

  await check("environment-ref-policy", async () => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/environments/${ENVIRONMENT}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${credentials.githubToken}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: readTimeout(),
    });
    if (!response.ok)
      // The REST surface may be unavailable to a job-scoped token; that is not a
      // negative answer, and the manual audit checklist covers it.
      return { status: "not-verifiable", detail: `the environments API answered HTTP ${response.status}` };
    const environment = await response.json();
    if (environment?.deployment_branch_policy === null)
      throw new Error(
        `the ${ENVIRONMENT} environment accepts deployments from any ref; restrict it to branch main and tag v*`,
      );
    return { status: "passed", detail: "deployment refs are restricted" };
  });

  await check("r2-credential-scope", async () => {
    const listed = await listBuckets(r2Options());
    if (listed.denied) return { status: "passed", detail: "ListBuckets is denied, so the credential is bucket-scoped" };
    const foreign = (listed.buckets ?? []).filter((bucket) => bucket !== R2_BUCKET);
    if (foreign.length)
      throw new Error(
        `the R2 credential can see ${foreign.length} bucket(s) beyond ${R2_BUCKET}; reissue it with Object Read & Write on ${R2_BUCKET} only`,
      );
    if (!(listed.buckets ?? []).includes(R2_BUCKET))
      throw new Error(`the R2 credential cannot see the ${R2_BUCKET} bucket`);
    return { status: "passed", detail: `the credential sees only ${R2_BUCKET}` };
  });

  await check("r2-bucket", async () => {
    const { status } = await headBucket({ ...r2Options(), bucket: R2_BUCKET });
    if (status !== 200)
      throw new Error(`the ${R2_BUCKET} bucket answered HTTP ${status}; confirm the bucket name and the token scope`);
    return { status: "passed", detail: `bucket ${R2_BUCKET} is reachable` };
  });

  await check("public-origin", async () => {
    const url = publicUrlForKey(ABSENT_PROBE_KEY);
    const response = await fetchImpl(url, { signal: readTimeout() });
    if (response.status === 200)
      throw new Error(
        `the public origin served ${url}, which must not exist; the custom domain may map to another bucket`,
      );
    if (response.status >= 500)
      throw new Error(`the public origin answered HTTP ${response.status}; the custom domain is not healthy`);
    return { status: "passed", detail: `answers HTTP ${response.status} for a known-absent key` };
  });

  const versionKey = canonicalObjectKey(intent.version);
  await check("version-key", async () => {
    const { status } = await headObject({ ...r2Options(), bucket: R2_BUCKET, key: versionKey });
    if (status === 404)
      return { status: "passed", detail: `${versionKey} does not exist; version ${intent.version} is free` };
    if (status === 200)
      return {
        status: "passed",
        detail: `${versionKey} already exists; publication will continue only if its bytes are identical`,
      };
    throw new Error(`probing ${versionKey} answered HTTP ${status}`);
  });

  const failed = checks.filter(({ status }) => status === "failed");
  const result = {
    schemaVersion: 1,
    repository,
    environment: ENVIRONMENT,
    version: intent.version,
    checkedAt: now().toISOString(),
    status: failed.length ? "failed" : "passed",
    checks,
  };
  if (output) await writePublicationJson(output, result);
  if (failed.length) {
    for (const check of failed) annotate(`publication preflight failed: ${check.name}: ${check.detail}`);
    const error = new Error(`publication preflight failed: ${failed.map(({ name }) => name).join(", ")}`);
    error.preflight = result;
    throw error;
  }
  say(`[preflight] Every publication surface is configured; nothing was written`);
  return { ...result, immutableReleases: immutable.setting ?? { enabled: false, enforced_by_owner: false } };
}

async function removeRehearsalResources({ state, credentials, fetchImpl, run, logger }) {
  const { say, note } = reporter({ logger, credentials });
  const outcome = {
    object: state.object?.status === "created" ? "failed" : "not-created",
    draft: state.draft?.status === "created" ? "failed" : "not-created",
  };
  const endpoint = r2Endpoint(credentials.accountId);
  say(`[teardown] Removing the rehearsal surfaces this dry run created`);

  if (state.object?.status === "created") {
    if (isVersionKey(state.object.key))
      throw new Error(`teardown refuses to delete version key ${state.object.key}; a version key is permanent`);
    try {
      await deleteObject({
        endpoint,
        bucket: state.object.bucket,
        key: state.object.key,
        credentials,
        run,
        signal: readTimeout(),
      });
      const { status } = await headObject({
        endpoint,
        bucket: state.object.bucket,
        key: state.object.key,
        credentials,
        run,
        signal: readTimeout(),
      });
      outcome.object = status === 404 ? "deleted" : "failed";
    } catch {
      outcome.object = "failed";
    }
  }

  if (state.draft?.status === "created") {
    try {
      await deleteRelease({
        repository: state.repository,
        releaseId: state.draft.id,
        token: credentials.githubToken,
        fetchImpl,
        signal: readTimeout(),
      });
      outcome.draft = "deleted";
    } catch {
      outcome.draft = "failed";
    }
  }
  note(`rehearsal object ${outcome.object}, draft release ${outcome.draft}`);
  return outcome;
}

export async function teardownPublication({
  statePath,
  credentials,
  fetchImpl = fetch,
  run = commandRunner,
  logger,
  reportPath,
}) {
  const state = JSON.parse(await readFile(resolve(statePath), "utf8"));
  if (state.mode !== "dry-run")
    throw new Error(
      `teardown refuses to act on a ${state.mode} publication: a published version and its artifacts are permanent and must never be deleted`,
    );
  assertCredentials(credentials);
  const teardown = await removeRehearsalResources({ state, credentials, fetchImpl, run, logger });
  const report = {
    schemaVersion: 1,
    mode: state.mode,
    resources: { draft: state.draft, object: state.object },
    teardown,
  };
  if (reportPath) await writePublicationJson(reportPath, report);
  return report;
}

export async function publishPublication(options) {
  const {
    repository,
    intent,
    candidateDir,
    manifestPath,
    notes = "",
    artifactId = null,
    credentials,
    fetchImpl = fetch,
    run = commandRunner,
    now = () => new Date(),
    delay = (milliseconds) => new Promise((ok) => setTimeout(ok, milliseconds)),
    logger,
    recordPath,
    statePath,
    mode = "publish",
    publicAttempts = PUBLIC_ATTEMPTS,
    publicIntervalMs = PUBLIC_INTERVAL_MS,
    root = process.cwd(),
  } = options;
  const { say, note, annotate, clean } = reporter({ logger, credentials });

  if (mode !== "publish" && mode !== "dry-run") throw new Error(`unsupported publication mode ${mode}`);
  if ((mode === "dry-run") !== Boolean(intent.dryRun))
    throw new Error(`mode ${mode} disagrees with the validated release intent (dryRun: ${intent.dryRun})`);
  assertCredentials(credentials);

  const candidate = await validateCandidateBundle({ directory: candidateDir, intent });
  const candidatePath = resolve(candidateDir, candidate.filename);
  const candidateBytes = await readFile(candidatePath);
  const manifestBytes = await readFile(resolve(manifestPath));
  const manifestName = canonicalManifestFilename(intent.version);
  if (basename(manifestPath) !== manifestName)
    throw new Error(`the manifest must be named ${manifestName}, received ${basename(manifestPath)}`);
  const manifestSha256 = sha256(manifestBytes);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("the release manifest is malformed JSON");
  }
  for (const [field, expected, actual] of [
    ["artifact.sha256", candidate.sha256, manifest.artifact?.sha256],
    ["artifact.size", candidate.size, manifest.artifact?.size],
    ["version", intent.version, manifest.version],
    ["tag", intent.tag, manifest.tag],
    ["dry_run", intent.dryRun, manifest.dry_run],
  ])
    if (expected !== actual)
      throw new Error(`the manifest ${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

  const key =
    mode === "dry-run" ? rehearsalObjectKey(intent.version, intent.workflowRunId) : canonicalObjectKey(intent.version);
  const tagName = mode === "dry-run" ? `dry-run-v${intent.version}-${intent.workflowRunId}` : intent.tag;
  const prerelease = intent.version.includes("-");
  const endpoint = r2Endpoint(credentials.accountId);
  const bucketOptions = { endpoint, bucket: R2_BUCKET, credentials, run };
  const githubOptions = { repository, token: credentials.githubToken, fetchImpl };

  const body = buildReleaseBody({ manifest, intent, notes, manifestSha256 });
  assertBodyAgreesWithManifest(body, manifest, { manifestSha256 });

  let state = {
    schemaVersion: 1,
    mode,
    repository,
    draft: { status: "not-created" },
    object: { status: "not-created", bucket: R2_BUCKET, key },
  };
  await writePublicationJson(statePath, state);

  const r2Record = {
    bucket: R2_BUCKET,
    key,
    outcome: "not-created",
    http_metadata: null,
    metadata_sha256: null,
    direct_download_sha256: null,
    public_url: publicUrlForKey(key),
    public_download_sha256: null,
    public_attempts: 0,
  };
  const githubRecord = {
    release_id: null,
    release_url: null,
    tag_name: tagName,
    prerelease,
    draft_outcome: "not-created",
    asset_sha256: { wasm: null, manifest: null },
    published: false,
    immutable_releases: { enabled: false, enforced_by_owner: false },
  };

  const order = [];
  let phase = "preflight";
  const enter = (next, message) => {
    phase = next;
    order.push({ phase: next, at: now().toISOString() });
    say(`[${next}] ${message}`);
  };

  let verifiedSha256 = null;
  // Distinct from r2Record.outcome: the key can be occupied by bytes this run refuses
  // to accept, and the recovery an operator needs depends on occupancy, not outcome.
  let keyExists = false;
  let failure;
  let teardown = { object: "not-created", draft: "not-created" };

  try {
    enter("preflight", `Re-asserting the publication surfaces before writing anything (mode: ${mode})`);
    const preflight = await preflightPublication({ repository, intent, credentials, fetchImpl, run, logger, now });
    githubRecord.immutable_releases = preflight.immutableReleases;

    enter("draft-release", `Creating or reusing the draft release for ${tagName}`);
    const existing = await findDraftRelease({ ...githubOptions, tagName, signal: readTimeout() });
    let release;
    if (existing) {
      if (!existing.draft)
        throw new Error(
          `release ${tagName} is already published; a published release is immutable and this run must not touch it`,
        );
      if ((existing.body ?? "") !== body)
        throw new Error(
          `the existing draft for ${tagName} carries a different body than this run would publish; inspect it by hand before retrying`,
        );
      release = existing;
      githubRecord.draft_outcome = "reused";
      note(`reusing draft release ${release.id} with a byte-identical body`);
    } else {
      release = await createDraftRelease({
        ...githubOptions,
        tagName,
        targetCommitish: intent.sourceCommit,
        name: tagName,
        body,
        prerelease,
        signal: readTimeout(),
      });
      githubRecord.draft_outcome = "created";
      note(`created draft release ${release.id}`);
    }
    githubRecord.release_id = String(release.id);
    githubRecord.release_url = release.html_url ?? null;
    state = { ...state, draft: { status: "created", id: String(release.id) } };
    await writePublicationJson(statePath, state);

    const wanted = [
      {
        kind: "wasm",
        name: candidate.filename,
        contentType: "application/wasm",
        bytes: candidateBytes,
        digest: candidate.sha256,
      },
      {
        kind: "manifest",
        name: manifestName,
        contentType: "application/json",
        bytes: manifestBytes,
        digest: manifestSha256,
      },
    ];

    enter("draft-assets", `Attaching the retained candidate and its manifest to draft ${release.id}`);
    let present = await listReleaseAssets({
      ...githubOptions,
      releaseId: githubRecord.release_id,
      signal: readTimeout(),
    });
    for (const asset of wanted) {
      const found = present.find((item) => item.name === asset.name);
      if (found && found.state === "uploaded") {
        const bytes = await downloadReleaseAsset({
          ...githubOptions,
          assetId: String(found.id),
          signal: readTimeout(),
        });
        if (!Buffer.from(bytes).equals(asset.bytes))
          throw new Error(
            `the existing release asset ${asset.name} differs from the retained candidate; publication is halted without writing anything`,
          );
        note(`${asset.name}: already attached and byte-identical`);
        continue;
      }
      if (found) {
        note(`${asset.name}: present in state ${found.state}; deleting and re-uploading`);
        await deleteReleaseAsset({ ...githubOptions, assetId: String(found.id), signal: readTimeout() });
      }
      await uploadReleaseAsset({
        ...githubOptions,
        releaseId: githubRecord.release_id,
        name: asset.name,
        contentType: asset.contentType,
        bytes: asset.bytes,
        signal: uploadTimeout(),
      });
      note(`${asset.name}: uploaded ${asset.bytes.length} bytes`);
    }

    enter("draft-verification", "Downloading both assets again and hashing what GitHub actually serves");
    present = await listReleaseAssets({ ...githubOptions, releaseId: githubRecord.release_id, signal: readTimeout() });
    for (const asset of wanted) {
      const found = present.find((item) => item.name === asset.name);
      if (!found) throw new Error(`release asset ${asset.name} is missing after upload`);
      const bytes = await downloadReleaseAsset({ ...githubOptions, assetId: String(found.id), signal: readTimeout() });
      const digest = sha256(bytes);
      if (digest !== asset.digest)
        throw new Error(`release asset ${asset.name} hashes to ${digest}, expected ${asset.digest}`);
      githubRecord.asset_sha256[asset.kind] = digest;
      note(`${asset.name}: downloaded ${bytes.length} bytes, SHA-256 ${digest}`);
    }

    enter("version-key", `Creating ${key} with If-None-Match: * — after this the version is consumed`);
    const httpMetadata = objectHttpMetadata({ filename: candidate.filename });
    const written = await putObjectCreateOnly({
      ...bucketOptions,
      key,
      bodyPath: candidatePath,
      contentMd5: md5Base64(candidateBytes),
      httpMetadata,
      metadata: objectUserMetadata({
        sha256: candidate.sha256,
        version: intent.version,
        sourceCommit: intent.sourceCommit,
      }),
      signal: uploadTimeout(),
    });
    if (written.outcome === "created") {
      keyExists = true;
      r2Record.outcome = "created";
      state = { ...state, object: { status: "created", bucket: R2_BUCKET, key } };
      await writePublicationJson(statePath, state);
      note(`created ${key}`);
    } else {
      // The key is occupied from here on, whoever wrote it. Recording that before the
      // byte comparison is what makes a conflict report the post-key recovery: the
      // version is consumed, so recreating the tag can never succeed.
      keyExists = true;
      note(`${key} already exists; comparing every byte before continuing`);
      const existingObject = await getObject({ ...bucketOptions, key, signal: readTimeout() });
      if (existingObject.status !== 200 || !existingObject.bytes)
        throw new Error(`${key} exists but could not be read back (HTTP ${existingObject.status})`);
      if (!existingObject.bytes.equals(candidateBytes))
        throw new Error(
          `the existing object at ${key} has SHA-256 ${sha256(existingObject.bytes)} but this candidate is ${candidate.sha256}; this version key is immutable and publication is halted without writing`,
        );
      r2Record.outcome = "existing-identical";
      state = { ...state, object: { status: "created", bucket: R2_BUCKET, key } };
      await writePublicationJson(statePath, state);
    }

    enter("direct-verification", `Downloading ${key} from the S3 endpoint and hashing the complete body`);
    const direct = await getObject({ ...bucketOptions, key, signal: readTimeout() });
    if (direct.status !== 200 || !direct.bytes) throw new Error(`${key} answered HTTP ${direct.status} on read-back`);
    if (direct.bytes.length !== candidate.size)
      throw new Error(`${key} is ${direct.bytes.length} bytes, expected ${candidate.size}`);
    r2Record.direct_download_sha256 = sha256(direct.bytes);
    if (r2Record.direct_download_sha256 !== candidate.sha256)
      throw new Error(`${key} hashes to ${r2Record.direct_download_sha256}, expected ${candidate.sha256}`);
    assertHttpMetadata(direct.httpMetadata, httpMetadata);
    r2Record.http_metadata = {
      content_type: httpMetadata["content-type"],
      content_disposition: httpMetadata["content-disposition"],
      cache_control: httpMetadata["cache-control"],
    };
    const metadataDigest = direct.metadata?.sha256;
    if (metadataDigest !== candidate.sha256)
      throw new Error(`${key} carries sha256 metadata ${metadataDigest ?? "(absent)"}, expected ${candidate.sha256}`);
    r2Record.metadata_sha256 = metadataDigest;
    note(`direct download: ${direct.bytes.length} bytes, SHA-256 ${r2Record.direct_download_sha256}`);

    enter("public-verification", `Fetching ${r2Record.public_url} unauthenticated, exactly as a consumer would`);
    let served = null;
    for (let attempt = 1; attempt <= publicAttempts; attempt++) {
      r2Record.public_attempts = attempt;
      const response = await fetchImpl(r2Record.public_url, { signal: readTimeout() });
      if (response.status === 200) {
        const bytes = Buffer.from(await response.arrayBuffer());
        const digest = sha256(bytes);
        // A 404 is propagation; a 200 with different bytes never is.
        if (digest !== candidate.sha256)
          throw new Error(
            `the public URL served SHA-256 ${digest}, expected ${candidate.sha256}; this is not a propagation race`,
          );
        assertHttpMetadata(Object.fromEntries([...response.headers]), httpMetadata);
        served = digest;
        note(`attempt ${attempt}: HTTP 200, ${bytes.length} bytes, SHA-256 ${digest}`);
        break;
      }
      if (response.status !== 404 && response.status < 500)
        throw new Error(`the public URL answered HTTP ${response.status}, which is not a propagation answer`);
      if (attempt <= 2 || attempt % 10 === 0)
        note(`attempt ${attempt}/${publicAttempts}: HTTP ${response.status} — still propagating`);
      await delay(publicIntervalMs);
    }
    if (!served)
      throw new Error(
        `the public URL never served the object within ${publicAttempts} attempts; the object exists, so retry this run with the same bytes`,
      );
    r2Record.public_download_sha256 = served;

    enter(
      "digest-agreement",
      "Requiring one SHA-256 across candidate, release assets, object, public URL, manifest, and release body",
    );
    // The body is what a human reads and copies into sqlc.yaml, so it is re-read from
    // GitHub rather than trusted from memory, and the digest it advertises has to be
    // the same one every machine-readable surface produced.
    const draft = await getRelease({ ...githubOptions, releaseId: githubRecord.release_id, signal: readTimeout() });
    assertBodyAgreesWithManifest(draft.body ?? "", manifest, { manifestSha256 });
    const advertised = [...new Set((draft.body ?? "").match(/\b[0-9a-f]{64}\b/g) ?? [])].filter(
      (digest) => digest !== manifestSha256,
    );
    if (advertised.length !== 1)
      throw new Error(`the release body advertises ${advertised.length} artifact digests, expected exactly one`);
    const surfaces = {
      "retained candidate": candidate.sha256,
      "release asset": githubRecord.asset_sha256.wasm,
      "object metadata": r2Record.metadata_sha256,
      "direct download": r2Record.direct_download_sha256,
      "public download": r2Record.public_download_sha256,
      "release manifest": manifest.artifact.sha256,
      "release body": advertised[0],
    };
    const distinct = [...new Set(Object.values(surfaces))];
    if (distinct.length !== 1)
      throw new Error(
        `publication surfaces disagree: ${Object.entries(surfaces)
          .map(([name, digest]) => `${name}=${digest}`)
          .join(", ")}`,
      );
    if (manifest.artifact.size !== candidate.size)
      throw new Error(`the manifest records ${manifest.artifact.size} bytes but the candidate is ${candidate.size}`);
    verifiedSha256 = distinct[0];
    note(`every surface produced SHA-256 ${verifiedSha256}`);

    if (mode === "dry-run") {
      say(`[publish] Refusing to publish: this is a dry run, so nothing is advertised`);
    } else {
      enter("publish", `Publishing release ${githubRecord.release_id} — the last write of this run`);
      // Two independently derived facts guard the advertisement: the mode this process
      // was asked for, and the key shape the version actually produced. A rehearsal can
      // therefore never be advertised even if one of them is wrong.
      if (mode !== "publish" || intent.dryRun || !isVersionKey(key))
        throw new Error(`refusing to publish ${tagName}: mode ${mode} with object key ${key} is not a publication`);
      await publishRelease({
        ...githubOptions,
        releaseId: githubRecord.release_id,
        makeLatest: prerelease ? "false" : "true",
        signal: readTimeout(),
      });
      // Recorded before the confirming reads, so a failure in any of them still tells
      // the operator the version is advertised and must not be taken back.
      githubRecord.published = true;
      const published = await getRelease({
        ...githubOptions,
        releaseId: githubRecord.release_id,
        signal: readTimeout(),
      });
      if (published.draft !== false)
        throw new Error(`release ${githubRecord.release_id} is still a draft after publishing`);
      githubRecord.release_url = published.html_url ?? githubRecord.release_url;
      const setting = await getImmutableReleases({ ...githubOptions });
      githubRecord.immutable_releases = setting;
      if (!setting.enabled) throw new Error("immutable releases were disabled during this run");
      const tagCommit = await resolveTagCommit({ ...githubOptions, tagName, signal: readTimeout() });
      if (tagCommit !== intent.sourceCommit)
        throw new Error(`tag ${tagName} resolves to ${tagCommit ?? "no commit"}, expected ${intent.sourceCommit}`);
      note(`published ${githubRecord.release_url}`);
    }
  } catch (error) {
    const detail = clean(String(error?.message ?? error)).slice(0, FAILURE_DETAIL_LIMIT);
    failure = { phase, detail };
    annotate(`publication failed during ${phase}: ${detail}`);
    annotate(
      recoveryGuidance({
        mode,
        version: intent.version,
        tag: intent.tag,
        key,
        digest: candidate.sha256,
        keyExists,
        published: githubRecord.published,
      }),
    );
  }

  if (mode === "dry-run") {
    teardown = await removeRehearsalResources({ state, credentials, fetchImpl, run, logger });
  }

  order.push({ phase: "record", at: now().toISOString() });
  const record = createPublicationRecord({
    mode,
    intent,
    candidate,
    artifactId,
    manifest,
    manifestSize: manifestBytes.length,
    manifestSha256,
    verifiedSha256,
    r2: r2Record,
    github: githubRecord,
    order,
    teardown,
    failure,
  });
  await validatePublicationRecord({ record, root });
  if (recordPath) await writePublicationJson(recordPath, record);
  say(
    `[record] ${mode}: R2 ${key} ${r2Record.outcome}, draft ${githubRecord.draft_outcome}, published ${githubRecord.published}`,
  );
  note(`teardown: object ${teardown.object}, draft ${teardown.draft}`);
  if (recordPath) note(`publication record written to ${recordPath}`);
  return record;
}

function report(message) {
  process.stdout.write(`${annotation(message)}\n`);
}

async function cli() {
  const [command, ...rest] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < rest.length; i += 2) args[rest[i]?.replace(/^--/, "")] = rest[i + 1];
  const credentials = credentialsFromEnvironment();
  // The access key ID identifies the credential in logs; mask it anyway so a copied
  // log line cannot be paired with a leaked secret.
  if (process.env.GITHUB_ACTIONS && credentials.accessKeyId)
    process.stdout.write(`::add-mask::${credentials.accessKeyId}\n`);

  if (command === "preflight") {
    // A workflow passes the validated intent; a manual audit passes only a version.
    const intent = args.intent
      ? JSON.parse(await readFile(resolve(args.intent), "utf8"))
      : { version: args.version, tag: null, sourceCommit: null, dryRun: true, workflowRunId: "1", workflowUrl: "" };
    await preflightPublication({ repository: args.repository, intent, credentials, output: args.output });
  } else if (command === "publish") {
    const intent = JSON.parse(await readFile(resolve(args.intent ?? "intent.json"), "utf8"));
    let notes = "";
    if (args.notes) notes = await readFile(resolve(args.notes), "utf8").catch(() => "");
    const record = await publishPublication({
      repository: args.repository,
      intent,
      candidateDir: args.candidate,
      manifestPath: args.manifest,
      artifactId: args["artifact-id"],
      notes,
      credentials,
      mode: args.mode,
      recordPath: args.record ?? "publication-record.json",
      statePath: args.state ?? "publication-state.json",
    });
    if (record.failure) {
      report(`publication did not complete — ${record.failure.phase}: ${record.failure.detail}`);
      process.exitCode = 1;
    }
  } else if (command === "teardown") {
    await teardownPublication({
      statePath: args.state ?? "publication-state.json",
      credentials,
      reportPath: args.report,
    });
  } else throw new Error("usage: publish-release.mjs preflight|publish|teardown [options]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void cli().catch((error) => {
    report(
      `publication aborted: ${redactSecrets(error?.message ?? error, Object.values(credentialsFromEnvironment()))}`,
    );
    process.exitCode = error?.exitCode ?? 1;
  });
