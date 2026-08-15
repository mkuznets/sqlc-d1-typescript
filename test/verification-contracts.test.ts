import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import Ajv, { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { candidateScenarioIds, executableCatalog } from "./catalog";
import { SUPPORTED_COMMANDS } from "../src/validation";

type ManifestTest = { id: string; layer: string; file: string; title: string; availability: "local" | "deferred" };
type PromiseContract = { id: string; category: string; primary: string[]; smoke: string[] };
type CoverageManifest = { schemaVersion: number; tests: ManifestTest[]; promises: PromiseContract[] };
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
const checkedManifest = readJson("verification/coverage-manifest.json") as CoverageManifest;

function validateCoverage(manifest: CoverageManifest): string[] {
  const schema = readJson("verification/coverage-manifest.schema.json");
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema as AnySchema);
  const errors: string[] = [];
  if (!validate(manifest))
    errors.push(...(validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`));
  const tests = new Map<string, ManifestTest>();
  for (const item of manifest.tests) {
    if (tests.has(item.id)) errors.push(`duplicate test ID ${item.id}`);
    tests.set(item.id, item);
  }
  const promises = new Set<string>();
  for (const promise of manifest.promises) {
    if (promises.has(promise.id)) errors.push(`duplicate promise ID ${promise.id}`);
    promises.add(promise.id);
    if (promise.primary.length !== 1) errors.push(`${promise.id} must have exactly one primary owner`);
    const primary = promise.primary[0];
    if (primary && !tests.has(primary)) errors.push(`${promise.id} references unknown primary ${primary}`);
    if (primary && promise.smoke.includes(primary)) errors.push(`${promise.id} repeats primary as smoke`);
    for (const smoke of promise.smoke)
      if (!tests.has(smoke)) errors.push(`${promise.id} references unknown smoke ${smoke}`);
    if (primary && tests.get(primary)?.availability !== "local")
      errors.push(`${promise.id} primary must be locally available`);
  }
  return errors;
}

test("verification/coverage-graph matches schema, catalog, registrations, sources, and ownership graph", () => {
  assert.deepEqual(validateCoverage(checkedManifest), []);
  const byId = (items: readonly ManifestTest[]) => [...items].sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(byId(checkedManifest.tests), byId(executableCatalog));

  for (const item of checkedManifest.tests) {
    if (item.availability === "local")
      assert.ok(existsSync(item.file), `${item.id} source file does not exist: ${item.file}`);
  }

  const sourceIds = new Map<string, string[]>();
  const hasLiteralRegistrations = ({ availability, layer, file, id }: ManifestTest): boolean =>
    availability === "local" &&
    ((layer === "verification" && file.endsWith(".test.ts")) ||
      (["miniflare", "example"].includes(layer) && file.endsWith(".spec.ts")) ||
      (layer === "candidate" && ["candidate/digest-validation", "candidate/retained-bytes"].includes(id)));
  for (const item of checkedManifest.tests.filter(hasLiteralRegistrations)) {
    const ids = sourceIds.get(item.file) ?? extractRegisteredIds(readFileSync(item.file, "utf8"));
    sourceIds.set(item.file, ids);
    assert.equal(
      ids.filter((id) => id === item.id).length,
      1,
      `${item.id} must be registered exactly once in ${item.file}`,
    );
  }

  const catalogIds = new Set(checkedManifest.tests.map(({ id }) => id));
  for (const [file, ids] of sourceIds)
    for (const id of ids) assert.ok(catalogIds.has(id), `${id} is executable in ${file} but missing from catalog`);

  assert.deepEqual(
    executableCatalog
      .filter(
        ({ layer, id }) =>
          layer === "candidate" && !["candidate/digest-validation", "candidate/retained-bytes"].includes(id),
      )
      .map(({ id }) => id),
    candidateScenarioIds,
    "candidate scenario registry and catalog must remain identical",
  );
});

test("verification/coverage-mutations rejects unknown and duplicate ownership", () => {
  const clone = (): CoverageManifest => structuredClone(checkedManifest);
  const missing = clone();
  missing.promises[0].primary = [];
  assert.match(validateCoverage(missing).join("\n"), /exactly one primary owner|minItems/);
  const duplicate = clone();
  duplicate.promises[0].primary.push(duplicate.promises[1].primary[0]);
  assert.match(validateCoverage(duplicate).join("\n"), /exactly one primary owner|maxItems/);
  const unknown = clone();
  unknown.promises[0].smoke.push("generator/does-not-exist");
  assert.match(validateCoverage(unknown).join("\n"), /unknown smoke/);
});

test("verification/surface-inventory inventories commands, macros, errors, conversions, and diagnostics", () => {
  const ids = new Set(checkedManifest.promises.map(({ id }) => id));
  for (const command of SUPPORTED_COMMANDS) assert.ok(ids.has(`command-${command.slice(1)}`), command);
  for (const macro of ["positional", "arg", "narg", "slice", "embed"]) assert.ok(ids.has(`macro-${macro}`), macro);
  for (const error of ["sqlc-d1", "argument", "usage", "result", "native-identity"])
    assert.ok(ids.has(`error-${error}`), error);
  for (const conversion of ["integer", "number", "text", "null", "boolean", "json", "blob", "opaque", "row-renaming"])
    assert.ok(ids.has(`conversion-${conversion}`), conversion);
  for (const diagnostic of [
    "protocol",
    "options",
    "query",
    "unsupported-command",
    "unsupported-bind",
    "unsupported-embed",
    "aggregation",
    "redaction",
    "sqlc-version",
  ])
    assert.ok(ids.has(`diagnostic-${diagnostic}`), diagnostic);
});

function extractRegisteredIds(source: string): string[] {
  return [
    ...source.matchAll(
      /(?:test|it)\(\s*["'`]((?:generator|types|miniflare|example|candidate|verification)\/[a-z][a-z0-9-]*)\b/g,
    ),
  ].map((match) => match[1]);
}

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
  for (const file of readdirSync(resolve(process.cwd(), ".github/workflows"))) {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows", file), "utf8");
    for (const block of workflow.matchAll(/^(\s*)permissions:\s*\n((?:\1\s+[a-z-]+:\s*\S+\n)+)/gm))
      for (const entry of block[2].matchAll(/^\s+([a-z-]+):\s*(read|write|none)\s*$/gm))
        assert.ok(scopes.has(entry[1]), `${file} requests unknown permission scope ${entry[1]}`);
  }
});

// download-artifact extracts straight into `path` only when it downloads one artifact
// selected by name. Selected by numeric ID it nests the files under a directory named
// after the artifact, and every step that reads `path/<file>` afterwards sees nothing.
test("every artifact download by ID extracts into the path the next step reads", () => {
  let byId = 0;
  for (const file of readdirSync(resolve(process.cwd(), ".github/workflows"))) {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows", file), "utf8");
    for (const step of workflow.matchAll(
      /uses: actions\/download-artifact@[0-9a-f]{40}[^\n]*\n((?:^(?![ \t]*-)[ \t]+[^\n]*\n)+)/gm,
    ))
      if (/artifact-ids:/.test(step[1])) {
        byId += 1;
        assert.match(step[1], /merge-multiple: true/, `${file}: a download by artifact ID does not set merge-multiple`);
      }
  }
  assert.ok(byId >= 12, `expected the release spine's downloads by ID, found ${byId}`);
});

// The intent job validates the release identity before anything is installed, and the
// candidate reuse path never installs at all. A package pulled in by a static import
// anywhere in that graph turns both into ERR_MODULE_NOT_FOUND at run time.
test("the scripts that run before any job installs dependencies import no packages", () => {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const found of source.matchAll(/^import\s+(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/gm)) {
      const specifier = found[1];
      assert.ok(
        specifier.startsWith("node:") || specifier.startsWith("."),
        `${file.replace(`${process.cwd()}/`, "")} statically imports the package ${specifier}, which is absent until a job runs npm ci`,
      );
      if (specifier.startsWith(".")) visit(resolve(file, "..", specifier));
    }
  };
  for (const entry of [
    "scripts/release-contract.mjs",
    "scripts/candidate-utils.mjs",
    "scripts/github-run-artifacts.mjs",
    "scripts/workflows/write-release-intent.mjs",
    "scripts/workflows/emit-release-intent-outputs.mjs",
    "scripts/workflows/emit-compatibility-outputs.mjs",
    "scripts/workflows/emit-candidate-outputs.mjs",
  ])
    visit(resolve(process.cwd(), entry));
});

test("release workflow is an exact-artifact managed-D1-gated publication spine", () => {
  const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /tags: \["v\*"\]/);
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+version:/);
  assert.match(workflow, /group: \$\{\{ github\.repository \}\}-release/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
  // Publication writes releases and R2 objects, so the blanket prohibition is gone;
  // what replaces it is narrower and sharper. Nothing may create or move a tag, no
  // job may mint an OIDC token, and exactly one job may write repository contents.
  assert.doesNotMatch(workflow, /id-token: write|pull_request_target|pull_request:/);
  assert.doesNotMatch(workflow, /gh release|git tag|git push|actions\/create-release/);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.equal((workflow.match(/make build/g) ?? []).length, 1);
  for (const action of workflow.matchAll(/uses:\s*([^\s#]+)/g))
    if (!action[1].startsWith("./")) assert.match(action[1], /@[0-9a-f]{40}$/, action[1]);

  for (const job of [
    "local-verification",
    "sqlc-compatibility",
    "uncredentialed-gates",
    "managed-d1",
    "release-spine-complete",
    "publication-preflight",
    "publish",
  ])
    assert.match(workflow, new RegExp(`  ${job}:`));

  // A job may carry a human-readable `name:` before its `needs:`.
  const dependsOn = (job: string, needs: string) =>
    new RegExp(`${job}:\\s*\\n(?:\\s+name: .*\\n)?\\s+needs: \\[${needs}\\]`);
  assert.match(workflow, dependsOn("local-verification", "intent, candidate"));
  assert.match(workflow, dependsOn("sqlc-compatibility", "intent, candidate"));
  assert.match(
    workflow,
    dependsOn("uncredentialed-gates", "intent, candidate, local-verification, sqlc-compatibility"),
  );
  assert.match(workflow, dependsOn("managed-d1", "intent, candidate, uncredentialed-gates"));
  assert.match(workflow, dependsOn("release-spine-complete", "intent, candidate, uncredentialed-gates, managed-d1"));
  assert.match(workflow, dependsOn("publication-preflight", "intent"));
  assert.match(
    workflow,
    dependsOn(
      "publish",
      "intent, candidate, uncredentialed-gates, managed-d1, release-spine-complete, publication-preflight",
    ),
  );
  assert.doesNotMatch(workflow, /make verify-local|make test(?:\s|$)/);
  assert.match(workflow, /make verify-candidate/);

  const local = workflow.slice(workflow.indexOf("  local-verification:"), workflow.indexOf("  sqlc-compatibility:"));
  assert.match(local, /sqlc-dev\/setup-sqlc@[0-9a-f]{40}/);
  assert.match(local, /sqlc-ceiling-install/);

  assert.match(workflow, /artifact-ids: "\$\{\{ needs\.candidate\.outputs\.artifact-id \}\}"/);
  assert.match(workflow, /publication-candidate-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /release-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /sqlc-gen-d1-typescript_\$\{\{ needs\.intent\.outputs\.version \}\}\.manifest\.json/);
  assert.doesNotMatch(workflow, /release-manifest\.json/);

  const candidate = workflow.slice(workflow.indexOf("  candidate:"), workflow.indexOf("  local-verification:"));
  assert.match(candidate, /--allow-create "\$ALLOW_CREATE"/);
  assert.match(candidate, /github\.run_attempt == 1/);
  const reuse = candidate.slice(
    candidate.indexOf("steps.lookup.outputs.mode == 'reuse'"),
    candidate.indexOf("steps.lookup.outputs.mode == 'create'"),
  );
  assert.doesNotMatch(reuse, /make build|upload-artifact|javy/);

  assert.match(workflow, /validate-compatibility-set/);
  assert.match(workflow, /--managed-evidence managed\/managed-d1-evidence\.json/);
});

test("verification/publication-workflow-security - confines writing and R2 credentials to the two publication jobs", () => {
  const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/release.yml"), "utf8");
  const ci = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

  const slice = (job: string, next?: string): string =>
    workflow.slice(workflow.indexOf(`  ${job}:`), next ? workflow.indexOf(`  ${next}:`) : workflow.length);
  const preflight = slice("publication-preflight", "release-spine-complete");
  const publish = slice("publish");
  const others = workflow.replace(preflight, "").replace(publish, "");

  for (const job of [preflight, publish]) assert.match(job, /environment: release-publication/);
  assert.match(preflight, /permissions:\s*\n\s+contents: read\s*\n/);
  assert.match(publish, /permissions:\s*\n\s+contents: write\s*\n\s+actions: read/);
  assert.doesNotMatch(others, /contents: write|secrets\.R2_|environment: release-publication/);

  // Credentials reach one step each and never a job-level `env:` block, which every
  // step of the job would inherit.
  for (const job of [preflight, publish]) {
    const jobEnv = /\n    env:\n((?:      [^\n]*\n)*)/.exec(job)?.[1] ?? "";
    assert.doesNotMatch(jobEnv, /secrets\.|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|GITHUB_TOKEN/);
    assert.match(job, /R2_ACCESS_KEY_ID: "\$\{\{ secrets\.R2_ACCESS_KEY_ID \}\}"/);
    assert.match(job, /CLOUDFLARE_ACCOUNT_ID: "\$\{\{ vars\.CLOUDFLARE_ACCOUNT_ID \}\}"/);
  }

  // Publication is one process invoked from one script, not a pile of CLI calls.
  assert.match(preflight, /node scripts\/publish-release\.mjs preflight/);
  assert.match(publish, /node scripts\/publish-release\.mjs publish/);
  assert.match(publish, /node scripts\/publish-release\.mjs teardown/);
  // R2 is reached through the aws CLI, but only from inside publish-release.mjs, so
  // ordering and the version-key boundary stay readable in one place.
  assert.doesNotMatch(workflow, /\bgh api\b|\bwrangler\b|\baws s3\b/);

  // The mode a publication runs in is derived from the validated dry-run identity,
  // and the script refuses to advertise anything when that mode is a dry run.
  assert.match(
    publish,
    /PUBLICATION_MODE: "\$\{\{ needs\.intent\.outputs\.dry-run == 'true' && 'dry-run' \|\| 'publish' \}\}"/,
  );
  assert.match(publish, /--mode "\$PUBLICATION_MODE"/);
  assert.match(
    publish,
    /if: \$\{\{ always\(\) && needs\.intent\.outputs\.dry-run == 'true' && !hashFiles\('publication-record\.json'\) \}\}/,
  );
  assert.match(publish, /name: "\$\{\{ env\.PUBLICATION_ARTIFACT \}\}"[\s\S]*?retention-days: 30/);
  assert.equal((publish.match(/if: \$\{\{ always\(\)/g) ?? []).length, 3);
  assert.equal((workflow.match(/continue-on-error: true/g) ?? []).length, 1);
  assert.match(publish, /continue-on-error: true/, "only the publication step may continue so teardown can run");

  // The outcome of the credentialed job is decided in one extracted script.
  const finalize = readFileSync(resolve(process.cwd(), "scripts/workflows/finalize-publication.sh"), "utf8");
  assert.match(publish, /run: bash scripts\/workflows\/finalize-publication\.sh/);
  assert.match(publish, /PUBLISH_OUTCOME: "\$\{\{ steps\.execute\.outcome \}\}"/);
  assert.match(finalize, /validate-record/);
  assert.match(finalize, /a dry run published a release/);
  assert.match(finalize, /test "\$\{PUBLISH_OUTCOME:-\}" = success/);

  assert.doesNotMatch(ci, /R2_|release-publication|immutable-releases/);
});

test("verification/managed-workflow-security - isolates credentials and exact candidates from ordinary CI", () => {
  const reusable = readFileSync(resolve(process.cwd(), ".github/workflows/_managed-d1.yml"), "utf8");
  const entry = readFileSync(resolve(process.cwd(), ".github/workflows/managed-d1.yml"), "utf8");
  const ci = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

  assert.match(reusable, /^on:\n  workflow_call:/m);
  assert.doesNotMatch(reusable, /pull_request|schedule:|workflow_dispatch:/);
  assert.match(reusable, /environment: managed-d1/);
  assert.match(reusable, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(reusable, /vars\.CLOUDFLARE_ACCOUNT_ID/);
  assert.doesNotMatch(reusable, /  verify:[\s\S]*?\n    env:\s*\n\s+CLOUDFLARE/);
  assert.match(reusable, /artifact-ids: "\$\{\{ inputs\.candidate-artifact-id \}\}"/);
  assert.equal(
    (reusable.match(/merge-multiple: true/g) ?? []).length,
    (reusable.match(/uses: actions\/download-artifact@/g) ?? []).length,
  );
  assert.equal((reusable.match(/make build/g) ?? []).length, 0);
  assert.match(reusable, /managed-d1-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(reusable, /--prefix "managed-d1-evidence-\$\{\{ github\.run_id \}\}-"/);
  assert.match(reusable, /retention-days: 30/);
  assert.match(reusable, /if: \$\{\{ always\(\)/);

  // The outcome of the credentialed job is decided in one extracted script.
  const finalize = readFileSync(resolve(process.cwd(), "scripts/workflows/finalize-managed-evidence.sh"), "utf8");
  assert.match(reusable, /run: bash scripts\/workflows\/finalize-managed-evidence\.sh/);
  assert.match(reusable, /REUSED_ARTIFACT_ID: "\$\{\{ steps\.lookup\.outputs\.artifact-id \}\}"/);
  assert.match(reusable, /CREATED_ARTIFACT_ID: "\$\{\{ steps\.upload\.outputs\.artifact-id \}\}"/);
  assert.match(reusable, /VERIFY_OUTCOME: "\$\{\{ steps\.execute\.outcome \}\}"/);
  assert.match(finalize, /validate-evidence/);
  assert.match(finalize, /\^\[0-9\]\+\$/);
  assert.match(finalize, /"\$LOOKUP_MODE" != reuse && test "\$\{VERIFY_OUTCOME:-\}" != success/);

  assert.match(entry, /schedule:/);
  assert.match(entry, /workflow_dispatch:/);
  assert.doesNotMatch(entry, /pull_request/);
  assert.equal((entry.match(/make build/g) ?? []).length, 1);
  assert.match(entry, /reap-stale-managed-d1/);
  assert.doesNotMatch(ci, /managed-d1|CLOUDFLARE|environment:|pull_request_target|wrangler deploy/i);

  for (const source of [reusable, entry])
    for (const action of source.matchAll(/uses:\s*([^\s#]+)/g))
      if (!action[1].startsWith("./")) assert.match(action[1], /@[0-9a-f]{40}$/);
});

test("verification/evidence-envelope accepts redacted evidence and rejects unknown fields", () => {
  const schema = readJson("verification/evidence.schema.json");
  const validate = new Ajv({ allErrors: true }).compile(schema as AnySchema);
  const valid = {
    schemaVersion: 1,
    candidateSha256: "0123456789abcdef".repeat(4),
    tools: {
      node: "24.12.0",
      npm: "11.6.2",
      bun: "1.3.10",
      sqlc: ["v1.18.0", "v1.31.1"],
      typescript: ["5.2.2", "5.9.3"],
      workersTypes: "4.20260214.0",
      wrangler: "4.63.0",
      vitestPoolWorkers: "0.12.21",
      miniflare: "4.20260310.0",
      workerd: "1.20260310.1",
      buf: "1.65.0",
      javy: "8.0.0",
    },
    configuration: { compatibilityDate: "2026-02-05", compatibilityFlags: [], knownExceptions: [] },
    scenarios: [{ id: "generator/current-commands", status: "passed" }],
    cleanup: { status: "confirmed" },
  };
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));

  for (const forbidden of [
    "sqlSource",
    "credentials",
    "managedD1Version",
    "sqliteVersion",
    "rows",
    "values",
    "bookmarks",
  ])
    assert.equal(validate({ ...valid, [forbidden]: "forbidden" }), false, forbidden);

  assert.equal(validate({ ...valid, tools: { ...valid.tools, authorizationHeader: "secret" } }), false);
  assert.equal(validate({ ...valid, scenarios: [{ ...valid.scenarios[0], stack: "secret" }] }), false);
});
