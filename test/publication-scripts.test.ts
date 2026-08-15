import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const publication = () => import("../scripts/publication-contract.mjs");
const r2 = () => import("../scripts/r2-cli.mjs");
const github = () => import("../scripts/github-release-api.mjs");
const publisher = () => import("../scripts/publish-release.mjs");
const release = () => import("../scripts/release-contract.mjs");
const compatibility = () => import("../scripts/compatibility-config.mjs");

const R2 = {
  endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "SECRETTESTSECRETTESTSECRETTEST00" },
};
const fixedClock = () => new Date("2026-02-05T12:00:00.000Z");

/**
 * A fetch double that answers only the requests it was primed for. Anything else is a
 * test failure rather than a silent real network call.
 */
function fetchDouble(routes: Record<string, (request: { method: string; url: string; init: any }) => Response>) {
  const calls: { method: string; url: string; init: any }[] = [];
  const impl = async (url: string, init: any = {}) => {
    const method = String(init.method ?? "GET");
    const call = { method, url: String(url), init };
    calls.push(call);
    const route = Object.keys(routes).find((pattern) => {
      const [routeMethod, ...rest] = pattern.split(" ");
      return routeMethod === method && String(url).includes(rest.join(" "));
    });
    if (!route) throw new Error(`unexpected request ${method} ${url}`);
    return routes[route](call);
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

const sourceCommit = "b".repeat(40);
const runId = "123";

type Intent = {
  version: string;
  tag: string | null;
  sourceCommit: string;
  defaultBranch: string;
  dryRun: boolean;
  workflowRunId: string;
  workflowUrl: string;
};

const intentFor = (overrides: Partial<Intent> = {}): Intent => ({
  version: "0.2.0",
  tag: "v0.2.0",
  sourceCommit,
  defaultBranch: "main",
  dryRun: false,
  workflowRunId: runId,
  workflowUrl: `https://github.com/mkuznets/sqlc-d1-typescript/actions/runs/${runId}`,
  ...overrides,
});

type CompatibilityConfig = Awaited<ReturnType<Awaited<ReturnType<typeof compatibility>>["loadCompatibilityConfig"]>>;

const managedEvidenceFor = (intent: Intent, candidateSha256: string, compatibilityConfig: CompatibilityConfig) => ({
  schemaVersion: 1,
  candidateSha256,
  sourceCommit: intent.sourceCommit,
  run: {
    id: intent.workflowRunId,
    url: intent.workflowUrl,
    trigger: "release",
    startedAt: "2026-02-05T12:00:00.000Z",
    completedAt: "2026-02-05T12:01:00.000Z",
    remoteDate: "2026-02-05",
  },
  configuration: {
    compatibilityDate: compatibilityConfig.cloudflare.compatibilityDate,
    compatibilityFlags: compatibilityConfig.cloudflare.compatibilityFlags,
    wranglerVersion: compatibilityConfig.cloudflare.wrangler,
  },
  resources: {
    worker: {
      status: "created",
      name: "sqlc-d1-ci-20260205t120000z-123-1-deadbeef",
      id: "sqlc-d1-ci-20260205t120000z-123-1-deadbeef",
    },
    database: {
      status: "created",
      name: "sqlc-d1-ci-20260205t120000z-123-1-deadbeef",
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

/**
 * One publication candidate on disk plus the manifest the release spine assembles for
 * it, built through the real release-contract helpers so a manifest change is caught
 * here rather than in production.
 */
async function publicationFixture(overrides: Partial<Intent> = {}) {
  const { writeCandidateBundle, createReleaseManifest, stableJson } = await release();
  const { loadCompatibilityConfig } = await compatibility();
  const intent = intentFor(overrides);
  const root = await mkdtemp(resolve(tmpdir(), "publication-"));
  const wasm = resolve(root, "source.wasm");
  await writeFile(wasm, `candidate bytes for ${intent.version}`);
  const candidateDir = resolve(root, "retained");
  const candidate = await writeCandidateBundle({ wasmPath: wasm, directory: candidateDir, intent });
  const config = await loadCompatibilityConfig({});
  const managedEvidence = managedEvidenceFor(intent, candidate.sha256, config);
  const manifest = createReleaseManifest({
    intent,
    candidate,
    artifactId: "9001",
    config,
    evidence: config.sqlc.samples.map(() => ({})),
    managedEvidence,
    managedEvidenceArtifactId: "9002",
  });
  const manifestSource = stableJson(manifest);
  const manifestBytes = Buffer.from(manifestSource, "utf8");
  const manifestPath = resolve(root, `sqlc-gen-d1-typescript_${intent.version}.manifest.json`);
  await writeFile(manifestPath, manifestBytes);
  return {
    root,
    intent,
    candidate,
    candidateDir,
    candidateBytes: await readFile(resolve(candidateDir, candidate.filename)),
    config,
    managedEvidence,
    manifest,
    manifestPath,
    manifestBytes,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  };
}

test("verification/publication-object-contract binds keys, headers, and object metadata to one version", async () => {
  const {
    canonicalObjectKey,
    rehearsalObjectKey,
    publicUrlForKey,
    isVersionKey,
    objectHttpMetadata,
    objectUserMetadata,
    assertHttpMetadata,
  } = await publication();

  assert.equal(canonicalObjectKey("0.2.0"), "plugins/sqlc-gen-d1-typescript_0.2.0.wasm");
  assert.equal(rehearsalObjectKey("0.2.0", "77"), "rehearsal/77/sqlc-gen-d1-typescript_0.2.0.wasm");
  assert.equal(
    publicUrlForKey(canonicalObjectKey("0.2.0")),
    "https://sqlc.mkuznets.com/plugins/sqlc-gen-d1-typescript_0.2.0.wasm",
  );
  assert.equal(isVersionKey(canonicalObjectKey("0.2.0")), true);
  assert.equal(isVersionKey(rehearsalObjectKey("0.2.0", "77")), false);
  assert.throws(() => rehearsalObjectKey("0.2.0", "not-a-run"), /decimal workflow run ID/);
  assert.throws(() => canonicalObjectKey("v0.2.0"), /expected MAJOR/);

  assert.deepEqual(objectHttpMetadata({ filename: "sqlc-gen-d1-typescript_0.2.0.wasm" }), {
    "content-type": "application/wasm",
    "content-disposition": 'attachment; filename="sqlc-gen-d1-typescript_0.2.0.wasm"',
    "cache-control": "public, max-age=31536000, immutable",
  });
  assert.deepEqual(objectUserMetadata({ sha256: "a".repeat(64), version: "0.2.0", sourceCommit }), {
    sha256: "a".repeat(64),
    version: "0.2.0",
    "source-commit": sourceCommit,
  });
  assert.throws(() => objectUserMetadata({ sha256: "A".repeat(64), version: "0.2.0", sourceCommit }), /lowercase/);

  const expected = objectHttpMetadata({ filename: "sqlc-gen-d1-typescript_0.2.0.wasm" });
  assert.equal(assertHttpMetadata({ ...expected, etag: "irrelevant" }, expected), true);
  assert.equal(
    assertHttpMetadata({ "Content-Type": "application/wasm" }, { "content-type": "application/wasm" }),
    true,
  );
  assert.throws(
    () => assertHttpMetadata({ ...expected, "cache-control": "no-store" }, expected),
    /object header cache-control is "no-store"/,
  );
  assert.throws(() => assertHttpMetadata({}, expected), /object header content-type is null/);
});

test("verification/publication-release-body advertises exactly the manifest's artifact", async () => {
  const { buildReleaseBody, assertBodyAgreesWithManifest, PRERELEASE_NOTICE } = await publication();
  const fixture = await publicationFixture();
  try {
    const options = {
      manifest: fixture.manifest,
      intent: fixture.intent,
      notes: "- first change\n- second change",
      manifestSha256: fixture.manifestSha256,
    };
    const body = buildReleaseBody(options);
    assert.equal(body, buildReleaseBody(options), "the same inputs must produce a byte-identical body");

    assert.ok(body.startsWith(PRERELEASE_NOTICE));
    assert.match(body, /## Configure sqlc/);
    assert.match(body, /^version: "2"$/m);
    assert.ok(body.includes(`url: ${fixture.manifest.artifact.url}`));
    assert.ok(body.includes(`sha256: ${fixture.manifest.artifact.sha256}`));
    assert.ok(body.includes(`${fixture.manifest.artifact.size} bytes`));
    assert.ok(body.includes(fixture.config.sqlc.samples[0].version));
    assert.ok(body.includes(fixture.config.cloudflare.compatibilityDate));
    assert.ok(body.includes("Managed D1 verification passed on 2026-02-05"));
    assert.ok(body.includes(fixture.intent.workflowUrl));
    assert.ok(
      body.includes("https://github.com/mkuznets/sqlc-d1-typescript/blob/v0.2.0/docs/compatibility.md"),
      "documentation links must be pinned to the released tag",
    );
    assert.ok(body.includes("https://github.com/mkuznets/sqlc-d1-typescript/blob/v0.2.0/docs/troubleshooting.md"));
    assert.ok(body.includes("- first change\n- second change"));
    assert.ok(body.includes(`sqlc-gen-d1-typescript_0.2.0.manifest.json`));
    assert.ok(body.includes(fixture.manifestSha256));

    const withoutNotes = buildReleaseBody({ ...options, notes: "   \n " });
    assert.match(withoutNotes, /No changelog was supplied in the tag message/);
    assert.ok(withoutNotes.includes("https://github.com/mkuznets/sqlc-d1-typescript/commits/v0.2.0"));

    assert.equal(
      assertBodyAgreesWithManifest(body, fixture.manifest, { manifestSha256: fixture.manifestSha256 }),
      true,
    );
    assert.throws(
      () =>
        assertBodyAgreesWithManifest(`${body}\nstale digest ${"c".repeat(64)}`, fixture.manifest, {
          manifestSha256: fixture.manifestSha256,
        }),
      /quotes SHA-256 cccc/,
    );
    assert.throws(
      () =>
        assertBodyAgreesWithManifest(
          body.split(fixture.manifest.artifact.sha256).join("e".repeat(64)),
          fixture.manifest,
          { manifestSha256: fixture.manifestSha256 },
        ),
      /does not quote the artifact SHA-256/,
    );
    assert.throws(
      () =>
        assertBodyAgreesWithManifest(
          body.split(fixture.manifest.artifact.url).join("https://elsewhere/x.wasm"),
          fixture.manifest,
          { manifestSha256: fixture.manifestSha256 },
        ),
      /does not quote the artifact URL/,
    );
    assert.throws(
      () => assertBodyAgreesWithManifest(body, fixture.manifest),
      /quotes SHA-256 [0-9a-f]{4}/,
      "the manifest digest is foreign unless it is declared",
    );
    assert.throws(() => buildReleaseBody({ ...options, manifestSha256: "short" }), /must quote the manifest SHA-256/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification/publication-record-contract keeps the record closed, redacted, and digest-consistent", async () => {
  const { createPublicationRecord, validatePublicationRecord, canonicalObjectKey, publicUrlForKey } =
    await publication();
  const fixture = await publicationFixture();
  try {
    const key = canonicalObjectKey(fixture.intent.version);
    const digest = fixture.candidate.sha256;
    const base = createPublicationRecord({
      mode: "publish",
      intent: fixture.intent,
      candidate: fixture.candidate,
      artifactId: "9001",
      manifest: fixture.manifest,
      manifestSize: fixture.manifestBytes.length,
      manifestSha256: fixture.manifestSha256,
      verifiedSha256: digest,
      r2: {
        bucket: "sqlc",
        key,
        outcome: "created",
        http_metadata: {
          content_type: "application/wasm",
          content_disposition: `attachment; filename="${fixture.candidate.filename}"`,
          cache_control: "public, max-age=31536000, immutable",
        },
        metadata_sha256: digest,
        direct_download_sha256: digest,
        public_url: publicUrlForKey(key),
        public_download_sha256: digest,
        public_attempts: 3,
      },
      github: {
        release_id: "1234567",
        release_url: "https://github.com/mkuznets/sqlc-d1-typescript/releases/tag/v0.2.0",
        tag_name: "v0.2.0",
        prerelease: false,
        draft_outcome: "created",
        asset_sha256: { wasm: digest, manifest: fixture.manifestSha256 },
        published: true,
        immutable_releases: { enabled: true, enforced_by_owner: false },
      },
      order: [
        { phase: "draft-release", at: "2026-02-05T12:00:00.000Z" },
        { phase: "version-key", at: "2026-02-05T12:00:01.000Z" },
        { phase: "publish", at: "2026-02-05T12:00:02.000Z" },
      ],
      teardown: { object: "not-created", draft: "not-created" },
    });

    assert.deepEqual(await validatePublicationRecord({ record: base }), base);

    const clone = (): any => structuredClone(base);
    const reject = async (mutate: (record: any) => void, pattern: RegExp) => {
      const record = clone();
      mutate(record);
      await assert.rejects(validatePublicationRecord({ record }), pattern);
    };

    await reject((record) => (record.unexpected = 1), /schema mismatch/);
    for (const forbidden of [
      "credentials",
      "authorization",
      "token",
      "secret",
      "signature",
      "headers",
      "stack",
      "cause",
      "responseBody",
    ])
      await reject((record) => (record[forbidden] = "leak"), /prohibited field|schema mismatch/);
    await reject((record) => (record.r2.credentials = "leak"), /prohibited field/);
    await reject((record) => (record.r2.public_download_sha256 = "d".repeat(64)), /disagrees with verified_sha256/);
    await reject((record) => (record.github.asset_sha256.wasm = "d".repeat(64)), /disagrees with verified_sha256/);
    await reject((record) => (record.r2.direct_download_sha256 = null), /is missing although the release is published/);
    await reject((record) => (record.r2.public_url = "https://sqlc.mkuznets.com/elsewhere"), /r2.public_url/);
    await reject((record) => (record.dry_run = true), /mode\/dry_run/);
    await reject((record) => (record.mode = "dry-run"), /mode\/dry_run/);
    await reject((record) => (record.r2.outcome = "not-created"), /must name the version key/);
    await reject((record) => (record.r2.http_metadata.cache_control = "no-store"), /schema mismatch/);
    await reject(
      (record) => record.order.push({ phase: "digest-agreement", at: "2026-02-05T12:00:03.000Z" }),
      /records work after the release was published/,
    );

    const dryRun = clone();
    dryRun.mode = "dry-run";
    dryRun.dry_run = true;
    dryRun.tag = null;
    dryRun.github.published = false;
    dryRun.github.tag_name = "dry-run-v0.2.0-123";
    dryRun.r2.key = `rehearsal/${runId}/${fixture.candidate.filename}`;
    dryRun.r2.public_url = publicUrlForKey(dryRun.r2.key);
    dryRun.teardown = { object: "deleted", draft: "deleted" };
    assert.equal((await validatePublicationRecord({ record: dryRun })).mode, "dry-run");

    const publishedDryRun = structuredClone(dryRun);
    publishedDryRun.github.published = true;
    await assert.rejects(validatePublicationRecord({ record: publishedDryRun }), /never record a published release/);

    const versionKeyDryRun = structuredClone(dryRun);
    versionKeyDryRun.r2.key = key;
    versionKeyDryRun.r2.public_url = publicUrlForKey(key);
    await assert.rejects(validatePublicationRecord({ record: versionKeyDryRun }), /never write the version key/);

    const path = resolve(fixture.root, "publication-record.json");
    const { writePublicationJson } = await publication();
    await writePublicationJson(path, base);
    assert.deepEqual(await validatePublicationRecord({ path }), base);
    await writeFile(path, "{not json");
    await assert.rejects(validatePublicationRecord({ path }), /malformed JSON/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification/publication-object-command writes create-only and keeps credentials out of argv", async () => {
  const {
    putObjectCreateOnly,
    getObject,
    listBuckets,
    headBucket,
    deleteObject,
    commandEnvironment,
    r2Endpoint,
    md5Base64,
  } = await r2();
  const { objectHttpMetadata, objectUserMetadata, canonicalObjectKey } = await publication();

  assert.equal(r2Endpoint("0123456789abcdef0123456789abcdef"), R2.endpoint);
  assert.throws(() => r2Endpoint("not-an-account"), /account ID is required/);

  const body = Buffer.from("retained candidate bytes");
  const key = canonicalObjectKey("0.2.0");
  const httpMetadata = objectHttpMetadata({ filename: "sqlc-gen-d1-typescript_0.2.0.wasm" });
  const metadata = objectUserMetadata({ sha256: "a".repeat(64), version: "0.2.0", sourceCommit });

  // Metadata is a plain map; the x-amz-meta- prefix is the transport's business.
  assert.deepEqual(metadata, { sha256: "a".repeat(64), version: "0.2.0", "source-commit": sourceCommit });

  const runs: { args: string[]; env: Record<string, string> }[] = [];
  const runner =
    (outcome: { code: number; stdout?: string; stderr?: string }) => async (args: string[], options: any) => {
      runs.push({ args, env: options.env });
      return { code: outcome.code, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" };
    };

  assert.deepEqual(
    await putObjectCreateOnly({
      endpoint: R2.endpoint,
      bucket: "sqlc",
      key,
      bodyPath: "/tmp/candidate.wasm",
      contentMd5: md5Base64(body),
      httpMetadata,
      metadata,
      credentials: R2.credentials,
      run: runner({ code: 0 }),
    }),
    { outcome: "created" },
  );

  const args = runs[0].args;
  assert.deepEqual(args.slice(0, 2), ["s3api", "put-object"]);
  const flag = (name: string) => args[args.indexOf(name) + 1];
  assert.equal(flag("--if-none-match"), "*", "the write must be create-only");
  assert.equal(flag("--content-md5"), md5Base64(body));
  assert.equal(flag("--bucket"), "sqlc");
  assert.equal(flag("--key"), key);
  assert.equal(flag("--body"), "/tmp/candidate.wasm");
  assert.equal(flag("--content-type"), "application/wasm");
  assert.equal(flag("--cache-control"), "public, max-age=31536000, immutable");
  assert.equal(flag("--content-disposition"), 'attachment; filename="sqlc-gen-d1-typescript_0.2.0.wasm"');
  assert.deepEqual(JSON.parse(flag("--metadata")), metadata);

  // Credentials travel in the child environment, never in argv where a process
  // listing or a workflow log would pick them up.
  assert.ok(!args.join(" ").includes(R2.credentials.secretAccessKey));
  assert.ok(!args.join(" ").includes(R2.credentials.accessKeyId));
  assert.equal(runs[0].env.AWS_SECRET_ACCESS_KEY, R2.credentials.secretAccessKey);
  assert.equal(runs[0].env.AWS_ENDPOINT_URL, R2.endpoint);
  assert.equal(runs[0].env.AWS_DEFAULT_REGION, "auto");
  // aws-cli v2 would otherwise add a CRC32 checksum that R2 rejects.
  assert.equal(runs[0].env.AWS_REQUEST_CHECKSUM_CALCULATION, "when_required");

  assert.deepEqual(
    await putObjectCreateOnly({
      endpoint: R2.endpoint,
      bucket: "sqlc",
      key,
      bodyPath: "/tmp/candidate.wasm",
      contentMd5: md5Base64(body),
      httpMetadata,
      metadata,
      credentials: R2.credentials,
      run: runner({ code: 254, stderr: "An error occurred (PreconditionFailed) when calling the PutObject operation" }),
    }),
    { outcome: "exists" },
    "a rejected conditional write is an answer, not a crash",
  );

  await assert.rejects(
    putObjectCreateOnly({
      endpoint: R2.endpoint,
      bucket: "sqlc",
      key,
      bodyPath: "/tmp/candidate.wasm",
      contentMd5: md5Base64(body),
      httpMetadata,
      metadata,
      credentials: R2.credentials,
      run: runner({ code: 1, stderr: `boom for ${R2.credentials.secretAccessKey}` }),
    }),
    (error: Error) =>
      /aws exited 1/.test(error.message) &&
      error.message.includes("[REDACTED]") &&
      !error.message.includes(R2.credentials.secretAccessKey),
  );

  assert.deepEqual(
    await listBuckets({
      endpoint: R2.endpoint,
      credentials: R2.credentials,
      run: runner({ code: 0, stdout: JSON.stringify({ Buckets: [{ Name: "sqlc" }] }) }),
    }),
    { denied: false, buckets: ["sqlc"] },
  );
  assert.deepEqual(
    await listBuckets({
      endpoint: R2.endpoint,
      credentials: R2.credentials,
      run: runner({ code: 254, stderr: "An error occurred (AccessDenied)" }),
    }),
    { denied: true, buckets: null },
    "a bucket-scoped credential is denied here, and that denial is the evidence",
  );

  assert.equal(
    (
      await headBucket({
        endpoint: R2.endpoint,
        bucket: "sqlc",
        credentials: R2.credentials,
        run: runner({ code: 254, stderr: "An error occurred (404) when calling the HeadBucket operation: Not Found" }),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await getObject({
        endpoint: R2.endpoint,
        bucket: "sqlc",
        key,
        credentials: R2.credentials,
        run: runner({ code: 254, stderr: "An error occurred (NoSuchKey)" }),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await deleteObject({
        endpoint: R2.endpoint,
        bucket: "sqlc",
        key,
        credentials: R2.credentials,
        run: runner({ code: 0 }),
      })
    ).status,
    204,
  );

  assert.equal(commandEnvironment({ credentials: R2.credentials, endpoint: R2.endpoint, env: {} }).AWS_PAGER, "");
});

test("verification/publication-download-verification hashes what it downloaded, never what a server claimed", async () => {
  const { downloadReleaseAsset, resolveTagCommit, getImmutableReleases } = await github();
  const token = "ghs_TESTTOKENTESTTOKEN";
  const repository = "mkuznets/sqlc-d1-typescript";

  // The asset endpoint redirects to storage, which rejects a forwarded credential.
  const redirected = fetchDouble({
    "GET api.github.com/repos/mkuznets/sqlc-d1-typescript/releases/assets/42": () =>
      new Response("", { status: 302, headers: { location: "https://objects.githubusercontent.com/blob" } }),
    "GET objects.githubusercontent.com/blob": ({ init }) => {
      assert.equal(init.headers, undefined, "the storage hop must carry no headers at all");
      return new Response("retained bytes");
    },
  });
  assert.equal(
    (await downloadReleaseAsset({ repository, assetId: "42", token, fetchImpl: redirected.impl })).toString(),
    "retained bytes",
  );
  assert.equal(redirected.calls[0].init.redirect, "manual");
  assert.equal(redirected.calls[0].init.headers.accept, "application/octet-stream");
  assert.ok(String(redirected.calls[0].init.headers.authorization).includes(token));

  const withoutLocation = fetchDouble({
    "GET releases/assets/42": () => new Response("", { status: 302 }),
  });
  await assert.rejects(
    downloadReleaseAsset({ repository, assetId: "42", token, fetchImpl: withoutLocation.impl }),
    /redirected without a location header/,
  );

  const leaking = fetchDouble({
    "GET releases/assets/42": () => new Response(`bad credential ${token}`, { status: 401 }),
  });
  await assert.rejects(
    downloadReleaseAsset({ repository, assetId: "42", token, fetchImpl: leaking.impl }),
    (error: Error) => /HTTP 401/.test(error.message) && !error.message.includes(token),
  );

  // An annotated tag ref points at a tag object, not at the commit the gate verified.
  const annotated = fetchDouble({
    "GET git/ref/tags/v0.2.0": () => new Response(JSON.stringify({ object: { sha: "t".repeat(40), type: "tag" } })),
    "GET git/tags/tttt": () => new Response(JSON.stringify({ object: { sha: sourceCommit, type: "commit" } })),
  });
  assert.equal(
    await resolveTagCommit({ repository, tagName: "v0.2.0", token, fetchImpl: annotated.impl }),
    sourceCommit,
  );

  const lightweight = fetchDouble({
    "GET git/ref/tags/v0.2.0": () => new Response(JSON.stringify({ object: { sha: sourceCommit, type: "commit" } })),
  });
  assert.equal(
    await resolveTagCommit({ repository, tagName: "v0.2.0", token, fetchImpl: lightweight.impl }),
    sourceCommit,
  );
  assert.equal(lightweight.calls.length, 1, "a lightweight tag must not be dereferenced twice");

  const missing = fetchDouble({ "GET git/ref/tags/v0.2.0": () => new Response("", { status: 404 }) });
  assert.equal(await resolveTagCommit({ repository, tagName: "v0.2.0", token, fetchImpl: missing.impl }), null);

  const absentSetting = fetchDouble({ "GET immutable-releases": () => new Response("", { status: 404 }) });
  await assert.rejects(
    getImmutableReleases({ repository, token, fetchImpl: absentSetting.impl }),
    /confirm it manually in repository settings/,
  );
  const setting = fetchDouble({
    "GET immutable-releases": () => new Response(JSON.stringify({ enabled: true, enforced_by_owner: false })),
  });
  assert.deepEqual(await getImmutableReleases({ repository, token, fetchImpl: setting.impl }), {
    enabled: true,
    enforced_by_owner: false,
  });

  // The publication path hashes complete bodies. A convincing HEAD, a matching ETag,
  // or a plausible 200 never substitutes for the bytes themselves.
  const { publishPublication } = await publisher();
  const fixture = await publicationFixture();
  try {
    const swapped = publicationWorld({ publicBytes: Buffer.from("a different artifact") });
    const wrongBytes = await publishPublication(publishOptions(fixture, swapped, { publicAttempts: 5 }));
    assert.equal(wrongBytes.failure?.phase, "public-verification");
    assert.match(wrongBytes.failure!.detail, /this is not a propagation race/);
    assert.equal(wrongBytes.r2.public_attempts, 1, "a wrong digest fails immediately rather than polling");
    assert.equal(wrongBytes.github.published, false);

    const wrongHeaders = publicationWorld({ publicHeaders: { "content-type": "application/octet-stream" } });
    const headers = await publishPublication(publishOptions(fixture, wrongHeaders, { publicAttempts: 5 }));
    assert.equal(headers.failure?.phase, "public-verification");
    assert.match(headers.failure!.detail, /object header content-type is "application\/octet-stream"/);

    const propagating = publicationWorld({ publicMisses: 2 });
    const eventual = await publishPublication(publishOptions(fixture, propagating, { publicAttempts: 5 }));
    assert.equal(eventual.failure, undefined);
    assert.equal(eventual.r2.public_attempts, 3, "propagation is polled, not assumed");

    const never = publicationWorld({ publicMisses: 100 });
    const exhausted = await publishPublication(publishOptions(fixture, never, { publicAttempts: 4 }));
    assert.match(exhausted.failure!.detail, /never served the object within 4 attempts/);

    const refused = publicationWorld({ publicStatus: 403 });
    const hardFailure = await publishPublication(publishOptions(fixture, refused, { publicAttempts: 5 }));
    assert.match(hardFailure.failure!.detail, /HTTP 403, which is not a propagation answer/);

    // Correct object metadata and a correct HEAD do not make the body correct. Only
    // the hash of the bytes actually returned decides.
    const lyingStorage = publicationWorld({ directBytes: Buffer.from("truncated") });
    const trusted = await publishPublication(publishOptions(fixture, lyingStorage, { publicAttempts: 5 }));
    assert.equal(trusted.failure?.phase, "direct-verification");
    assert.match(trusted.failure!.detail, /is 9 bytes, expected/);
    assert.equal(trusted.github.published, false);

    // A draft body edited between the draft phase and publication is caught by the
    // digest-agreement phase, which re-reads the body from GitHub.
    const edited = publicationWorld({ tamperedBodyOnRead: `see ${"f".repeat(64)} at https://elsewhere/x.wasm` });
    const tampered = await publishPublication(publishOptions(fixture, edited, { publicAttempts: 5 }));
    assert.equal(tampered.failure?.phase, "digest-agreement");
    assert.match(tampered.failure!.detail, /does not quote the artifact SHA-256/);
    assert.ok(!edited.calls.some((call) => call.startsWith("PATCH ")), "a disagreeing body is never advertised");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

const REPOSITORY = "mkuznets/sqlc-d1-typescript";
const GITHUB_TOKEN = "ghs_TESTTOKENTESTTOKEN";
const credentials = {
  githubToken: GITHUB_TOKEN,
  accessKeyId: R2.credentials.accessKeyId,
  secretAccessKey: R2.credentials.secretAccessKey,
  accountId: "0123456789abcdef0123456789abcdef",
};

interface WorldSetup {
  objects?: [string, Buffer][];
  releases?: any[];
  immutable?: { enabled: boolean; enforced_by_owner: boolean };
  buckets?: string[] | "denied";
  bucketStatus?: number;
  publicMisses?: number;
  publicBytes?: Buffer;
  publicHeaders?: Record<string, string>;
  publicStatus?: number;
  probeStatus?: number;
  environmentStatus?: number;
  tagCommit?: string;
  conflictOn?: string;
  directBytes?: Buffer;
  tamperedBodyOnRead?: string;
}

/**
 * An in-memory GitHub + R2 + public-origin world. Only primed requests are answered;
 * anything else throws, so an accidental real call is a test failure.
 */
function publicationWorld(setup: WorldSetup = {}) {
  const calls: string[] = [];
  const objects = new Map<
    string,
    { bytes: Buffer; httpMetadata: Record<string, string>; metadata: Record<string, string> }
  >((setup.objects ?? []).map(([key, bytes]) => [key, { bytes, httpMetadata: {}, metadata: {} }]));
  const releases: any[] = setup.releases ? structuredClone(setup.releases) : [];
  const assets = new Map<string, any[]>();
  for (const release of releases) assets.set(String(release.id), release.assets ?? []);
  const immutable = setup.immutable ?? { enabled: true, enforced_by_owner: false };
  let nextId = 5000;
  let publicMisses = setup.publicMisses ?? 0;

  const api = `https://api.github.com/repos/${REPOSITORY}`;
  const uploads = `https://uploads.github.com/repos/${REPOSITORY}`;
  const objectPrefix = `${R2.endpoint}/sqlc/`;
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

  const impl = async (rawUrl: string, init: any = {}) => {
    const method = String(init.method ?? "GET");
    const url = String(rawUrl);
    calls.push(`${method} ${url}`);

    if (url.startsWith(`${api}/immutable-releases`)) return json(immutable);
    if (url.startsWith(`${api}/environments/`))
      return setup.environmentStatus && setup.environmentStatus !== 200
        ? new Response("", { status: setup.environmentStatus })
        : json({ name: "release-publication", deployment_branch_policy: { protected_branches: false } });

    if (url.startsWith("https://sqlc.mkuznets.com/")) {
      const key = decodeURIComponent(url.slice("https://sqlc.mkuznets.com/".length));
      if (setup.probeStatus && key.includes("preflight-probe")) return new Response("", { status: setup.probeStatus });
      if (setup.publicStatus) return new Response("", { status: setup.publicStatus });
      const stored = objects.get(key);
      if (!stored || publicMisses-- > 0) return new Response("", { status: 404 });
      return new Response(new Uint8Array(setup.publicBytes ?? stored.bytes), {
        headers: setup.publicHeaders ?? (stored.httpMetadata as Record<string, string>),
      });
    }

    if (url.startsWith(`${api}/releases/assets/`)) {
      const assetId = url.slice(`${api}/releases/assets/`.length);
      for (const [releaseId, list] of assets) {
        const index = list.findIndex((asset) => String(asset.id) === assetId);
        if (index === -1) continue;
        if (method === "DELETE") {
          list.splice(index, 1);
          assets.set(releaseId, list);
          return new Response(null, { status: 204 });
        }
        return new Response(new Uint8Array(list[index].bytes), { status: 200 });
      }
      return new Response("", { status: 404 });
    }
    if (/\/releases\/\d+\/assets/.test(url) && url.startsWith(uploads)) {
      const releaseId = /releases\/(\d+)\/assets/.exec(url)![1];
      const name = new URL(url).searchParams.get("name")!;
      const list = assets.get(releaseId) ?? [];
      const asset = {
        id: String(nextId++),
        name,
        state: "uploaded",
        size: init.body.length,
        bytes: Buffer.from(init.body),
      };
      list.push(asset);
      assets.set(releaseId, list);
      return json({ id: asset.id, name, state: "uploaded", size: asset.size });
    }
    if (/\/releases\/\d+\/assets/.test(url)) {
      const releaseId = /releases\/(\d+)\/assets/.exec(url)![1];
      return json((assets.get(releaseId) ?? []).map(({ bytes, ...rest }) => rest));
    }
    if (url.startsWith(`${api}/releases?`) || url === `${api}/releases`) {
      if (method !== "POST") return json(releases.map(({ assets: _ignored, ...rest }) => rest));
      const created = {
        ...JSON.parse(init.body),
        id: String(nextId++),
        html_url: `https://github.com/${REPOSITORY}/releases/tag/x`,
      };
      releases.push(created);
      assets.set(String(created.id), []);
      return json(created);
    }
    if (/\/releases\/\d+(?:$|\?)/.test(url)) {
      const releaseId = /releases\/(\d+)/.exec(url)![1];
      const release = releases.find((item) => String(item.id) === releaseId);
      if (!release) return new Response("", { status: 404 });
      if (method === "PATCH") Object.assign(release, JSON.parse(init.body));
      if (method === "DELETE") {
        releases.splice(releases.indexOf(release), 1);
        return new Response(null, { status: 204 });
      }
      const { assets: _ignored, ...rest } = release;
      return json(setup.tamperedBodyOnRead ? { ...rest, body: setup.tamperedBodyOnRead } : rest);
    }
    if (url.startsWith(`${api}/git/ref/tags/`))
      return json({ object: { sha: setup.tagCommit ?? sourceCommit, type: "commit" } });

    throw new Error(`unexpected request ${method} ${url}`);
  };

  // The aws CLI seam. Only the s3api verbs publication uses are answered; anything
  // else is a test failure rather than a silently tolerated command.
  const run = async (args: string[], options: any = {}) => {
    const flag = (name: string) => args[args.indexOf(name) + 1];
    const key = flag("--key");
    calls.push(`aws ${args[1]} ${key ?? flag("--bucket") ?? ""}`.trimEnd());
    const ok = (stdout: unknown = "") => ({
      code: 0,
      stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
      stderr: "",
    });
    const boom = (stderr: string) => ({ code: 254, stdout: "", stderr });
    assert.equal(options.env?.AWS_SECRET_ACCESS_KEY, R2.credentials.secretAccessKey);

    switch (args[1]) {
      case "list-buckets":
        if (setup.buckets === "denied") return boom("An error occurred (AccessDenied)");
        return ok({ Buckets: (setup.buckets ?? ["sqlc"]).map((Name) => ({ Name })) });
      case "head-bucket":
        return (setup.bucketStatus ?? 200) === 200 ? ok() : boom("An error occurred (404): Not Found");
      case "put-object": {
        if (objects.has(key) || setup.conflictOn === key)
          return boom("An error occurred (PreconditionFailed) when calling the PutObject operation");
        objects.set(key, {
          bytes: readFileSync(flag("--body")),
          httpMetadata: {
            "content-type": flag("--content-type"),
            "content-disposition": flag("--content-disposition"),
            "cache-control": flag("--cache-control"),
          },
          metadata: JSON.parse(flag("--metadata")),
        });
        return ok({ ETag: '"stored"' });
      }
      case "head-object":
      case "get-object": {
        const stored = objects.get(key);
        if (!stored) return boom("An error occurred (NoSuchKey)");
        if (args[1] === "get-object") writeFileSync(args[args.length - 1], setup.directBytes ?? stored.bytes);
        return ok({
          ContentLength: (setup.directBytes ?? stored.bytes).length,
          ContentType: stored.httpMetadata["content-type"],
          ContentDisposition: stored.httpMetadata["content-disposition"],
          CacheControl: stored.httpMetadata["cache-control"],
          Metadata: stored.metadata,
        });
      }
      case "delete-object":
        objects.delete(key);
        return ok();
      default:
        throw new Error(`unexpected aws command ${args.join(" ")}`);
    }
  };

  return { impl: impl as unknown as typeof fetch, run, calls, objects, releases, assets };
}

type Fixture = Awaited<ReturnType<typeof publicationFixture>>;
type World = ReturnType<typeof publicationWorld>;

const publishOptions = (fixture: Fixture, world: World, overrides: Record<string, unknown> = {}) => ({
  repository: REPOSITORY,
  intent: fixture.intent,
  candidateDir: fixture.candidateDir,
  manifestPath: fixture.manifestPath,
  artifactId: "9001",
  notes: "- first change",
  credentials,
  fetchImpl: world.impl,
  run: world.run,
  now: fixedClock,
  delay: async () => {},
  logger: () => {},
  statePath: resolve(fixture.root, "publication-state.json"),
  recordPath: resolve(fixture.root, "publication-record.json"),
  mode: "publish" as const,
  ...overrides,
});

test("verification/publication-preflight proves every surface before anything is written", async () => {
  const { preflightPublication } = await publisher();
  const fixture = await publicationFixture();
  try {
    const world = publicationWorld();
    const logs: string[] = [];
    const passed = await preflightPublication({
      repository: REPOSITORY,
      intent: fixture.intent,
      credentials,
      fetchImpl: world.impl,
      run: world.run,
      logger: (line) => logs.push(line),
      now: fixedClock,
      output: resolve(fixture.root, "publication-preflight.json"),
    });
    assert.equal(passed.status, "passed");
    assert.deepEqual(
      passed.checks.map(({ name }) => name),
      [
        "immutable-releases",
        "environment-ref-policy",
        "r2-credential-scope",
        "r2-bucket",
        "public-origin",
        "version-key",
      ],
    );
    assert.ok(
      !world.calls.some((call) => call.startsWith("PUT") || call.startsWith("POST") || call.startsWith("PATCH")),
    );
    assert.match(
      JSON.parse(await readFile(resolve(fixture.root, "publication-preflight.json"), "utf8")).status,
      /passed/,
    );

    const failsWith = async (setup: WorldSetup, pattern: RegExp) => {
      const failing = publicationWorld(setup);
      const captured: string[] = [];
      await assert.rejects(
        preflightPublication({
          repository: REPOSITORY,
          intent: fixture.intent,
          credentials,
          fetchImpl: failing.impl,
          run: failing.run,
          logger: (line) => captured.push(line),
          now: fixedClock,
        }),
        /publication preflight failed/,
      );
      assert.match(captured.join("\n"), pattern);
    };

    await failsWith({ immutable: { enabled: false, enforced_by_owner: false } }, /gh api -X PUT repos\//);
    await failsWith({ bucketStatus: 404 }, /bucket answered HTTP 404; confirm the bucket name and the token scope/);
    await failsWith({ buckets: ["sqlc", "someone-elses-bucket"] }, /reissue it with Object Read & Write on sqlc only/);
    await failsWith({ probeStatus: 503 }, /public origin answered HTTP 503/);
    await failsWith({ probeStatus: 200 }, /custom domain may map to another bucket/);

    // A token that cannot read the environments API is not a negative answer.
    const unverifiable = publicationWorld({ environmentStatus: 403 });
    const result = await preflightPublication({
      repository: REPOSITORY,
      intent: fixture.intent,
      credentials,
      fetchImpl: unverifiable.impl,
      run: unverifiable.run,
      logger: () => {},
      now: fixedClock,
    });
    assert.equal(result.checks.find(({ name }) => name === "environment-ref-policy")?.status, "not-verifiable");

    const open = publicationWorld();
    const openWorld = {
      ...open,
      impl: (async (url: string, init: any) =>
        String(url).includes("/environments/")
          ? new Response(JSON.stringify({ deployment_branch_policy: null }), { status: 200 })
          : (open.impl as any)(url, init)) as unknown as typeof fetch,
    };
    const openLogs: string[] = [];
    await assert.rejects(
      preflightPublication({
        repository: REPOSITORY,
        intent: fixture.intent,
        credentials,
        fetchImpl: openWorld.impl,
        run: open.run,
        logger: (line) => openLogs.push(line),
        now: fixedClock,
      }),
      /publication preflight failed/,
    );
    assert.match(openLogs.join("\n"), /restrict it to branch main and tag v\*/);

    for (const missing of ["githubToken", "accessKeyId", "secretAccessKey", "accountId"])
      await assert.rejects(
        preflightPublication({
          repository: REPOSITORY,
          intent: fixture.intent,
          credentials: { ...credentials, [missing]: "" },
          fetchImpl: publicationWorld().impl,
          run: publicationWorld().run,
          logger: () => {},
        }),
        /is empty; add the missing secret or variable to the release-publication environment/,
      );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

/** Every call in the log that changed something, in the order it happened. */
const mutating = (calls: string[]) =>
  calls
    .filter((call) => /^(?:POST|PATCH|DELETE) |^aws (?:put|delete)-object /.test(call))
    .map((call) =>
      call.startsWith("aws ")
        ? call
        : `${call.split(" ")[0]} ${call
            .split(" ")[1]
            .replace(/^https:\/\/[^/]+/, "")
            .replace(/\?.*$/, "")}`,
    );

test("verification/publication-order writes the version key before it advertises, and advertises last", async () => {
  const { publishPublication } = await publisher();
  const fixture = await publicationFixture();
  try {
    const world = publicationWorld();
    const record = await publishPublication(publishOptions(fixture, world));

    assert.equal(record.failure, undefined);
    assert.equal(record.verified_sha256, fixture.candidate.sha256);
    assert.equal(record.r2.outcome, "created");
    assert.equal(record.r2.key, `plugins/${fixture.candidate.filename}`);
    assert.equal(record.r2.direct_download_sha256, fixture.candidate.sha256);
    assert.equal(record.r2.public_download_sha256, fixture.candidate.sha256);
    assert.equal(record.r2.metadata_sha256, fixture.candidate.sha256);
    assert.equal(record.github.published, true);
    assert.equal(record.github.draft_outcome, "created");
    assert.equal(record.github.asset_sha256.wasm, fixture.candidate.sha256);
    assert.equal(record.github.asset_sha256.manifest, fixture.manifestSha256);
    assert.equal(record.github.prerelease, false);
    assert.deepEqual(
      record.order.map(({ phase }) => phase),
      [
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
      ],
    );

    const writes = mutating(world.calls);
    assert.deepEqual(writes, [
      `POST /repos/${REPOSITORY}/releases`,
      `POST /repos/${REPOSITORY}/releases/5000/assets`,
      `POST /repos/${REPOSITORY}/releases/5000/assets`,
      `aws put-object plugins/${fixture.candidate.filename}`,
      `PATCH /repos/${REPOSITORY}/releases/5000`,
    ]);
    const put = world.calls.findIndex((call) => call.startsWith("aws put-object "));
    const patch = world.calls.findIndex((call) => call.startsWith("PATCH "));
    const publicGet = world.calls.findIndex(
      (call) => call === `GET https://sqlc.mkuznets.com/plugins/${fixture.candidate.filename}`,
    );
    assert.ok(put < publicGet && publicGet < patch, "the public download must sit between the write and the publish");
    assert.equal(
      world.calls.filter((call) => call.startsWith("aws put-object ")).length,
      1,
      "the create-only write happens once",
    );

    const stored = world.objects.get(`plugins/${fixture.candidate.filename}`)!;
    assert.equal(stored.httpMetadata["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(stored.httpMetadata["content-type"], "application/wasm");
    assert.equal(stored.metadata["source-commit"], sourceCommit);
    assert.equal(stored.metadata.sha256, fixture.candidate.sha256);
    assert.equal(world.releases[0].draft, false);
    assert.equal(world.releases[0].make_latest, "true");

    const { validatePublicationRecord } = await publication();
    await validatePublicationRecord({ path: resolve(fixture.root, "publication-record.json") });

    // A prerelease version must never be promoted to "latest".
    const prereleaseFixture = await publicationFixture({ version: "0.2.0-rc.1", tag: "v0.2.0-rc.1" });
    try {
      const prereleaseWorld = publicationWorld();
      const prereleaseRecord = await publishPublication(publishOptions(prereleaseFixture, prereleaseWorld));
      assert.equal(prereleaseRecord.github.prerelease, true);
      assert.equal(prereleaseWorld.releases[0].make_latest, "false");
    } finally {
      await rm(prereleaseFixture.root, { recursive: true, force: true });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification/publication-retry converges on the retained candidate without rewriting anything", async () => {
  const { publishPublication } = await publisher();
  const fixture = await publicationFixture();
  try {
    const first = publicationWorld();
    await publishPublication(publishOptions(fixture, first));

    // Rerunning against the surfaces the first run left behind must converge: the
    // draft is reused, no asset is re-uploaded, and the existing key is confirmed.
    const second = publicationWorld({
      objects: [...first.objects].map(([key, value]) => [key, value.bytes] as [string, Buffer]),
      releases: [
        {
          id: "7001",
          tag_name: "v0.2.0",
          draft: true,
          prerelease: false,
          html_url: `https://github.com/${REPOSITORY}/releases/tag/v0.2.0`,
          body: first.releases[0].body,
          assets: [
            {
              id: "8001",
              name: fixture.candidate.filename,
              state: "uploaded",
              size: fixture.candidate.size,
              bytes: fixture.candidateBytes,
            },
            {
              id: "8002",
              name: `sqlc-gen-d1-typescript_0.2.0.manifest.json`,
              state: "uploaded",
              size: fixture.manifestBytes.length,
              bytes: fixture.manifestBytes,
            },
          ],
        },
      ],
    });
    // The rehearsal above stored bare headers; restore the metadata the first run wrote.
    for (const [key, value] of first.objects) second.objects.set(key, value);

    const record = await publishPublication(publishOptions(fixture, second));
    assert.equal(record.failure, undefined);
    assert.equal(record.github.draft_outcome, "reused");
    assert.equal(record.r2.outcome, "existing-identical");
    assert.equal(record.github.published, true);
    assert.deepEqual(mutating(second.calls), [
      `aws put-object plugins/${fixture.candidate.filename}`,
      `PATCH /repos/${REPOSITORY}/releases/7001`,
    ]);
    assert.ok(
      !second.calls.some((call) => call.includes("uploads.github.com")),
      "identical assets are never re-uploaded",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification/publication-conflict halts on any surface that disagrees with the retained candidate", async () => {
  const { publishPublication } = await publisher();
  const fixture = await publicationFixture();
  try {
    // An existing version key holding different bytes: halt, publish nothing, delete nothing.
    const foreign = publicationWorld({
      objects: [[`plugins/${fixture.candidate.filename}`, Buffer.from("other bytes")]],
    });
    const conflictLogs: string[] = [];
    const conflict = await publishPublication(
      publishOptions(fixture, foreign, { logger: (line: string) => conflictLogs.push(line) }),
    );
    assert.equal(conflict.failure?.phase, "version-key");
    assert.match(conflict.failure!.detail, /this version key is immutable and publication is halted without writing/);
    // The key is occupied by foreign bytes, so recreating the tag can never succeed:
    // the operator must be told the version is consumed, not that it is still free.
    assert.match(conflictLogs.join("\n"), /exists and is permanent/);
    assert.ok(!conflictLogs.join("\n").includes("the version is still free"));
    assert.equal(conflict.github.published, false);
    assert.equal(conflict.r2.outcome, "not-created");
    assert.ok(!foreign.calls.some((call) => call.startsWith("PATCH ") || call.startsWith("DELETE ")));
    assert.equal(foreign.objects.get(`plugins/${fixture.candidate.filename}`)!.bytes.toString(), "other bytes");

    // A draft asset that differs halts before R2 is touched at all.
    const staleAsset = publicationWorld({
      releases: [
        {
          id: "7002",
          tag_name: "v0.2.0",
          draft: true,
          prerelease: false,
          html_url: "https://github.com/x/y/releases/tag/v0.2.0",
          body: null,
          assets: [
            { id: "8003", name: fixture.candidate.filename, state: "uploaded", size: 3, bytes: Buffer.from("old") },
          ],
        },
      ],
    });
    const differingBody = await publishPublication(publishOptions(fixture, staleAsset));
    assert.equal(differingBody.failure?.phase, "draft-release");
    assert.match(differingBody.failure!.detail, /carries a different body than this run would publish/);
    assert.ok(
      !staleAsset.calls.some((call) => call.startsWith("PUT ")),
      "no R2 write may happen after a draft conflict",
    );

    const body = await (async () => {
      const { buildReleaseBody } = await publication();
      return buildReleaseBody({
        manifest: fixture.manifest,
        intent: fixture.intent,
        notes: "- first change",
        manifestSha256: fixture.manifestSha256,
      });
    })();
    const staleBytes = publicationWorld({
      releases: [
        {
          id: "7003",
          tag_name: "v0.2.0",
          draft: true,
          prerelease: false,
          html_url: "https://github.com/x/y/releases/tag/v0.2.0",
          body,
          assets: [
            { id: "8004", name: fixture.candidate.filename, state: "uploaded", size: 3, bytes: Buffer.from("old") },
          ],
        },
      ],
    });
    const mismatched = await publishPublication(publishOptions(fixture, staleBytes));
    assert.equal(mismatched.failure?.phase, "draft-assets");
    assert.match(mismatched.failure!.detail, /differs from the retained candidate; publication is halted/);
    assert.ok(!staleBytes.calls.some((call) => call.startsWith("aws put-object ")));
    assert.equal(mismatched.r2.outcome, "not-created");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification/publication-recovery names the side of the permanent boundary a failure landed on", async () => {
  const { recoveryGuidance, publishPublication } = await publisher();
  const digest = "a".repeat(64);
  const key = "plugins/sqlc-gen-d1-typescript_0.2.0.wasm";

  assert.match(
    recoveryGuidance({ version: "0.2.0", tag: "v0.2.0", key, digest, keyExists: false, published: false }),
    /no R2 version key exists for 0\.2\.0; the version is still free\. Delete tag v0\.2\.0/,
  );
  assert.match(
    recoveryGuidance({ version: "0.2.0", tag: "v0.2.0", key, digest, keyExists: true, published: false }),
    new RegExp(`R2 key ${key} exists and is permanent.*bound to SHA-256 ${digest}.*Do not delete or overwrite`, "s"),
  );
  assert.match(
    recoveryGuidance({ version: "0.2.0", tag: "v0.2.0", key, digest, keyExists: true, published: true }),
    /published and immutable; do not delete the tag, assets, or R2 object/,
  );
  assert.match(
    recoveryGuidance({
      mode: "dry-run",
      version: "0.2.0",
      key: "rehearsal/1/x.wasm",
      digest,
      keyExists: true,
      published: false,
    }),
    /no version was consumed/,
  );

  const fixture = await publicationFixture();
  try {
    // Pre-key: the public origin is fine but the draft never forms.
    const preKey = publicationWorld({
      releases: [{ id: "7004", tag_name: "v0.2.0", draft: false, body: "", html_url: "https://github.com/x/y" }],
    });
    const preLogs: string[] = [];
    const early = await publishPublication(
      publishOptions(fixture, preKey, { logger: (line: string) => preLogs.push(line) }),
    );
    assert.equal(early.failure?.phase, "draft-release");
    assert.match(preLogs.join("\n"), /the version is still free/);
    assert.ok(!preLogs.join("\n").includes("exists and is permanent"));

    // Post-key: the write succeeded and the public URL never served the object.
    const postKey = publicationWorld({ publicMisses: 100 });
    const postLogs: string[] = [];
    const late = await publishPublication(
      publishOptions(fixture, postKey, { logger: (line: string) => postLogs.push(line), publicAttempts: 3 }),
    );
    assert.equal(late.failure?.phase, "public-verification");
    assert.equal(late.r2.outcome, "created");
    assert.equal(late.r2.public_attempts, 3);
    assert.equal(late.github.published, false);
    assert.match(
      postLogs.join("\n"),
      new RegExp(`R2 key plugins/${fixture.candidate.filename} exists and is permanent`),
    );
    assert.match(postLogs.join("\n"), /::error::publication failed during public-verification/);
    assert.ok(!postKey.calls.some((call) => call.startsWith("PATCH ")), "an unverified artifact is never advertised");

    // Post-publication: the release is out. Whatever failed afterwards, nothing may
    // be taken back, so the record and the guidance must both say it is published.
    const afterPublish = publicationWorld({ tagCommit: "d".repeat(40) });
    const afterLogs: string[] = [];
    const advertised = await publishPublication(
      publishOptions(fixture, afterPublish, { logger: (line: string) => afterLogs.push(line) }),
    );
    assert.equal(advertised.failure?.phase, "publish");
    assert.match(advertised.failure!.detail, /resolves to dddd/);
    assert.equal(advertised.github.published, true);
    assert.match(afterLogs.join("\n"), /published and immutable; do not delete the tag, assets, or R2 object/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification/publication-dry-run rehearses everything and consumes nothing", async () => {
  const { publishPublication, teardownPublication } = await publisher();
  const fixture = await publicationFixture({ tag: null, dryRun: true });
  try {
    const world = publicationWorld();
    const statePath = resolve(fixture.root, "publication-state.json");
    const record = await publishPublication(publishOptions(fixture, world, { mode: "dry-run", statePath }));

    assert.equal(record.failure, undefined);
    assert.equal(record.mode, "dry-run");
    assert.equal(record.r2.key, `rehearsal/${runId}/${fixture.candidate.filename}`);
    assert.equal(record.github.tag_name, `dry-run-v0.2.0-${runId}`);
    assert.equal(record.github.published, false);
    assert.deepEqual(record.teardown, { object: "deleted", draft: "deleted" });
    assert.ok(!world.calls.some((call) => call.startsWith("PATCH ")), "a dry run never publishes");
    assert.ok(
      !world.calls.some((call) => /^aws (?:put|delete)-object plugins\//.test(call)),
      "a dry run never writes to a version key",
    );
    assert.equal(world.objects.size, 0, "the rehearsal object is deleted");
    assert.equal(world.releases.length, 0, "the rehearsal draft is deleted");

    // A publication run's state file must never be actionable by teardown.
    const publishState = resolve(fixture.root, "publish-state.json");
    await writeFile(
      publishState,
      JSON.stringify({
        schemaVersion: 1,
        mode: "publish",
        repository: REPOSITORY,
        draft: { status: "created", id: "1" },
        object: { status: "created", bucket: "sqlc", key: `plugins/${fixture.candidate.filename}` },
      }),
    );
    const refusing = publicationWorld();
    await assert.rejects(
      teardownPublication({
        statePath: publishState,
        credentials,
        fetchImpl: refusing.impl,
        run: refusing.run,
        logger: () => {},
      }),
      /teardown refuses to act on a publish publication/,
    );
    assert.deepEqual(refusing.calls, [], "a refused teardown makes no request at all");

    // The standalone teardown is the safety net when the process is killed mid-run.
    const orphan = publicationWorld({
      objects: [[`rehearsal/${runId}/${fixture.candidate.filename}`, fixture.candidateBytes]],
      releases: [
        { id: "7005", tag_name: `dry-run-v0.2.0-${runId}`, draft: true, body: "", html_url: "https://github.com/x/y" },
      ],
    });
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        mode: "dry-run",
        repository: REPOSITORY,
        draft: { status: "created", id: "7005" },
        object: { status: "created", bucket: "sqlc", key: `rehearsal/${runId}/${fixture.candidate.filename}` },
      }),
    );
    const report = await teardownPublication({
      statePath,
      credentials,
      fetchImpl: orphan.impl,
      run: orphan.run,
      logger: () => {},
      reportPath: resolve(fixture.root, "publication-teardown.json"),
    });
    assert.deepEqual(report.teardown, { object: "deleted", draft: "deleted" });
    assert.equal(orphan.objects.size, 0);
    assert.equal(orphan.releases.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
