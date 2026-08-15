import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = (name: string): string => readFileSync(resolve(process.cwd(), ".github/workflows", name), "utf8");
const workflows = (): string[] => readdirSync(resolve(process.cwd(), ".github/workflows"));

// These three checks exist because each one caught a failure that no other test could:
// a workflow that fails to parse at dispatch time, an artifact that lands in a
// directory nothing reads, and a script that cannot load before `npm ci` has run.
// They check mechanics GitHub enforces, not the shape of our own YAML.

// A scope GitHub does not know is not a narrower permission, it is a workflow that
// fails to parse, and it fails at dispatch time rather than in any test.
test("every workflow names only permission scopes GitHub accepts", () => {
  const scopes = new Set([
    "actions",
    "attestations",
    "checks",
    "contents",
    "deployments",
    "discussions",
    "id-token",
    "issues",
    "models",
    "packages",
    "pages",
    "pull-requests",
    "repository-projects",
    "security-events",
    "statuses",
  ]);
  for (const file of workflows())
    for (const block of workflow(file).matchAll(/^(\s*)permissions:\s*\n((?:\1\s+[a-z-]+:\s*\S+\n)+)/gm))
      for (const entry of block[2].matchAll(/^\s+([a-z-]+):\s*(read|write|none)\s*$/gm))
        assert.ok(scopes.has(entry[1]), `${file} requests unknown permission scope ${entry[1]}`);
});

// download-artifact extracts straight into `path` only when it downloads one artifact
// selected by name. Selected by numeric ID it nests the files under a directory named
// after the artifact, and every step that reads `path/<file>` afterwards sees nothing.
test("every artifact download by ID extracts into the path the next step reads", () => {
  let byId = 0;
  for (const file of workflows())
    for (const step of workflow(file).matchAll(
      /uses: actions\/download-artifact@[0-9a-f]{40}[^\n]*\n((?:^(?![ \t]*-)[ \t]+[^\n]*\n)+)/gm,
    ))
      if (/artifact-ids:/.test(step[1])) {
        byId += 1;
        assert.match(step[1], /merge-multiple: true/, `${file}: a download by artifact ID does not set merge-multiple`);
      }
  assert.ok(byId > 0, "expected at least one download by artifact ID");
});

// The intent job validates the release identity before anything is installed. A
// package pulled in by a static import anywhere in that graph turns it into
// ERR_MODULE_NOT_FOUND at run time.
test("the scripts that run before any job installs dependencies import no packages", () => {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const found of source.matchAll(/^import\s+(?!type\s)(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/gm)) {
      const specifier = found[1];
      assert.ok(
        specifier.startsWith("node:") || specifier.startsWith("."),
        `${file.replace(`${process.cwd()}/`, "")} statically imports the package ${specifier}, which is absent until a job runs npm ci`,
      );
      if (specifier.startsWith(".")) visit(resolve(file, "..", specifier));
    }
  };
  for (const entry of [
    "scripts/release-contract.ts",
    "scripts/candidate-utils.ts",
    "scripts/github-run-artifacts.ts",
    "scripts/workflows/write-release-intent.ts",
    "scripts/workflows/emit-release-intent-outputs.ts",
    "scripts/workflows/emit-compatibility-outputs.ts",
    "scripts/workflows/emit-candidate-outputs.ts",
  ])
    visit(resolve(process.cwd(), entry));
});

// Publication writes to R2 and to the repository's releases. Confining both to the
// one job that holds the credentials is the property worth asserting; the rest of the
// workflow's shape is readable in the YAML itself.
test("only the publish job may write contents or see publication credentials", () => {
  const release = workflow("release.yml");
  const publish = release.slice(release.indexOf("  publish:"));
  const others = release.replace(publish, "");

  assert.match(publish, /environment: release-publication/);
  assert.match(publish, /permissions:\s*\n\s+contents: write\s*\n\s+actions: read/);
  assert.doesNotMatch(others, /contents: write|secrets\.R2_|environment: release-publication/);
  assert.equal((release.match(/contents: write/g) ?? []).length, 1);
  assert.equal((release.match(/make build/g) ?? []).length, 1);

  // Credentials reach the steps that need them, never a job-level `env:` block that
  // every step of the job would inherit.
  const jobEnv = /\n    env:\n((?:      [^\n]*\n)*)/.exec(publish)?.[1] ?? "";
  assert.doesNotMatch(jobEnv, /secrets\.|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY/);

  assert.doesNotMatch(workflow("ci.yml"), /R2_|release-publication|managed-d1|CLOUDFLARE/i);
});

test("every action every workflow uses is pinned to a full commit SHA", () => {
  for (const file of workflows())
    for (const action of workflow(file).matchAll(/uses:\s*([^\s#]+)/g))
      if (!action[1].startsWith("./")) assert.match(action[1], /@[0-9a-f]{40}$/, `${file}: ${action[1]}`);
});

// Managed verification provisions real Cloudflare resources. It must never be
// reachable from a pull request, and its credentials must stay in its own job.
test("managed verification is unreachable from a pull request and keeps its credentials", () => {
  const reusable = workflow("_managed-d1.yml");
  const entry = workflow("managed-d1.yml");

  assert.match(reusable, /^on:\n  workflow_call:/m);
  assert.doesNotMatch(reusable, /pull_request|schedule:|workflow_dispatch:/);
  assert.match(reusable, /environment: managed-d1/);
  assert.doesNotMatch(reusable, /  verify:[\s\S]*?\n    env:\s*\n\s+CLOUDFLARE/);
  assert.equal((reusable.match(/make build/g) ?? []).length, 0);
  assert.doesNotMatch(entry, /pull_request/);
  assert.match(entry, /reap-stale-managed-d1/);
});
