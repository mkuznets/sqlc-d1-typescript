import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const compatibility = () => import("../scripts/compatibility-config.ts");
const sqlcMatrix = () => import("../scripts/verify-sqlc-compatibility.ts");

// Writes a mutated copy of the checked-in config into a throwaway root and returns it.
async function rootWithConfig(mutate: (config: any) => void): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "compatibility-test-"));
  await mkdir(resolve(root, "verification"), { recursive: true });
  const config = JSON.parse(await readFile(resolve(process.cwd(), "verification/compatibility.json"), "utf8"));
  mutate(config);
  await writeFile(resolve(root, "verification/compatibility.json"), JSON.stringify(config));
  return root;
}

async function rejectsWith(mutate: (config: any) => void, pattern: RegExp): Promise<void> {
  const { loadCompatibilityConfig } = await compatibility();
  const root = await rootWithConfig(mutate);
  try {
    await assert.rejects(loadCompatibilityConfig({ root }), pattern);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("verification/compatibility-config accepts the checked-in configuration", async () => {
  const { loadCompatibilityConfig } = await compatibility();
  const config = await loadCompatibilityConfig();
  assert.equal(config.sqlc.supportedFloor, "v1.18.0");
  assert.equal(config.sqlc.testedCeiling, "v1.31.1");
  assert.deepEqual(
    config.sqlc.samples.map(({ version }) => version),
    ["v1.18.0", "v1.20.0", "v1.24.0", "v1.31.1"],
  );
  assert.match(config.sqlc.knownExceptions[0], /v1\.18\.0 cannot parse.*sqlc\.arg.*sqlc\.embed/);
  assert.match(
    config.sqlc.knownExceptions[1],
    /v1\.20\.0 and v1\.24\.0 parse.*Ubuntu x64 CI cells run both current fixture corpora/,
  );
});

test("verification/compatibility-mutations rejects unordered samples", async () => {
  await rejectsWith((config) => {
    config.sqlc.samples[1].version = "v1.17.0";
  }, /samples\[1\]\.version.*strictly ordered/);
});

test("verification/compatibility-mutations rejects duplicate sample versions", async () => {
  await rejectsWith((config) => {
    config.sqlc.samples[1].version = config.sqlc.samples[0].version;
  }, /sqlc\.samples.*versions must be unique/);
});

test("verification/compatibility-mutations rejects a floor that disagrees with the first sample", async () => {
  await rejectsWith((config) => {
    config.sqlc.supportedFloor = "v1.19.0";
  }, /sqlc\.supportedFloor.*must equal first sample v1\.18\.0/);
});

test("verification/compatibility-mutations rejects a ceiling that disagrees with the last sample", async () => {
  await rejectsWith((config) => {
    config.sqlc.testedCeiling = "v1.32.0";
  }, /sqlc\.testedCeiling.*must equal last sample v1\.31\.1/);
});

test("verification/compatibility-mutations rejects samples that do not start at the floor", async () => {
  await rejectsWith((config) => {
    config.sqlc.samples[0].role = "intervening";
  }, /sqlc\.samples.*exactly one floor role/);
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
