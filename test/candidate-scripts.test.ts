import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const bytes = Buffer.from("candidate");
const digest = createHash("sha256").update(bytes).digest("hex");

test("verification/generate-candidate-digest rejects mismatch before invoking sqlc", async () => {
  const { generateCandidate } = await import("../scripts/generate-candidate.ts");
  const directory = mkdtempSync(join(tmpdir(), "candidate-generation-"));
  try {
    const candidate = join(directory, "plugin.wasm");
    writeFileSync(candidate, bytes);
    writeFileSync(join(directory, "sqlc.yaml"), "plugins:\n  - wasm:\n      url: file:///old/plugin.wasm\n");

    await assert.rejects(
      generateCandidate({ candidate, sha256: "0".repeat(64), config: "sqlc.yaml", cwd: directory, sqlc: "not-called" }),
      /SHA-256 mismatch/,
    );
    assert.deepEqual(readdirSync(directory).sort(), ["plugin.wasm", "sqlc.yaml"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verification/generated-tree-comparison detects changed, added, and deleted output", async () => {
  const { compareGeneratedTrees } = await import("../scripts/check-generated-drift.ts");
  const directory = mkdtempSync(join(tmpdir(), "generated-trees-"));
  try {
    const expected = join(directory, "expected");
    const actual = join(directory, "actual");
    mkdirSync(expected);
    mkdirSync(actual);
    writeFileSync(join(expected, "index.ts"), "static expected");
    writeFileSync(join(actual, "index.ts"), "static changed but ignored");
    writeFileSync(join(expected, "changed.ts"), "old");
    writeFileSync(join(actual, "changed.ts"), "new");
    writeFileSync(join(expected, "deleted.ts"), "deleted");
    writeFileSync(join(actual, "added.ts"), "added");

    assert.deepEqual(await compareGeneratedTrees(expected, actual, ["index.ts"]), [
      { kind: "deleted", path: "deleted.ts" },
      { kind: "added", path: "added.ts" },
      { kind: "changed", path: "changed.ts" },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verification/generate-candidate-retained uses retained protected bytes and cleans temporary files", async () => {
  const { generateCandidate } = await import("../scripts/generate-candidate.ts");
  const directory = mkdtempSync(join(tmpdir(), "candidate-generation-"));
  try {
    const candidate = join(directory, "plugin.wasm");
    const fakeSqlc = join(directory, "fake-sqlc.mjs");
    writeFileSync(candidate, bytes);
    writeFileSync(join(directory, "sqlc.yaml"), "plugins:\n  - wasm:\n      url: file:///old/$&/plugin.wasm\n");
    writeFileSync(
      fakeSqlc,
      `#!/usr/bin/env node
import {readFileSync,writeFileSync,statSync} from 'node:fs';
writeFileSync(${JSON.stringify(candidate)}, 'substituted-after-validation');
const config=readFileSync(process.argv[3],'utf8'); const url=/url: (\\S+)/.exec(config)[1]; const path=new URL(url);
writeFileSync('observed.json', JSON.stringify({config,bytes:readFileSync(path,'utf8'),mode:statSync(path).mode & 0o777}));`,
    );
    chmodSync(fakeSqlc, 0o755);

    await generateCandidate({ candidate, sha256: digest, config: "sqlc.yaml", cwd: directory, sqlc: fakeSqlc });
    const observed = JSON.parse(readFileSync(join(directory, "observed.json"), "utf8")) as {
      config: string;
      bytes: string;
      mode: number;
    };

    assert.equal(observed.bytes, "candidate");
    assert.equal(observed.mode, 0o400);
    assert.doesNotMatch(observed.config, /\$&/);
    assert.equal(
      readdirSync(directory).some((name) => name.includes(".candidate-")),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
