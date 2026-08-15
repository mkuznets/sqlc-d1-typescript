import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SQLC_COMPATIBILITY_POLICY } from "../src/validation";

const compatibility = () => import("../scripts/compatibility-config.ts");
const upstream = () => import("../scripts/check-upstream-compatibility.ts");
const sqlcMatrix = () => import("../scripts/verify-sqlc-compatibility.ts");
const evidenceWriter = () => import("../scripts/write-compatibility-evidence.ts");

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "compatibility-test-"));
  for (const path of [
    "verification",
    "package-lock.json",
    "test/miniflare/bun.lock",
    "examples/d1-worker/bun.lock",
    "test/miniflare/wrangler.jsonc",
    "examples/d1-worker/wrangler.jsonc",
    "scripts/install-buf.sh",
    "scripts/install-javy.sh",
  ]) {
    await cp(resolve(process.cwd(), path), resolve(root, path), { recursive: true });
  }
  return root;
}

test("verification/compatibility-config validates the reviewed local baseline", async () => {
  const { assertSqlcPolicy, loadCompatibilityConfig, renderCompatibilityFacts } = await compatibility();
  const config = await loadCompatibilityConfig({ checkLocal: true });
  assertSqlcPolicy(config, SQLC_COMPATIBILITY_POLICY);
  assert.match(renderCompatibilityFacts(config), /sqlc.samples=v1\.18\.0, v1\.20\.0, v1\.24\.0, v1\.31\.1/);
  assert.equal(Object.isFrozen(config.sqlc.samples), true);
  assert.match(config.sqlc.knownExceptions[0], /v1\.18\.0 cannot parse.*sqlc\.arg.*sqlc\.embed/);
  assert.match(
    config.sqlc.knownExceptions[1],
    /v1\.20\.0 and v1\.24\.0 parse.*Ubuntu x64 CI cells run both current fixture corpora/,
  );
});

test("verification/compatibility-mutations rejects semantic and duplicated-input drift", async () => {
  const { checkLocalCompatibility, loadCompatibilityConfig } = await compatibility();
  const root = await temporaryRoot();
  try {
    const configPath = resolve(root, "verification/compatibility.json");
    const checked = JSON.parse(await readFile(configPath, "utf8"));
    checked.sqlc.samples[1].version = "v1.17.0";
    await writeFile(configPath, JSON.stringify(checked));
    await assert.rejects(loadCompatibilityConfig({ root }), /samples\[1\].version.*strictly ordered/);

    checked.sqlc.samples[1].version = "v1.20.0";
    checked.cloudflare.compatibilityDate = "2026-99-99";
    await writeFile(configPath, JSON.stringify(checked));
    await assert.rejects(loadCompatibilityConfig({ root }), /cloudflare\.compatibilityDate.*valid calendar date/);

    await cp(resolve(process.cwd(), "verification/compatibility.json"), configPath);
    const wranglerPath = resolve(root, "test/miniflare/wrangler.jsonc");
    await writeFile(wranglerPath, (await readFile(wranglerPath, "utf8")).replace("2026-02-05", "2026-02-06"));
    const config = await loadCompatibilityConfig({ root });
    await assert.rejects(
      checkLocalCompatibility(config, root),
      /cloudflare\.compatibilityDate.*test\/miniflare\/wrangler\.jsonc/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification/upstream-comparison is deterministic and treats releases as review signals", async () => {
  const { loadCompatibilityConfig } = await compatibility();
  const { compareUpstreamCompatibility, fetchUpstreamFacts, renderUpstreamTable } = await upstream();
  const config = await loadCompatibilityConfig();
  const equal = {
    sqlc: "v1.31.1",
    workersTypes: "4.20260214.0",
    wrangler: "4.63.0",
    vitestPoolWorkers: "0.12.21",
    miniflare: "4.20260310.0",
    workerd: "1.20260310.1",
  };
  assert.equal(
    compareUpstreamCompatibility(config, equal).some(({ drift }) => drift),
    false,
  );

  const rows = compareUpstreamCompatibility(config, { ...equal, sqlc: "v1.32.0" });
  assert.equal(rows[0].drift, true);
  assert.match(renderUpstreamTable(rows), /review signal, not proof/);

  assert.throws(
    () => compareUpstreamCompatibility(config, { ...equal, sqlc: "v1.32.0-rc1" }),
    /malformed stable version/,
  );

  let calls = 0;
  const fakeFetch = async (url: string): Promise<Response> => {
    calls++;
    if (url.includes("github")) return new Response(JSON.stringify({ tag_name: equal.sqlc }), { status: 200 });
    const name = url.includes("workers-types")
      ? "workersTypes"
      : url.includes("vitest-pool")
        ? "vitestPoolWorkers"
        : url.split("/").slice(-1)[0];
    const key =
      name === "workersTypes"
        ? "workersTypes"
        : name === "vitestPoolWorkers"
          ? "vitestPoolWorkers"
          : (name as keyof typeof equal);
    return new Response(JSON.stringify({ "dist-tags": { latest: equal[key] }, versions: { "99.0.0": {} } }), {
      status: 200,
    });
  };
  assert.deepEqual(await fetchUpstreamFacts(fakeFetch as typeof fetch), equal);
  assert.equal(calls, 6);

  await assert.rejects(
    fetchUpstreamFacts(async () => new Response(JSON.stringify({ "dist-tags": {} }), { status: 200 }) as never),
    /missing or malformed stable/,
  );
  await assert.rejects(
    fetchUpstreamFacts(async () => new Response("not json", { status: 200 }) as never),
    /malformed JSON/,
  );
  await assert.rejects(
    fetchUpstreamFacts(
      async () => new Response(JSON.stringify({ "dist-tags": { latest: "2.0.0-rc.1" } }), { status: 200 }) as never,
    ),
    /missing or malformed stable/,
  );
  await assert.rejects(
    fetchUpstreamFacts(async () => {
      throw new Error("timeout");
    }),
    /timeout/,
  );
});

test("verification/sqlc-matrix reports the honest corpus selected for every sample", async () => {
  const { fixturesForSqlcVersion } = await sqlcMatrix();
  assert.deepEqual(
    fixturesForSqlcVersion("v1.18.0").map(({ directory }) => directory),
    ["test/sqlc-v1-18"],
  );
  for (const version of ["v1.20.0", "v1.24.0", "v1.31.1"])
    assert.deepEqual(
      fixturesForSqlcVersion(version).map(({ directory }) => directory),
      ["test/miniflare", "examples/d1-worker"],
    );
});

test("matrix evidence records the executable version returned by the runner", async () => {
  const { writeCompatibilityEvidence } = await evidenceWriter();
  const directory = await mkdtemp(resolve(tmpdir(), "matrix-evidence-"));
  try {
    const output = resolve(directory, "evidence.json");
    const evidence = (await writeCompatibilityEvidence({
      output,
      matrixResult: {
        sqlcVersion: "v1.24.0",
        fixtures: ["test/miniflare"],
        knownExceptions: [],
        typescriptVersion: "5.9.3",
        candidateSha256: "a".repeat(64),
        cleanup: "confirmed",
      },
      actualTools: { node: "24.12.0", npm: "11.6.2", bun: "1.3.10" },
    })) as { tools: { sqlc: string[] } };
    assert.deepEqual(evidence.tools.sqlc, ["v1.24.0"]);

    await assert.rejects(
      writeCompatibilityEvidence({
        output,
        matrixResult: { sqlcVersion: "requested", candidateSha256: "a".repeat(64) } as never,
      }),
      /actual sqlcVersion/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verification/ci-security-contract preserves one uncredentialed publication candidate", async () => {
  const { loadCompatibilityConfig } = await compatibility();
  const config = await loadCompatibilityConfig();
  const workflow = await readFile(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

  // CI never holds a credential and never provisions anything. Everything it runs
  // works against the single candidate the baseline job built.
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(
    workflow,
    /pull_request_target|secrets\.|environment:|wrangler deploy|d1 execute|r2|npm publish/i,
  );
  assert.equal((workflow.match(/make build/g) ?? []).length, 1);

  // Every verification job takes the candidate from the baseline build and proves its
  // digest before using it, so no job can silently test a different wasm.
  for (const job of [
    "exact-candidate",
    "public-types",
    "miniflare",
    "canonical-example",
    "generated-drift",
    "sqlc-compatibility",
  ]) {
    const start = workflow.indexOf(`  ${job}:`);
    assert.notEqual(start, -1, job);
    const nextMatch = /^  [a-z][a-z-]+:/gm;
    nextMatch.lastIndex = start + `  ${job}:`.length;
    const next = nextMatch.exec(workflow)?.index ?? -1;
    const section = workflow.slice(start, next < 0 ? undefined : next);
    assert.match(section, /baseline-and-build/, job);
    assert.match(section, /download-artifact/, job);
    assert.match(
      section,
      /verify-candidate-digest\.sh candidate\/build\/plugin\.wasm candidate\/candidate\.sha256/,
      job,
    );
  }

  // The sqlc matrix comes from the compatibility contract, never from a version
  // hardcoded in the workflow.
  assert.match(workflow, /sqlc:\s*\$\{\{ fromJSON\(needs\.config\.outputs\.sqlc-matrix\) \}\}/);
  for (const version of config.sqlc.samples.map(({ version }) => version))
    assert.doesNotMatch(workflow, new RegExp(`sqlc: \\[.*${version.replace(/\./g, "\\.")}`));
});
