import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalManifestFilename,
  canonicalWasmFilename,
  createReleaseManifest,
  parseSemver,
  renderReleaseNotes,
  resolveReleaseIntent,
  stableJson,
  type ReleaseIntent,
} from "../scripts/release.ts";
import { MINIMUM_SQLC_VERSION, TESTED_SQLC_VERSION } from "../src/compatibility.ts";

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

test("release/intent tells a prerelease version from a stable one so the shell never parses it", async () => {
  const base = {
    eventName: "push",
    refType: "tag",
    sourceCommit: sha,
    defaultBranch: "main",
    workflowRunId: "456",
    repository: "o/r",
    isAncestor: async () => true,
  };
  assert.equal((await resolveReleaseIntent({ ...base, refName: "v0.2.0-rc.1" })).isPrerelease, true);
  assert.equal((await resolveReleaseIntent({ ...base, refName: "v0.2.0" })).isPrerelease, false);
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

test("release/manifest describes the exact bytes and is byte-stable", () => {
  const bytes = new TextEncoder().encode("plugin bytes");
  const manifest = createReleaseManifest({ intent, bytes });

  assert.equal(manifest.artifact.filename, "sqlc-gen-d1-typescript_0.2.0.wasm");
  assert.equal(manifest.artifact.size, bytes.length);
  assert.match(manifest.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.artifact.url, `https://sqlc.mkuznets.com/plugins/${manifest.artifact.filename}`);
  assert.equal(manifest.source_commit, sha);
  assert.equal(manifest.version, "0.2.0");
  assert.deepEqual(manifest.tested_versions.sqlc, {
    floor: MINIMUM_SQLC_VERSION,
    ceiling: TESTED_SQLC_VERSION,
  });

  // The manifest is published, so its encoding must not depend on key insertion order.
  assert.equal(stableJson(createReleaseManifest({ intent, bytes })), stableJson(manifest));
  assert.equal(stableJson(manifest), stableJson(JSON.parse(stableJson(manifest))));
  assert.ok(stableJson(manifest).endsWith("}\n"));
});

test("release/manifest refuses a tag that does not name its version", () => {
  assert.throws(
    () => createReleaseManifest({ intent: { ...intent, tag: "v0.3.0" }, bytes: new Uint8Array(1) }),
    /does not name version/,
  );
});

const manifest = createReleaseManifest({ intent, bytes: new TextEncoder().encode("plugin bytes") });

test("release/notes advertise the manifest's own URL and digest, and nothing else", () => {
  const body = renderReleaseNotes({
    manifest,
    previousTag: "v0.1.0",
    commits: ["- Second (abcdef1)", "- First (1234567)"],
    repository: "o/r",
  });

  // The configuration block is the copy-paste path for a consumer, so the two facts a
  // consumer pins must come from the manifest that describes the published bytes.
  assert.match(body, /```yaml\nversion: "2"\nplugins:\n {2}- name: d1-ts\n {4}wasm:\n/);
  assert.match(body, new RegExp(`      url: ${manifest.artifact.url}\n      sha256: ${manifest.artifact.sha256}\n`));
  assert.equal(body.includes("## Changes\n\n- Second (abcdef1)\n- First (1234567)"), true);
  assert.equal(body.endsWith("**Full changelog**: https://github.com/o/r/compare/v0.1.0...v0.2.0\n"), true);
});

test("release/notes render a first release without a range to compare against", () => {
  const body = renderReleaseNotes({ manifest, commits: ["- First (1234567)"], repository: "o/r" });

  assert.equal(body.includes("## Initial release\n\n- First (1234567)\n"), true);
  assert.equal(body.includes("## Changes"), false);
  assert.equal(body.includes("Full changelog"), false);
});

test("release/notes say so when a tag adds no commits, instead of replaying shipped ones", () => {
  const body = renderReleaseNotes({ manifest, previousTag: "v0.1.9", commits: [], repository: "o/r" });

  assert.equal(body.includes("## Changes\n\n- No changes since v0.1.9.\n"), true);
  assert.equal(body.includes("**Full changelog**: https://github.com/o/r/compare/v0.1.9...v0.2.0"), true);
});

test("release/notes honour a non-default server url without doubling its slash", () => {
  const body = renderReleaseNotes({
    manifest,
    previousTag: "v0.1.0",
    commits: [],
    repository: "o/r",
    serverUrl: "https://ghe.example.com/",
  });

  assert.equal(body.includes("**Full changelog**: https://ghe.example.com/o/r/compare/v0.1.0...v0.2.0"), true);
});
