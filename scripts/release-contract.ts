#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { spawn } from "node:child_process";
import { readCandidate, runAsCli, usageError } from "./candidate-utils.ts";
import type { CompatibilityConfig } from "./compatibility-config.ts";
import type { ManagedD1Evidence } from "./managed-d1-contract.ts";
import type { CompatibilityEvidence } from "./write-compatibility-evidence.ts";

// `intent` and `validate-candidate` run before any job installs dependencies, so this
// module must load with the Node standard library alone. Everything heavier is
// imported by the command that needs it, not by the file.
async function validateManagedD1Evidence(
  options: Parameters<typeof import("./managed-d1-contract.ts").validateManagedD1Evidence>[0],
): Promise<ManagedD1Evidence> {
  return (await import("./managed-d1-contract.ts")).validateManagedD1Evidence(options);
}
async function loadConfig(options?: { root?: string; checkLocal?: boolean }): Promise<CompatibilityConfig> {
  return (await import("./compatibility-config.ts")).loadCompatibilityConfig(options);
}

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const SHA = /^[0-9a-f]{64}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const ID = /^\d+$/;
const PLUGIN = "sqlc-d1-typescript";
const POLICY = "build-once-exact-artifact";
const PUBLIC_ORIGIN = "https://sqlc.mkuznets.com/plugins";

export interface ReleaseIntent {
  version: string;
  tag: string | null;
  sourceCommit: string;
  defaultBranch: string;
  workflowRunId: string;
  workflowUrl: string;
}

export interface CandidateDescriptor {
  schemaVersion: 1;
  plugin: typeof PLUGIN;
  version: string;
  tag: string | null;
  sourceCommit: string;
  workflowRunId: string;
  workflowUrl: string;
  buildPolicy: typeof POLICY;
  filename: string;
  size: number;
  sha256: string;
}

export interface ManifestFacts {
  tested_versions: {
    bun: string;
    cloudflare: {
      miniflare: string;
      vitest_pool_workers: string;
      workerd: string;
      workers_types: string;
      wrangler: string;
    };
    node: string;
    npm: string;
    sqlc: string[];
    typescript: string[];
  };
  verification_configuration: {
    compatibility_date: string;
    compatibility_flags: readonly string[];
    known_exceptions: readonly string[];
  };
}

export interface ReleaseManifest extends ManifestFacts {
  artifact: {
    actions_artifact_id: string;
    filename: string;
    sha256: string;
    size: number;
    url: string;
  };
  build_policy: typeof POLICY;
  plugin: typeof PLUGIN;
  remote_d1: { date: string; evidence_artifact_id: string; result: "passed" };
  schema_version: 1;
  source_commit: string;
  tag: string | null;
  version: string;
  workflow_url: string;
}

export function parseSemver(value: unknown, { prefixed = false }: { prefixed?: boolean } = {}): string {
  const shape = `${prefixed ? "v" : ""}MAJOR.MINOR.PATCH with an optional SemVer prerelease and no build metadata`;
  if (typeof value !== "string" || (prefixed ? !value.startsWith("v") : value.startsWith("v")))
    throw usageError(`rejected version ${JSON.stringify(value)}; expected ${shape}`);
  const version = prefixed ? value.slice(1) : value;
  if (!SEMVER.test(version)) throw usageError(`rejected version ${JSON.stringify(value)}; expected ${shape}`);
  return version;
}

export function canonicalWasmFilename(version: string): string {
  return `sqlc-gen-d1-typescript_${parseSemver(version)}.wasm`;
}

export function canonicalManifestFilename(version: string): string {
  return `sqlc-gen-d1-typescript_${parseSemver(version)}.manifest.json`;
}

export function stableJson(value: unknown): string {
  const sort = (item: any): any =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sort(item[key])]),
          )
        : item;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function assertSource(sourceCommit: string | undefined): void {
  if (!SOURCE_SHA.test(sourceCommit ?? "")) throw usageError(`sourceCommit must be a full 40-character lowercase SHA`);
}

function assertId(value: string | undefined, field: string): void {
  if (!ID.test(value ?? "")) throw usageError(`${field} must be a decimal string`);
}

function equal(field: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw usageError(`${field} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

export interface ResolveIntentOptions {
  eventName?: string;
  refType?: string;
  refName?: string;
  sourceCommit?: string;
  defaultBranch?: string;
  workflowRunId?: string;
  serverUrl?: string;
  repository?: string;
  isAncestor: (source: string, branch: string) => Promise<boolean>;
}

// A release is a tag push and nothing else. There is no rehearsal mode: to try a
// release, cut the next patch version.
export async function resolveReleaseIntent({
  eventName,
  refType,
  refName,
  sourceCommit,
  defaultBranch,
  workflowRunId,
  serverUrl = "https://github.com",
  repository,
  isAncestor,
}: ResolveIntentOptions): Promise<ReleaseIntent> {
  assertSource(sourceCommit);
  assertId(workflowRunId, "workflowRunId");
  if (!defaultBranch || !repository || typeof isAncestor !== "function")
    throw usageError("defaultBranch, repository, and isAncestor are required");
  if (eventName !== "push") throw usageError(`unsupported release event ${eventName}`);
  if (refType !== "tag") throw usageError("release push must use a tag ref");

  const version = parseSemver(refName, { prefixed: true });
  if (!(await isAncestor(sourceCommit!, defaultBranch)))
    throw usageError(`source commit ${sourceCommit} is not reachable from default branch ${defaultBranch}`);

  return {
    version,
    tag: refName!,
    sourceCommit: sourceCommit!,
    defaultBranch,
    workflowRunId: workflowRunId!,
    workflowUrl: `${serverUrl.replace(/\/$/, "")}/${repository}/actions/runs/${workflowRunId}`,
  };
}

export async function describeCandidate({
  wasmPath,
  intent,
}: {
  wasmPath: string;
  intent: ReleaseIntent;
}): Promise<CandidateDescriptor> {
  const bytes = await readFile(resolve(wasmPath));
  return {
    schemaVersion: 1,
    plugin: PLUGIN,
    version: intent.version,
    tag: intent.tag,
    sourceCommit: intent.sourceCommit,
    workflowRunId: intent.workflowRunId,
    workflowUrl: intent.workflowUrl,
    buildPolicy: POLICY,
    filename: canonicalWasmFilename(intent.version),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function writeCandidateBundle({
  wasmPath,
  directory,
  intent,
}: {
  wasmPath: string;
  directory: string;
  intent: ReleaseIntent;
}): Promise<CandidateDescriptor> {
  const descriptor = await describeCandidate({ wasmPath, intent });
  const target = resolve(directory);
  await mkdir(target, { recursive: true });
  await cp(resolve(wasmPath), resolve(target, descriptor.filename));
  await writeFile(resolve(target, "candidate.sha256"), `${descriptor.sha256}\n`);
  await writeFile(resolve(target, "candidate.json"), stableJson(descriptor));
  return descriptor;
}

const candidateKeys = [
  "buildPolicy",
  "filename",
  "plugin",
  "schemaVersion",
  "sha256",
  "size",
  "sourceCommit",
  "tag",
  "version",
  "workflowRunId",
  "workflowUrl",
];

export async function validateCandidateBundle({
  directory,
  intent,
}: {
  directory: string;
  intent: ReleaseIntent;
}): Promise<CandidateDescriptor> {
  let source: string;
  try {
    source = await readFile(resolve(directory, "candidate.json"), "utf8");
  } catch {
    throw usageError("candidate.json is missing or unreadable");
  }
  if (!source.endsWith("\n") || source.endsWith("\n\n"))
    throw usageError("candidate.json must have exactly one trailing newline");
  let descriptor: CandidateDescriptor;
  try {
    descriptor = JSON.parse(source) as CandidateDescriptor;
  } catch {
    throw usageError("candidate.json is malformed JSON");
  }
  equal("candidate.json canonical encoding", stableJson(descriptor), source);
  equal("candidate.json keys", candidateKeys, Object.keys(descriptor).sort());
  const expected = {
    schemaVersion: 1,
    plugin: PLUGIN,
    version: intent.version,
    tag: intent.tag,
    sourceCommit: intent.sourceCommit,
    workflowRunId: intent.workflowRunId,
    workflowUrl: intent.workflowUrl,
    buildPolicy: POLICY,
    filename: canonicalWasmFilename(intent.version),
  };
  for (const [field, value] of Object.entries(expected))
    equal(`candidate.${field}`, value, (descriptor as unknown as Record<string, unknown>)[field]);
  if (!SHA.test(descriptor.sha256 ?? ""))
    throw usageError("candidate.sha256 must be exactly 64 lowercase hexadecimal characters");
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 1)
    throw usageError("candidate.size must be a positive integer");
  const files = (await readdir(resolve(directory))).sort();
  equal("candidate bundle files", ["candidate.json", "candidate.sha256", descriptor.filename].sort(), files);
  const digestText = await readFile(resolve(directory, "candidate.sha256"), "utf8");
  equal("candidate.sha256 file", `${descriptor.sha256}\n`, digestText);
  const wasm = resolve(directory, descriptor.filename);
  const retained = await readCandidate(wasm, descriptor.sha256);
  equal("candidate.size", descriptor.size, retained.bytes.length);
  return descriptor;
}

function expectedEvidence(config: CompatibilityConfig, sqlc: string, sha256: string) {
  return {
    candidateSha256: sha256,
    tools: {
      node: config.tools.node,
      npm: config.tools.npm,
      bun: config.tools.bun,
      sqlc: [sqlc],
      typescript: [config.typescript.floor, config.typescript.current],
      workersTypes: config.cloudflare.workersTypes,
      wrangler: config.cloudflare.wrangler,
      vitestPoolWorkers: config.cloudflare.vitestPoolWorkers,
      miniflare: config.cloudflare.miniflare,
      workerd: config.cloudflare.workerd,
      buf: config.tools.buf,
      javy: config.tools.javy,
    },
    configuration: {
      compatibilityDate: config.cloudflare.compatibilityDate,
      compatibilityFlags: config.cloudflare.compatibilityFlags,
      knownExceptions: config.sqlc.knownExceptions,
    },
  };
}

export async function validateCompatibilityEvidence({
  path,
  candidateSha256,
  sqlcVersion,
  config,
}: {
  path: string;
  candidateSha256: string;
  sqlcVersion?: string;
  config: CompatibilityConfig;
  root?: string;
}): Promise<CompatibilityEvidence> {
  if (!SHA.test(candidateSha256 ?? "")) throw usageError("candidate SHA-256 is malformed");
  let evidence: CompatibilityEvidence;
  try {
    evidence = JSON.parse(await readFile(resolve(path), "utf8")) as CompatibilityEvidence;
  } catch {
    throw usageError(`compatibility evidence ${path} is malformed or unreadable`);
  }
  if (!Array.isArray(evidence?.tools?.sqlc) || !evidence.cleanup || !Array.isArray(evidence.scenarios))
    throw usageError(`compatibility evidence ${path} is not a compatibility evidence envelope`);
  const sqlc = evidence.tools.sqlc.length === 1 ? evidence.tools.sqlc[0] : undefined;
  if (!sqlc) throw usageError(`compatibility evidence ${path} must contain exactly one sqlc version`);
  if (sqlcVersion) equal(`compatibility ${sqlc}.tools.sqlc`, sqlcVersion, sqlc);
  const expected = expectedEvidence(config, sqlc, candidateSha256);
  for (const field of ["candidateSha256", "tools", "configuration"] as const)
    equal(`compatibility ${sqlc}.${field}`, expected[field], evidence[field]);
  if (
    evidence.cleanup.status !== "confirmed" ||
    !evidence.scenarios.length ||
    evidence.scenarios.some(({ status }) => status !== "passed")
  )
    throw usageError(`compatibility ${sqlc} does not record passed scenarios and confirmed cleanup`);
  return evidence;
}

export async function collectCompatibilityEvidence({
  paths,
  candidateSha256,
  config,
  root = process.cwd(),
}: {
  paths: readonly string[];
  candidateSha256: string;
  config: CompatibilityConfig;
  root?: string;
}): Promise<CompatibilityEvidence[]> {
  const byVersion = new Map<string, CompatibilityEvidence>();
  for (const path of paths) {
    const evidence = await validateCompatibilityEvidence({ path, candidateSha256, config, root });
    const sqlc = evidence.tools.sqlc[0];
    if (byVersion.has(sqlc)) throw usageError(`duplicate compatibility evidence for ${sqlc}`);
    byVersion.set(sqlc, evidence);
  }
  const versions = config.sqlc.samples.map(({ version }) => version);
  equal("compatibility version set", [...versions].sort(), [...byVersion.keys()].sort());
  return versions.map((version) => byVersion.get(version)!);
}

interface ManifestChecks {
  intent?: ReleaseIntent;
  candidate?: CandidateDescriptor;
  artifactId?: string;
  config?: CompatibilityConfig;
  managedEvidence?: ManagedD1Evidence;
  managedEvidenceArtifactId?: string;
}

function semanticManifest(
  manifest: ReleaseManifest,
  { intent, candidate, artifactId, config, managedEvidence, managedEvidenceArtifactId }: ManifestChecks = {},
): ReleaseManifest {
  parseSemver(manifest.version);
  assertSource(manifest.source_commit);
  assertId(manifest.artifact.actions_artifact_id, "artifact.actions_artifact_id");
  if (manifest.tag === null) throw usageError("a release manifest must name the tag it was cut from");
  equal("tag", manifest.version, parseSemver(manifest.tag, { prefixed: true }));
  equal("artifact.filename", canonicalWasmFilename(manifest.version), manifest.artifact.filename);
  equal("artifact.url", `${PUBLIC_ORIGIN}/${manifest.artifact.filename}`, manifest.artifact.url);

  if (intent) {
    equal("manifest.version", intent.version, manifest.version);
    equal("manifest.tag", intent.tag, manifest.tag);
    equal("manifest.source_commit", intent.sourceCommit, manifest.source_commit);
    equal("manifest.workflow_url", intent.workflowUrl, manifest.workflow_url);
  }
  if (candidate) {
    equal("manifest artifact filename", candidate.filename, manifest.artifact.filename);
    equal("manifest artifact sha256", candidate.sha256, manifest.artifact.sha256);
    equal("manifest artifact size", candidate.size, manifest.artifact.size);
  }
  if (artifactId) equal("manifest artifact ID", artifactId, manifest.artifact.actions_artifact_id);
  if (config) {
    const expected = manifestFacts(config);
    equal("manifest.tested_versions", expected.tested_versions, manifest.tested_versions);
    equal(
      "manifest.verification_configuration",
      expected.verification_configuration,
      manifest.verification_configuration,
    );
  }

  if (manifest.remote_d1.result !== "passed") throw usageError("release-complete manifest requires a managed D1 pass");
  if (!managedEvidence) throw usageError("managed evidence is required to validate a release-complete manifest");
  if (!managedEvidenceArtifactId)
    throw usageError("managed evidence artifact ID is required to validate a release-complete manifest");
  assertId(managedEvidenceArtifactId, "managedEvidenceArtifactId");
  equal("manifest remote date", managedEvidence.run.remoteDate, manifest.remote_d1.date);
  equal("manifest remote evidence artifact ID", managedEvidenceArtifactId, manifest.remote_d1.evidence_artifact_id);
  return manifest;
}

function manifestFacts(config: CompatibilityConfig): ManifestFacts {
  return {
    tested_versions: {
      bun: config.tools.bun,
      cloudflare: {
        miniflare: config.cloudflare.miniflare,
        vitest_pool_workers: config.cloudflare.vitestPoolWorkers,
        workerd: config.cloudflare.workerd,
        workers_types: config.cloudflare.workersTypes,
        wrangler: config.cloudflare.wrangler,
      },
      node: config.tools.node,
      npm: config.tools.npm,
      sqlc: config.sqlc.samples.map(({ version }) => version),
      typescript: [config.typescript.floor, config.typescript.current],
    },
    verification_configuration: {
      compatibility_date: config.cloudflare.compatibilityDate,
      compatibility_flags: config.cloudflare.compatibilityFlags,
      known_exceptions: config.sqlc.knownExceptions,
    },
  };
}

export async function validateCompatibilitySet(options: {
  paths: readonly string[];
  candidateSha256: string;
  config: CompatibilityConfig;
  root?: string;
}): Promise<CompatibilityEvidence[]> {
  return collectCompatibilityEvidence(options);
}

export interface CreateManifestOptions {
  intent: ReleaseIntent;
  candidate: CandidateDescriptor;
  artifactId: string;
  config: CompatibilityConfig;
  evidence: readonly CompatibilityEvidence[];
  managedEvidence: ManagedD1Evidence;
  managedEvidenceArtifactId: string;
}

export function createReleaseManifest({
  intent,
  candidate,
  artifactId,
  config,
  evidence,
  managedEvidence,
  managedEvidenceArtifactId,
}: CreateManifestOptions): ReleaseManifest {
  assertId(artifactId, "artifactId");
  assertId(managedEvidenceArtifactId, "managedEvidenceArtifactId");
  equal("evidence count", config.sqlc.samples.length, evidence.length);

  if (
    !managedEvidence ||
    managedEvidence.candidateSha256 !== candidate.sha256 ||
    managedEvidence.sourceCommit !== intent.sourceCommit ||
    managedEvidence.run.id !== intent.workflowRunId ||
    managedEvidence.run.url !== intent.workflowUrl ||
    managedEvidence.run.trigger !== "release" ||
    managedEvidence.test.status !== "passed" ||
    managedEvidence.cleanup.status !== "confirmed"
  )
    throw usageError("managed evidence is not a passing release-run record for the exact candidate");

  const facts = manifestFacts(config);
  const manifest: ReleaseManifest = {
    artifact: {
      actions_artifact_id: artifactId,
      filename: candidate.filename,
      sha256: candidate.sha256,
      size: candidate.size,
      url: `${PUBLIC_ORIGIN}/${candidate.filename}`,
    },
    build_policy: POLICY,
    plugin: PLUGIN,
    remote_d1: {
      date: managedEvidence.run.remoteDate,
      evidence_artifact_id: managedEvidenceArtifactId,
      result: "passed",
    },
    schema_version: 1,
    source_commit: intent.sourceCommit,
    tag: intent.tag,
    ...facts,
    version: intent.version,
    workflow_url: intent.workflowUrl,
  };
  return semanticManifest(manifest, {
    intent,
    candidate,
    artifactId,
    config,
    managedEvidence,
    managedEvidenceArtifactId,
  });
}

export async function validateReleaseManifest({
  manifest,
  path,
  intent,
  candidate,
  artifactId,
  config,
  managedEvidence,
  managedEvidenceArtifactId,
  root = process.cwd(),
}: ManifestChecks & {
  manifest?: ReleaseManifest;
  path?: string;
  root?: string;
}): Promise<ReleaseManifest> {
  let value = manifest as ReleaseManifest;
  if (path) {
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(resolve(path)));
    } catch {
      throw usageError("release manifest is unreadable or is not valid UTF-8");
    }
    try {
      value = JSON.parse(source) as ReleaseManifest;
    } catch {
      throw usageError("release manifest is malformed JSON");
    }
    equal("release manifest canonical encoding", stableJson(value), source);
    equal("release manifest filename", canonicalManifestFilename(value.version), basename(path));
  }

  if (!managedEvidence) throw usageError("managed evidence is required to validate a release-complete manifest");
  const checkedManagedEvidence = await validateManagedD1Evidence({
    evidence: managedEvidence,
    candidateSha256: candidate?.sha256,
    sourceCommit: intent?.sourceCommit,
    runId: intent?.workflowRunId,
    runUrl: intent?.workflowUrl,
    trigger: intent ? "release" : undefined,
    config,
    root,
    requirePassing: true,
  });
  return semanticManifest(value, {
    intent,
    candidate,
    artifactId,
    config,
    managedEvidence: checkedManagedEvidence,
    managedEvidenceArtifactId,
  });
}

export async function writeReleaseManifest({
  output,
  root = process.cwd(),
  ...options
}: CreateManifestOptions & { output: string; root?: string }): Promise<ReleaseManifest> {
  const managedEvidence = await validateManagedD1Evidence({
    evidence: options.managedEvidence,
    candidateSha256: options.candidate.sha256,
    sourceCommit: options.intent.sourceCommit,
    runId: options.intent.workflowRunId,
    runUrl: options.intent.workflowUrl,
    trigger: "release",
    config: options.config,
    root,
    requirePassing: true,
  });
  const manifest = createReleaseManifest({ ...options, managedEvidence });
  const expected = canonicalManifestFilename(manifest.version);
  if (basename(output) !== expected) throw usageError(`canonical manifest filename mismatch: expected ${expected}`);
  await validateReleaseManifest({ manifest, ...options, managedEvidence, root });
  await writeFile(resolve(output), stableJson(manifest));
  return manifest;
}

function gitAncestor(source: string, branch: string): Promise<boolean> {
  return new Promise<boolean>((ok, fail) => {
    const child = spawn("git", ["merge-base", "--is-ancestor", source, `origin/${branch}`], { stdio: "ignore" });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? ok(true) : code === 1 ? ok(false) : fail(new Error(`git merge-base exited ${code}`)),
    );
  });
}

function args(argv: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined)
      throw usageError("arguments must be --name value pairs");
    result[argv[i].slice(2)] = argv[i + 1];
  }
  return result;
}

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(resolve(path), "utf8")) as T;

async function cli(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const values = args(rest);
  const output = values.output;
  if (command === "intent") {
    const intent = await resolveReleaseIntent({
      eventName: values.event,
      refType: values["ref-type"],
      refName: values["ref-name"],
      sourceCommit: values.sha,
      defaultBranch: values["default-branch"],
      workflowRunId: values["run-id"],
      serverUrl: values["server-url"],
      repository: values.repository,
      isAncestor: gitAncestor,
    });
    await writeFile(resolve(output), stableJson(intent));
  } else if (command === "stage-candidate") {
    const intent = await readJson<ReleaseIntent>(values.intent);
    await writeCandidateBundle({ wasmPath: values.wasm, directory: output, intent });
  } else if (command === "validate-candidate") {
    const intent = await readJson<ReleaseIntent>(values.intent);
    const candidate = await validateCandidateBundle({ directory: values.directory, intent });
    if (output) await writeFile(resolve(output), stableJson(candidate));
  } else if (command === "validate-evidence") {
    const config = await loadConfig();
    await validateCompatibilityEvidence({
      path: values.path,
      candidateSha256: values.sha256,
      sqlcVersion: values.sqlc,
      config,
    });
  } else if (command === "validate-compatibility-set") {
    const config = await loadConfig();
    const paths = await readJson<string[]>(values.evidence);
    await validateCompatibilitySet({ paths, candidateSha256: values.sha256, config });
  } else if (command === "manifest") {
    const intent = await readJson<ReleaseIntent>(values.intent);
    const candidate = await validateCandidateBundle({ directory: values.candidate, intent });
    const config = await loadConfig();
    const paths = await readJson<string[]>(values.evidence);
    const evidence = await collectCompatibilityEvidence({ paths, candidateSha256: candidate.sha256, config });
    const managedEvidence = await readJson<ManagedD1Evidence>(values["managed-evidence"]);
    await writeReleaseManifest({
      output,
      intent,
      candidate,
      artifactId: values["artifact-id"],
      config,
      evidence,
      managedEvidence,
      managedEvidenceArtifactId: values["managed-evidence-artifact-id"],
    });
  } else if (command === "validate-manifest") {
    const intent = await readJson<ReleaseIntent>(values.intent);
    const candidate = await validateCandidateBundle({ directory: values.candidate, intent });
    const config = await loadConfig();
    let managedEvidence: ManagedD1Evidence | undefined;
    if (values["managed-evidence"])
      managedEvidence = await validateManagedD1Evidence({
        path: values["managed-evidence"],
        candidateSha256: candidate.sha256,
        sourceCommit: intent.sourceCommit,
        runId: intent.workflowRunId,
        runUrl: intent.workflowUrl,
        trigger: "release",
        config,
        requirePassing: true,
      });
    await validateReleaseManifest({
      path: values.manifest,
      intent,
      candidate,
      artifactId: values["artifact-id"],
      config,
      managedEvidence,
      managedEvidenceArtifactId: values["managed-evidence-artifact-id"],
    });
  } else throw usageError(`unknown release-contract command ${command}`);
}

runAsCli(import.meta.url, cli);
