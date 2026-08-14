import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const release = () => import("../scripts/release-contract.mjs");
const artifactsApi = () => import("../scripts/github-run-artifacts.mjs");
const compatibility = () => import("../scripts/compatibility-config.mjs");
const evidenceWriter = () => import("../scripts/write-compatibility-evidence.mjs");

type ReleaseIntent = {
  version: string;
  tag: string | null;
  sourceCommit: string;
  defaultBranch: string;
  dryRun: boolean;
  workflowRunId: string;
  workflowUrl: string;
};

type CandidateDescriptor = {
  schemaVersion: 1;
  plugin: "sqlc-d1-typescript";
  version: string;
  tag: string | null;
  sourceCommit: string;
  workflowRunId: string;
  workflowUrl: string;
  buildPolicy: "build-once-exact-artifact";
  filename: string;
  size: number;
  sha256: string;
};

const sha = "0123456789abcdef0123456789abcdef01234567";
const digest = "a".repeat(64);
const baseIntent = (overrides: Partial<ReleaseIntent> = {}): ReleaseIntent => ({
  version: "0.2.0",
  tag: null,
  sourceCommit: sha,
  defaultBranch: "main",
  dryRun: true,
  workflowRunId: "123",
  workflowUrl: "https://github.com/o/r/actions/runs/123",
  ...overrides,
});

for (const value of ["0.2.0", "1.0.0", "0.2.0-rc.1", "1.2.3-alpha.0", "1.2.3-0A"])
  test(`release/semver accepts ${value}`, async () => {
    const { parseSemver } = await release();
    assert.equal(parseSemver(value), value);
    assert.equal(parseSemver(`v${value}`, { prefixed: true }), value);
  });

for (const value of [
  "0.2",
  "01.2.3",
  "1.02.3",
  "1.2.03",
  "1.2.3-01",
  "1.2.3-",
  "1.2.3-alpha..1",
  "1.2.3+build",
  "version1",
  "v1.2.3",
])
  test(`release/semver rejects ${value}`, async () => {
    const { parseSemver } = await release();
    assert.throws(() => parseSemver(value), /expected/);
  });

test("release/intent resolves tag and manual identity only after ancestry", async () => {
  const { resolveReleaseIntent } = await release();
  const calls: string[] = [];
  const tag = await resolveReleaseIntent({
    eventName: "push",
    refType: "tag",
    refName: "v0.2.0-rc.1",
    sourceCommit: sha,
    defaultBranch: "main",
    workflowRunId: "456",
    repository: "o/r",
    isAncestor: async (source, branch) => {
      calls.push(`${source}:${branch}`);
      return true;
    },
  });

  assert.equal(tag.version, "0.2.0-rc.1");
  assert.equal(tag.tag, "v0.2.0-rc.1");
  assert.equal(tag.dryRun, false);
  assert.equal(tag.workflowUrl, "https://github.com/o/r/actions/runs/456");
  assert.deepEqual(calls, [`${sha}:main`]);

  await assert.rejects(
    resolveReleaseIntent({
      eventName: "workflow_dispatch",
      manualVersion: "0.2.0",
      sourceCommit: sha,
      defaultBranch: "main",
      workflowRunId: "456",
      repository: "o/r",
      isAncestor: async () => false,
    }),
    /not reachable from default branch main/,
  );

  await assert.rejects(
    resolveReleaseIntent({
      eventName: "workflow_dispatch",
      manualVersion: "v0.2.0",
      sourceCommit: sha,
      defaultBranch: "main",
      workflowRunId: "456",
      repository: "o/r",
      isAncestor: async () => true,
    }),
    /expected MAJOR/,
  );
});

test("release/canonical filenames have no legacy alias", async () => {
  const { canonicalManifestFilename, canonicalWasmFilename } = await release();
  assert.equal(canonicalWasmFilename("0.2.0"), "sqlc-gen-d1-typescript_0.2.0.wasm");
  assert.equal(canonicalManifestFilename("0.2.0"), "sqlc-gen-d1-typescript_0.2.0.manifest.json");
  assert.notEqual(canonicalManifestFilename("0.2.0"), "release-manifest.json");
});

test("release/candidate stages and validates exact retained bytes and metadata", async () => {
  const { writeCandidateBundle, validateCandidateBundle } = await release();
  const root = await mkdtemp(resolve(tmpdir(), "release-candidate-"));
  try {
    const wasm = resolve(root, "source.wasm"),
      bundle = resolve(root, "candidate");
    await writeFile(wasm, "retained bytes");
    const descriptor = await writeCandidateBundle({ wasmPath: wasm, directory: bundle, intent: baseIntent() });
    assert.equal(await readFile(resolve(bundle, descriptor.filename), "utf8"), "retained bytes");
    assert.deepEqual(await validateCandidateBundle({ directory: bundle, intent: baseIntent() }), descriptor);
    assert.equal((await readFile(resolve(bundle, "candidate.json"), "utf8")).endsWith("\n"), true);

    await writeFile(resolve(bundle, "plugin.wasm"), "alias");
    await assert.rejects(
      validateCandidateBundle({ directory: bundle, intent: baseIntent() }),
      /candidate bundle files mismatch/,
    );

    await unlink(resolve(bundle, "plugin.wasm"));
    await writeFile(resolve(bundle, descriptor.filename), "mutated bytes");
    await assert.rejects(validateCandidateBundle({ directory: bundle, intent: baseIntent() }), /SHA-256 mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release/candidate rejects unknown and intent-mismatched metadata", async () => {
  const { writeCandidateBundle, validateCandidateBundle, stableJson } = await release();
  const root = await mkdtemp(resolve(tmpdir(), "release-candidate-mutation-"));
  try {
    const wasm = resolve(root, "plugin.wasm"),
      bundle = resolve(root, "candidate");
    await writeFile(wasm, "bytes");
    await writeCandidateBundle({ wasmPath: wasm, directory: bundle, intent: baseIntent() });
    const path = resolve(bundle, "candidate.json");
    const metadata = JSON.parse(await readFile(path, "utf8"));
    metadata.secret = "no";
    await writeFile(path, stableJson(metadata));
    await assert.rejects(
      validateCandidateBundle({ directory: bundle, intent: baseIntent() }),
      /candidate.json keys mismatch/,
    );

    delete metadata.secret;
    metadata.sourceCommit = "f".repeat(40);
    await writeFile(path, stableJson(metadata));
    await assert.rejects(
      validateCandidateBundle({ directory: bundle, intent: baseIntent() }),
      /candidate.sourceCommit mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release/artifact discovery is run-scoped, exact, paginated, and token-redacted", async () => {
  const { listRunArtifacts, selectExactRunArtifact } = await artifactsApi();
  const urls: string[] = [];
  const token = "super-secret";
  const fake = async (url: string) => {
    urls.push(url);
    return new Response(
      '{"total_count":1,"artifacts":[{"id":9007199254740993,"name":"candidate-123","expired":false}]}',
      { status: 200 },
    );
  };
  const artifacts = await listRunArtifacts({
    owner: "o",
    repo: "r",
    runId: "123",
    name: "candidate-123",
    token,
    fetchImpl: fake as typeof fetch,
  });
  assert.deepEqual(selectExactRunArtifact(artifacts, "candidate-123"), {
    mode: "reuse",
    artifactId: "9007199254740993",
    name: "candidate-123",
  });
  assert.match(urls[0], /actions\/runs\/123\/artifacts\?name=candidate-123/);
  assert.doesNotMatch(urls[0], /secret/);

  assert.deepEqual(selectExactRunArtifact([{ id: 1, name: "candidate-123-extra", expired: false }], "candidate-123"), {
    mode: "create",
  });
  assert.throws(
    () => selectExactRunArtifact([], "candidate-123", { allowCreate: false }),
    /missing; start a new workflow run/,
  );
  assert.throws(
    () =>
      selectExactRunArtifact(
        [
          { id: 1, name: "x", expired: false },
          { id: 2, name: "x", expired: false },
        ],
        "x",
      ),
    /duplicate/,
  );
  assert.throws(() => selectExactRunArtifact([{ id: 1, name: "x", expired: true }], "x"), /expired/);

  const timeoutFetch = (async () => {
    throw new Error(`timeout ${token}`);
  }) as typeof fetch;
  await assert.rejects(
    listRunArtifacts({ owner: "o", repo: "r", runId: "123", name: "x", token, fetchImpl: timeoutFetch }),
    (error: Error) => !error.message.includes(token) && /timeout \[REDACTED\]/.test(error.message),
  );

  const malformedFetch = (async () => new Response("no", { status: 200 })) as typeof fetch;
  await assert.rejects(
    listRunArtifacts({ owner: "o", repo: "r", runId: "123", name: "x", token, fetchImpl: malformedFetch }),
    /malformed JSON/,
  );

  const prefixFetch = (async () =>
    new Response(
      '{"total_count":3,"artifacts":[{"id":1,"name":"managed-d1-evidence-123-1","expired":false},{"id":2,"name":"other","expired":false},{"id":3,"name":"managed-d1-evidence-123-2","expired":false}]}',
    )) as typeof fetch;
  const prefixed = await listRunArtifacts({
    owner: "o",
    repo: "r",
    runId: "123",
    prefix: "managed-d1-evidence-123-",
    token,
    fetchImpl: prefixFetch,
  });
  assert.deepEqual(
    prefixed.map(({ id }) => String(id)),
    ["1", "3"],
  );

  const { selectPassingManagedEvidence } = await artifactsApi();
  const attempts: string[] = [];
  assert.deepEqual(
    await selectPassingManagedEvidence(prefixed, async (artifact) => {
      attempts.push(String(artifact.id));
      return String(artifact.id) === "3" ? { remoteDate: "2026-02-05" } : null;
    }),
    { mode: "reuse", artifactId: "3", name: "managed-d1-evidence-123-2", remoteDate: "2026-02-05" },
  );
  assert.deepEqual(attempts, ["3"]);
  assert.deepEqual(await selectPassingManagedEvidence(prefixed, async () => null), { mode: "create" });
});

async function evidenceFiles(root: string, candidateSha256 = digest): Promise<string[]> {
  const { loadCompatibilityConfig } = await compatibility();
  const { writeCompatibilityEvidence } = await evidenceWriter();
  const config = await loadCompatibilityConfig();
  const paths: string[] = [];
  for (const sample of config.sqlc.samples) {
    const output = resolve(root, `${sample.version}.json`);
    await writeCompatibilityEvidence({
      output,
      matrixResult: {
        sqlcVersion: sample.version,
        fixtures: [],
        knownExceptions: [...config.sqlc.knownExceptions],
        typescriptVersion: config.typescript.current,
        candidateSha256,
        cleanup: "confirmed",
      },
      actualTools: { node: config.tools.node, npm: config.tools.npm, bun: config.tools.bun },
    });
    paths.push(output);
  }
  return paths;
}

const managedEvidence = () => ({
  schemaVersion: 1,
  candidateSha256: digest,
  sourceCommit: sha,
  run: {
    id: "123",
    url: "https://github.com/o/r/actions/runs/123",
    trigger: "release",
    startedAt: "2026-02-05T12:00:00.000Z",
    completedAt: "2026-02-05T12:01:00.000Z",
    remoteDate: "2026-02-05",
  },
  configuration: { compatibilityDate: "2026-02-05", compatibilityFlags: [], wranglerVersion: "4.63.0" },
  resources: {
    worker: {
      status: "created",
      name: "sqlc-d1-ci-20260205T120000Z-123-1-deadbeef",
      id: "sqlc-d1-ci-20260205T120000Z-123-1-deadbeef",
    },
    database: {
      status: "created",
      name: "sqlc-d1-ci-20260205T120000Z-123-1-deadbeef",
      id: "123e4567-e89b-42d3-a456-426614174000",
    },
  },
  scenarios: [
    "value-command-metadata",
    "macro-smoke",
    "batch-success",
    "batch-rollback",
    "direct-session",
    "bookmark-transfer",
    "native-error-identity",
    "post-execution-result-error",
  ].map((id) => ({ id: `managed-d1/${id}`, status: "passed", attempts: 1 })),
  test: { status: "passed" },
  cleanup: { status: "confirmed", worker: "deleted", database: "deleted", emergencyRecovery: "not-needed" },
});

const descriptor = (): CandidateDescriptor => ({
  schemaVersion: 1,
  plugin: "sqlc-d1-typescript",
  version: "0.2.0",
  tag: null,
  sourceCommit: sha,
  workflowRunId: "123",
  workflowUrl: "https://github.com/o/r/actions/runs/123",
  buildPolicy: "build-once-exact-artifact",
  filename: "sqlc-gen-d1-typescript_0.2.0.wasm",
  size: 42,
  sha256: digest,
});

test("release/evidence aggregation and deterministic manifest use authoritative facts", async () => {
  const {
    collectCompatibilityEvidence,
    createReleaseManifest,
    validateReleaseManifest,
    writeReleaseManifest,
    canonicalManifestFilename,
    stableJson,
  } = await release();
  const { loadCompatibilityConfig } = await compatibility();
  const root = await mkdtemp(resolve(tmpdir(), "release-evidence-"));
  try {
    const config = await loadCompatibilityConfig();
    const paths = await evidenceFiles(root);
    const evidence = await collectCompatibilityEvidence({ paths: paths.reverse(), candidateSha256: digest, config });
    assert.deepEqual(
      (evidence as Array<{ tools: { sqlc: string[] } }>).map((item) => item.tools.sqlc[0]),
      config.sqlc.samples.map(({ version }) => version),
    );

    const managed = managedEvidence();
    const manifest = createReleaseManifest({
      intent: baseIntent(),
      candidate: descriptor(),
      artifactId: "456",
      config,
      evidence,
      managedEvidence: managed,
      managedEvidenceArtifactId: "789",
    });
    await validateReleaseManifest({
      manifest,
      intent: baseIntent(),
      candidate: descriptor(),
      artifactId: "456",
      config,
      managedEvidence: managed,
      managedEvidenceArtifactId: "789",
    });

    assert.deepEqual(manifest.remote_d1, { result: "passed", date: "2026-02-05", evidence_artifact_id: "789" });
    assert.equal(manifest.tag, null);
    assert.equal(manifest.dry_run, true);
    assert.deepEqual(
      (manifest.tested_versions as { sqlc: string[] }).sqlc,
      config.sqlc.samples.map(({ version }) => version),
    );

    const output = resolve(root, canonicalManifestFilename("0.2.0"));
    await writeReleaseManifest({
      output,
      intent: baseIntent(),
      candidate: descriptor(),
      artifactId: "456",
      config,
      evidence,
      managedEvidence: managed,
      managedEvidenceArtifactId: "789",
    });
    const source = await readFile(output, "utf8");
    assert.equal(source.endsWith("\n") && !source.endsWith("\n\n"), true);
    assert.equal(source, stableJson(JSON.parse(source)));
    await writeFile(output, JSON.stringify(JSON.parse(source)));

    await assert.rejects(
      validateReleaseManifest({
        path: output,
        intent: baseIntent(),
        candidate: descriptor(),
        artifactId: "456",
        config,
      }),
      /canonical encoding mismatch/,
    );

    await writeFile(output, source);
    await assert.rejects(
      writeReleaseManifest({
        output: resolve(root, "release-manifest.json"),
        intent: baseIntent(),
        candidate: descriptor(),
        artifactId: "456",
        config,
        evidence,
        managedEvidence: managed,
        managedEvidenceArtifactId: "789",
      }),
      /canonical manifest filename/,
    );

    await assert.rejects(
      collectCompatibilityEvidence({ paths: paths.slice(1), candidateSha256: digest, config }),
      /version set mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release/manifest rejects unknown fields and inconsistent remote or tag state", async () => {
  const { collectCompatibilityEvidence, createReleaseManifest, validateReleaseManifest } = await release();
  const { loadCompatibilityConfig } = await compatibility();
  const root = await mkdtemp(resolve(tmpdir(), "release-manifest-"));
  try {
    const config = await loadCompatibilityConfig();
    const evidence = await collectCompatibilityEvidence({
      paths: await evidenceFiles(root),
      candidateSha256: digest,
      config,
    });
    const managed = managedEvidence();
    const manifest = createReleaseManifest({
      intent: baseIntent(),
      candidate: descriptor(),
      artifactId: "456",
      config,
      evidence,
      managedEvidence: managed,
      managedEvidenceArtifactId: "789",
    });

    await assert.rejects(
      validateReleaseManifest({ manifest, intent: baseIntent(), candidate: descriptor(), artifactId: "456", config }),
      /managed evidence.*required/i,
    );

    await assert.rejects(
      validateReleaseManifest({
        manifest,
        intent: baseIntent(),
        candidate: descriptor(),
        artifactId: "456",
        config,
        managedEvidence: managed,
      }),
      /managed.*artifact ID.*required/i,
    );

    await assert.rejects(
      validateReleaseManifest({
        manifest: { ...manifest, credentials: "secret" },
        managedEvidence: managed,
        managedEvidenceArtifactId: "789",
      }),
      /schema mismatch/,
    );

    await assert.rejects(
      validateReleaseManifest({
        manifest: { ...manifest, dry_run: false },
        managedEvidence: managed,
        managedEvidenceArtifactId: "789",
      }),
      /tag\/dry_run mismatch/,
    );

    await assert.rejects(
      validateReleaseManifest({
        manifest: { ...manifest, remote_d1: { result: "passed", date: null, evidence_artifact_id: null } },
        managedEvidence: managed,
        managedEvidenceArtifactId: "789",
      }),
      /schema mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
