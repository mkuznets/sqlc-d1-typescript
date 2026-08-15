import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalManifestFilename,
  canonicalWasmFilename,
  createReleaseManifest,
  parseSemver,
  resolveReleaseIntent,
  stableJson,
  type ReleaseIntent,
} from "../scripts/release.ts";
import { loadCompatibilityConfig } from "../scripts/compatibility-config.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";
const intent: ReleaseIntent = {
  version: "0.2.0",
  tag: "v0.2.0",
  sourceCommit: sha,
  workflowUrl: "https://github.com/o/r/actions/runs/123",
};

test("release/semver accepts and rejects exactly the SemVer this project publishes", () => {
  for (const value of ["0.2.0", "1.0.0", "0.2.0-rc.1", "1.2.3-alpha.0"]) {
    assert.equal(parseSemver(value), value);
    assert.equal(parseSemver(`v${value}`, { prefixed: true }), value);
  }
  // Leading zeros, build metadata, and a bare `v` are all rejected: each would make
  // two different tags name the same published artifact.
  for (const value of ["0.2", "01.2.3", "1.2.03", "1.2.3-", "1.2.3-alpha..1", "1.2.3+build", "v1.2.3"])
    assert.throws(() => parseSemver(value), /expected/, `accepted ${value}`);
});

test("release/canonical filenames have no aliases", () => {
  assert.equal(canonicalWasmFilename("0.2.0"), "sqlc-gen-d1-typescript_0.2.0.wasm");
  assert.equal(canonicalManifestFilename("0.2.0"), "sqlc-gen-d1-typescript_0.2.0.manifest.json");
  assert.throws(() => canonicalWasmFilename("v0.2.0"), /expected/);
});

test("release/intent accepts a tag push only after proving default-branch ancestry", async () => {
  const calls: string[] = [];
  const resolved = await resolveReleaseIntent({
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

  assert.equal(resolved.version, "0.2.0-rc.1");
  assert.equal(resolved.tag, "v0.2.0-rc.1");
  assert.equal(resolved.workflowUrl, "https://github.com/o/r/actions/runs/456");
  assert.deepEqual(calls, [`${sha}:main`]);
});

test("release/intent refuses anything that is not a tag on default-branch lineage", async () => {
  const base = {
    eventName: "push",
    refType: "tag",
    refName: "v0.2.0",
    sourceCommit: sha,
    defaultBranch: "main",
    workflowRunId: "456",
    repository: "o/r",
    isAncestor: async () => true,
  };
  await assert.rejects(resolveReleaseIntent({ ...base, isAncestor: async () => false }), /not reachable/);
  await assert.rejects(resolveReleaseIntent({ ...base, eventName: "workflow_dispatch" }), /unsupported release event/);
  await assert.rejects(resolveReleaseIntent({ ...base, refType: "branch" }), /must use a tag ref/);
  await assert.rejects(resolveReleaseIntent({ ...base, refName: "0.2.0" }), /expected/);
  await assert.rejects(resolveReleaseIntent({ ...base, sourceCommit: "abc" }), /40-character/);
});

test("release/manifest describes the exact bytes and is byte-stable", async () => {
  const config = await loadCompatibilityConfig();
  const bytes = new TextEncoder().encode("plugin bytes");
  const manifest = createReleaseManifest({ intent, bytes, config });

  assert.equal(manifest.artifact.filename, "sqlc-gen-d1-typescript_0.2.0.wasm");
  assert.equal(manifest.artifact.size, bytes.length);
  assert.match(manifest.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.artifact.url, `https://sqlc.mkuznets.com/plugins/${manifest.artifact.filename}`);
  assert.equal(manifest.source_commit, sha);
  assert.equal(manifest.version, "0.2.0");
  assert.deepEqual(
    manifest.tested_versions.sqlc,
    config.sqlc.samples.map(({ version }) => version),
  );
  assert.deepEqual(manifest.tested_versions.typescript, [config.typescript.floor, config.typescript.current]);

  // The manifest is published, so its encoding must not depend on key insertion order.
  assert.equal(stableJson(createReleaseManifest({ intent, bytes, config })), stableJson(manifest));
  assert.equal(stableJson(manifest), stableJson(JSON.parse(stableJson(manifest))));
  assert.ok(stableJson(manifest).endsWith("}\n"));
});

test("release/manifest refuses a tag that does not name its version", async () => {
  const config = await loadCompatibilityConfig();
  assert.throws(
    () => createReleaseManifest({ intent: { ...intent, tag: "v0.3.0" }, bytes: new Uint8Array(1), config }),
    /does not name version/,
  );
});
