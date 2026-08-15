#!/usr/bin/env node
// Every rule publication promises, with no I/O and no network: object keys, the HTTP
// metadata an object must carry forever, the release body a consumer reads, and the
// closed publication record a run leaves behind. A reviewer learns what publication
// guarantees by reading this file; scripts/publish-release.mjs only orders the work.
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";
import { canonicalManifestFilename, canonicalWasmFilename, parseSemver, stableJson } from "./release-contract.mjs";

export { stableJson };

export const R2_BUCKET = "sqlc";
export const PUBLIC_ORIGIN = "https://sqlc.mkuznets.com";
export const KEY_PREFIX = "plugins/";
export const REHEARSAL_PREFIX = "rehearsal/";
export const PLUGIN = "sqlc-d1-typescript";

export const PUBLICATION_PHASES = Object.freeze([
  "preflight",
  "draft-release",
  "draft-assets",
  "draft-verification",
  "version-key",
  "direct-verification",
  "public-verification",
  "digest-agreement",
  "publish",
  "record",
]);

const SHA = /^[0-9a-f]{64}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const ID = /^[1-9][0-9]*$/;
const ANY_SHA256 = /\b[0-9a-f]{64}\b/g;
const BODY_EXCERPT_BYTES = 500;
const FORBIDDEN_KEYS =
  /^(?:credentials|authorization|token|secret|secrets|signature|headers|stack|cause|responseBody|accessKeyId|secretAccessKey)$/i;

export const PRERELEASE_NOTICE =
  "> **Pre-1.0:** releases may contain breaking changes. Pin one immutable Plugin release and review its release notes before regenerating or upgrading.";

export function contractError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}
function fail(message) {
  throw contractError(message);
}

// Redaction happens wherever a message is built, not only where it is printed: a
// credential that never enters a string cannot leak out of one later.
export function redactSecrets(text, secrets = []) {
  let result = String(text ?? "");
  for (const secret of secrets)
    if (typeof secret === "string" && secret.length >= 8) {
      result = result.replaceAll(secret, "[REDACTED]");
    }
  return result;
}

// One shape for every error excerpt that leaves a transport: collapsed, bounded, and
// redacted, so no failure path can decide for itself how much of a body to quote.
export function redactedExcerpt(text, secrets = []) {
  const trimmed = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return redactSecrets(
    trimmed.length > BODY_EXCERPT_BYTES ? `${trimmed.slice(0, BODY_EXCERPT_BYTES)}…` : trimmed,
    secrets,
  );
}

// Failures must reach the run summary, so they are emitted as annotations with their
// newlines escaped the way GitHub Actions requires.
export function annotation(message) {
  return `::error::${String(message).replace(/\r?\n/g, "%0A")}`;
}

export function canonicalObjectKey(version) {
  return `${KEY_PREFIX}${canonicalWasmFilename(version)}`;
}

// A rehearsal key is deliberately not a version key: dry runs write here and delete
// afterwards, so nothing a dry run does can consume a permanent version.
export function rehearsalObjectKey(version, runId) {
  if (!ID.test(String(runId ?? ""))) fail("rehearsal keys require a decimal workflow run ID");
  return `${REHEARSAL_PREFIX}${runId}/${canonicalWasmFilename(version)}`;
}

export function isVersionKey(key) {
  return typeof key === "string" && key.startsWith(KEY_PREFIX);
}

export function publicUrlForKey(key) {
  if (typeof key !== "string" || !key || key.startsWith("/")) fail(`rejected object key ${JSON.stringify(key)}`);
  return `${PUBLIC_ORIGIN}/${key}`;
}

// Exactly the HTTP metadata the immutable release contract requires. A published
// object is cached forever, so these are part of the artifact, not a preference.
export function objectHttpMetadata({ filename }) {
  if (typeof filename !== "string" || !filename.endsWith(".wasm")) fail("object metadata requires a .wasm filename");
  return {
    "content-type": "application/wasm",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "public, max-age=31536000, immutable",
  };
}

// User metadata as a plain key/value map. S3 stores these under `x-amz-meta-`, but
// that prefix is the transport's business, not the contract's.
export function objectUserMetadata({ sha256, version, sourceCommit }) {
  if (!SHA.test(sha256 ?? "")) fail("object metadata requires a 64-character lowercase SHA-256");
  if (!SOURCE_SHA.test(sourceCommit ?? "")) fail("object metadata requires a full 40-character source commit");
  return { sha256, version: parseSemver(version), "source-commit": sourceCommit };
}

export function assertHttpMetadata(observed, expected) {
  const seen = Object.fromEntries(Object.entries(observed ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  for (const [name, value] of Object.entries(expected)) {
    const actual = seen[name];
    if (actual !== value)
      fail(`object header ${name} is ${JSON.stringify(actual ?? null)}, expected ${JSON.stringify(value)}`);
  }
  return true;
}

export function repositoryFromWorkflowUrl(workflowUrl) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/[1-9][0-9]*$/.exec(String(workflowUrl ?? ""));
  if (!match) fail(`workflow URL ${JSON.stringify(workflowUrl)} does not name a repository`);
  return match[1];
}

function changelogSection(notes, repository, ref) {
  const body = String(notes ?? "").trim();
  if (body) return body;
  return `No changelog was supplied in the tag message. Review the [commit history](https://github.com/${repository}/commits/${ref}).`;
}

// Deterministic in its inputs: a retried publication rebuilds the identical body and
// can therefore byte-compare an existing draft instead of rewriting it.
export function buildReleaseBody({ manifest, intent, notes = "", manifestSha256 }) {
  if (!SHA.test(manifestSha256 ?? "")) fail("the release body must quote the manifest SHA-256");
  const repository = repositoryFromWorkflowUrl(manifest.workflow_url);
  const ref = manifest.tag ?? manifest.source_commit;
  const blob = `https://github.com/${repository}/blob/${ref}`;
  const tested = manifest.tested_versions;
  const configuration = manifest.verification_configuration;
  const flags = configuration.compatibility_flags.length ? configuration.compatibility_flags.join(", ") : "none";
  const exceptions = configuration.known_exceptions.length ? configuration.known_exceptions.join(", ") : "none";
  const manifestFilename = canonicalManifestFilename(manifest.version);

  return [
    PRERELEASE_NOTICE,
    "",
    "## Configure sqlc",
    "",
    "```yaml",
    'version: "2"',
    "plugins:",
    "  - name: ts",
    "    wasm:",
    `      url: ${manifest.artifact.url}`,
    `      sha256: ${manifest.artifact.sha256}`,
    "```",
    "",
    "## Download",
    "",
    `- Artifact: ${manifest.artifact.url}`,
    `- SHA-256: \`${manifest.artifact.sha256}\``,
    `- Size: ${manifest.artifact.size} bytes`,
    `- Source commit: \`${manifest.source_commit}\``,
    "",
    "## Verification",
    "",
    `- sqlc versions tested: ${tested.sqlc.join(", ")}`,
    `- TypeScript floor and current: ${tested.typescript.join(", ")}`,
    `- Cloudflare baseline: workerd ${tested.cloudflare.workerd}, wrangler ${tested.cloudflare.wrangler}, workers-types ${tested.cloudflare.workers_types}`,
    `- Compatibility date ${configuration.compatibility_date}, flags: ${flags}`,
    `- Known exceptions: ${exceptions}`,
    `- Managed D1 verification passed on ${manifest.remote_d1.date}`,
    `- Workflow run: ${intent.workflowUrl}`,
    `- Supported surface: ${blob}/docs/compatibility.md`,
    `- Troubleshooting: ${blob}/docs/troubleshooting.md`,
    "",
    "## Changelog",
    "",
    changelogSection(notes, repository, ref),
    "",
    "## Release manifest",
    "",
    `\`${manifestFilename}\` is attached to this release; its SHA-256 is \`${manifestSha256}\`.`,
    "",
  ].join("\n");
}

// A stale copy/pasted digest is the one publication failure a reader cannot see, so
// the body may quote no digest other than the artifact's and the manifest's.
export function assertBodyAgreesWithManifest(body, manifest, { manifestSha256 } = {}) {
  const text = String(body ?? "");
  if (!text.includes(manifest.artifact.sha256))
    fail("the release body does not quote the artifact SHA-256 from the manifest");
  if (!text.includes(manifest.artifact.url)) fail("the release body does not quote the artifact URL from the manifest");
  const allowed = new Set([manifest.artifact.sha256, ...(manifestSha256 ? [manifestSha256] : [])]);
  for (const found of text.match(ANY_SHA256) ?? [])
    if (!allowed.has(found))
      fail(`the release body quotes SHA-256 ${found}, which is neither the artifact nor the manifest digest`);
  return true;
}

export function createPublicationRecord({
  mode,
  intent,
  candidate,
  artifactId,
  manifest,
  manifestSize,
  manifestSha256,
  verifiedSha256 = null,
  r2,
  github,
  order = [],
  teardown = { object: "not-created", draft: "not-created" },
  failure,
}) {
  const record = {
    schema_version: 1,
    plugin: PLUGIN,
    mode,
    version: parseSemver(intent.version),
    tag: intent.tag ?? null,
    dry_run: intent.dryRun,
    source_commit: intent.sourceCommit,
    workflow_url: intent.workflowUrl,
    verified_sha256: verifiedSha256,
    artifact: {
      filename: candidate.filename,
      size: candidate.size,
      actions_artifact_id: artifactId ?? null,
    },
    manifest: {
      filename: canonicalManifestFilename(manifest.version),
      sha256: manifestSha256,
      size: manifestSize,
    },
    r2,
    github,
    order: order.map(({ phase, at }) => ({ phase, at })),
    teardown,
    ...(failure ? { failure } : {}),
  };
  return record;
}

function inspectKeys(value, path = "$") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) fail(`publication record contains prohibited field ${path}.${key}`);
    inspectKeys(child, `${path}.${key}`);
  }
}

function agree(field, expected, actual) {
  if (expected !== actual) fail(`publication record ${field} is ${JSON.stringify(actual)}, expected ${expected}`);
}

export async function validatePublicationRecord({ record, path, root = process.cwd() }) {
  let value = record;
  if (path) {
    let source;
    try {
      source = await readFile(resolve(path), "utf8");
    } catch {
      fail(`publication record ${path} is unreadable`);
    }
    try {
      value = JSON.parse(source);
    } catch {
      fail(`publication record ${path} is malformed JSON`);
    }
  }
  inspectKeys(value);

  const schema = JSON.parse(await readFile(resolve(root, "verification/publication-record.schema.json"), "utf8"));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  if (!validate(value)) fail(`publication record schema mismatch: ${JSON.stringify(validate.errors)}`);

  agree("mode/dry_run", value.mode === "dry-run", value.dry_run);
  agree("tag/dry_run", value.tag === null, value.dry_run);
  agree("r2.public_url", publicUrlForKey(value.r2.key), value.r2.public_url);
  if (value.dry_run) {
    if (value.github.published) fail("a dry run must never record a published release");
    if (isVersionKey(value.r2.key)) fail(`a dry run must never write the version key ${value.r2.key}`);
  } else if (value.r2.outcome !== "not-created" && !isVersionKey(value.r2.key))
    fail(`a publication run must write the version key, not ${value.r2.key}`);

  const digests = {
    "r2.metadata_sha256": value.r2.metadata_sha256,
    "r2.direct_download_sha256": value.r2.direct_download_sha256,
    "r2.public_download_sha256": value.r2.public_download_sha256,
    "github.asset_sha256.wasm": value.github.asset_sha256.wasm,
  };
  if (value.github.published) {
    if (!value.verified_sha256) fail("a published release must record the digest every surface produced");
    if (value.r2.outcome === "not-created")
      fail("a published release must name the version key that was created or confirmed before it");
    for (const [field, digest] of Object.entries(digests))
      if (!digest) fail(`publication record ${field} is missing although the release is published`);
  }
  for (const [field, digest] of Object.entries(digests))
    if (digest && value.verified_sha256 && digest !== value.verified_sha256)
      fail(`publication record ${field} is ${digest}, which disagrees with verified_sha256 ${value.verified_sha256}`);
  if (
    value.manifest.sha256 &&
    value.github.asset_sha256.manifest &&
    value.github.asset_sha256.manifest !== value.manifest.sha256
  )
    fail("the published manifest asset digest disagrees with the manifest digest");

  // Writing the record is the only work that may follow the advertisement.
  const phases = value.order.map(({ phase }) => phase);
  const published = phases.indexOf("publish");
  if (published !== -1 && phases.slice(published + 1).some((phase) => phase !== "record"))
    fail("publication order records work after the release was published");
  return value;
}

export async function writePublicationJson(path, value) {
  await writeFile(resolve(path), stableJson(value), { mode: 0o600 });
  await chmod(resolve(path), 0o600);
}

async function cli() {
  const [command, ...rest] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < rest.length; i += 2) args[rest[i]?.replace(/^--/, "")] = rest[i + 1];
  if (command !== "validate-record") fail("usage: publication-contract.mjs validate-record --path FILE");
  const record = await validatePublicationRecord({ path: args.path });
  process.stdout.write(`==> Publication record for ${record.version} validated (mode: ${record.mode})\n`);
  process.stdout.write(`    R2 ${record.r2.key}: ${record.r2.outcome}\n`);
  process.stdout.write(`    GitHub release published: ${record.github.published}\n`);
  process.stdout.write(`    teardown: object ${record.teardown.object}, draft ${record.teardown.draft}\n`);
  if (record.failure) process.stdout.write(`    recorded failure during ${record.failure.phase}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void cli().catch((error) => {
    const message = String(error?.message ?? error);
    process.stdout.write(process.env.GITHUB_ACTIONS ? `${annotation(message)}\n` : `${message}\n`);
    process.exitCode = error?.exitCode ?? 1;
  });
