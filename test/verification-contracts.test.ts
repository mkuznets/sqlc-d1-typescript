import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// Three properties that CI itself cannot tell us about, because a workflow that
// violates them still runs: an unpinned action, a credential visible outside the
// job that needs it, and a script that cannot load before the toolchain exists.

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const workflows = (): string[] =>
  readdirSync(resolve(process.cwd(), ".github/workflows")).map((name) => `.github/workflows/${name}`);
const actions = (): string[] => [".github/actions/setup/action.yml"];

test("every action every workflow uses is pinned to a full commit SHA", () => {
  for (const file of [...workflows(), ...actions()])
    for (const action of read(file).matchAll(/uses:\s*([^\s#]+)/g))
      if (!action[1].startsWith("./")) assert.match(action[1], /@[0-9a-f]{40}$/, `${file}: ${action[1]}`);
});

test("only the publish job may write contents or see publication credentials", () => {
  const release = read(".github/workflows/release.yml");
  const publish = release.slice(release.indexOf("  publish:"));
  const others = release.replace(publish, "");

  assert.match(publish, /environment: release-publication/);
  assert.match(publish, /permissions:\s*\n\s+contents: write/);
  assert.doesNotMatch(others, /contents: write|secrets\.R2_|environment: release-publication/);
  assert.equal((release.match(/contents: write/g) ?? []).length, 1);

  // Credentials reach the step that needs them, never a job-level `env:` block that
  // every step of the job would inherit.
  const jobEnv = /\n    env:\n((?:      [^\n]*\n)*)/.exec(publish)?.[1] ?? "";
  assert.doesNotMatch(jobEnv, /secrets\.|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY/);

  assert.doesNotMatch(read(".github/workflows/ci.yml"), /R2_|release-publication|CLOUDFLARE/i);
});

// pins.mjs chooses the Node version, so it runs on whatever Node the runner shipped
// with and before `npm ci`. TypeScript syntax or a package import turns that into a
// startup crash rather than a test failure.
test("the script that pins the toolchain runs before the toolchain exists", () => {
  const path = "scripts/workflows/pins.mjs";
  for (const found of read(path).matchAll(/^import\s+(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/gm))
    assert.ok(found[1].startsWith("node:"), `pins.mjs imports ${found[1]}, which is absent before npm ci`);

  // TypeScript syntax is not valid JavaScript, so parsing it as JavaScript is the
  // honest check — a Node that cannot strip types has to be able to read this file.
  const parsed = spawnSync(process.execPath, ["--check", resolve(process.cwd(), path)], { encoding: "utf8" });
  assert.equal(parsed.status, 0, `pins.mjs must parse as plain JavaScript:\n${parsed.stderr}`);
});
