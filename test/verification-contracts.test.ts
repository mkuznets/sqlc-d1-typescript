import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  if (!validate(manifest)) errors.push(...(validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`));
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
    for (const smoke of promise.smoke) if (!tests.has(smoke)) errors.push(`${promise.id} references unknown smoke ${smoke}`);
    if (primary && tests.get(primary)?.availability !== "local") errors.push(`${promise.id} primary must be locally available`);
  }
  return errors;
}

test("verification/coverage-graph matches schema, catalog, registrations, sources, and ownership graph", () => {
  assert.deepEqual(validateCoverage(checkedManifest), []);
  const byId = (items: readonly ManifestTest[]) => [...items].sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(byId(checkedManifest.tests), byId(executableCatalog));
  for (const item of checkedManifest.tests) {
    if (item.availability === "local") assert.ok(existsSync(item.file), `${item.id} source file does not exist: ${item.file}`);
  }
  const sourceIds = new Map<string, string[]>();
  const hasLiteralRegistrations = ({ availability, layer, file, id }: ManifestTest): boolean =>
    availability === "local" && (layer === "verification" && file.endsWith(".test.ts") || ["miniflare", "example"].includes(layer) && file.endsWith(".spec.ts") || layer === "candidate" && ["candidate/digest-validation", "candidate/retained-bytes"].includes(id));
  for (const item of checkedManifest.tests.filter(hasLiteralRegistrations)) {
    const ids = sourceIds.get(item.file) ?? extractRegisteredIds(readFileSync(item.file, "utf8"));
    sourceIds.set(item.file, ids);
    assert.equal(ids.filter((id) => id === item.id).length, 1, `${item.id} must be registered exactly once in ${item.file}`);
  }
  const catalogIds = new Set(checkedManifest.tests.map(({ id }) => id));
  for (const [file, ids] of sourceIds) for (const id of ids) assert.ok(catalogIds.has(id), `${id} is executable in ${file} but missing from catalog`);
  assert.deepEqual(
    executableCatalog.filter(({ layer, id }) => layer === "candidate" && !["candidate/digest-validation", "candidate/retained-bytes"].includes(id)).map(({ id }) => id),
    candidateScenarioIds,
    "candidate scenario registry and catalog must remain identical",
  );
});

test("verification/coverage-mutations rejects unknown and duplicate ownership", () => {
  const clone = (): CoverageManifest => structuredClone(checkedManifest);
  const missing = clone(); missing.promises[0].primary = [];
  assert.match(validateCoverage(missing).join("\n"), /exactly one primary owner|minItems/);
  const duplicate = clone(); duplicate.promises[0].primary.push(duplicate.promises[1].primary[0]);
  assert.match(validateCoverage(duplicate).join("\n"), /exactly one primary owner|maxItems/);
  const unknown = clone(); unknown.promises[0].smoke.push("generator/does-not-exist");
  assert.match(validateCoverage(unknown).join("\n"), /unknown smoke/);
});

test("verification/surface-inventory inventories commands, macros, errors, conversions, and diagnostics", () => {
  const ids = new Set(checkedManifest.promises.map(({ id }) => id));
  for (const command of SUPPORTED_COMMANDS) assert.ok(ids.has(`command-${command.slice(1)}`), command);
  for (const macro of ["positional", "arg", "narg", "slice", "embed"]) assert.ok(ids.has(`macro-${macro}`), macro);
  for (const error of ["sqlc-d1", "argument", "usage", "result", "native-identity"]) assert.ok(ids.has(`error-${error}`), error);
  for (const conversion of ["integer", "number", "text", "null", "boolean", "json", "blob", "opaque", "row-renaming"]) assert.ok(ids.has(`conversion-${conversion}`), conversion);
  for (const diagnostic of ["protocol", "options", "query", "unsupported-command", "unsupported-bind", "unsupported-embed", "aggregation", "redaction", "sqlc-version"]) assert.ok(ids.has(`diagnostic-${diagnostic}`), diagnostic);
});

function extractRegisteredIds(source: string): string[] {
  return [...source.matchAll(/(?:test|it)\(\s*["'`]((?:generator|types|miniflare|example|candidate|verification)\/[a-z][a-z0-9-]*)\b/g)].map((match) => match[1]);
}

test("release workflow is an exact-artifact non-publishing spine", () => {
  const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /tags: \["v\*"\]/); assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+version:/);
  assert.match(workflow, /group: \$\{\{ github\.repository \}\}-release/); assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
  assert.doesNotMatch(workflow, /secrets\.|environment:|id-token: write|pull_request_target|gh release|wrangler|\br2\b|s3|git tag|create-a-release/i);
  assert.equal((workflow.match(/make build/g) ?? []).length, 1);
  for (const action of workflow.matchAll(/uses:\s*([^\s#]+)/g)) assert.match(action[1], /@[0-9a-f]{40}$/, action[1]);
  for (const job of ["local-verification", "sqlc-compatibility", "uncredentialed-gates", "documentation-readiness", "release-spine-complete"]) assert.match(workflow, new RegExp(`  ${job}:`));
  assert.match(workflow, /local-verification:\s*\n\s+needs: \[intent, candidate\]/); assert.match(workflow, /sqlc-compatibility:\s*\n\s+needs: \[intent, candidate\]/);
  assert.match(workflow, /uncredentialed-gates:\s*\n\s+needs: \[intent, candidate, local-verification, sqlc-compatibility\]/);
  assert.match(workflow, /documentation-readiness:\s*\n\s+needs: \[intent, candidate, uncredentialed-gates\]/);
  assert.match(workflow, /release-spine-complete:\s*\n\s+needs: \[intent, candidate, uncredentialed-gates, documentation-readiness\]/);
  assert.doesNotMatch(workflow, /make verify-local|make test(?:\s|$)/); assert.match(workflow, /make verify-candidate/);
  assert.equal((workflow.match(/make test-documentation/g) ?? []).length, 1);
  const documentation = workflow.slice(workflow.indexOf("  documentation-readiness:"), workflow.indexOf("  release-spine-complete:"));
  assert.match(documentation, /sqlc-dev\/setup-sqlc@[0-9a-f]{40}/);
  assert.match(documentation, /artifact-ids: "\$\{\{ needs\.candidate\.outputs\.artifact-id \}\}"/);
  assert.match(documentation, /validate-candidate/);
  assert.match(documentation, /CANDIDATE_SHA256="\$\{\{ needs\.candidate\.outputs\.sha256 \}\}"/);
  assert.doesNotMatch(documentation.replace(/^\s*#.*$/gm, ""), /make build|upload-artifact|secrets\.|environment:|wrangler|\br2\b|publish/i);
  const local = workflow.slice(workflow.indexOf("  local-verification:"), workflow.indexOf("  sqlc-compatibility:"));
  assert.match(local, /sqlc-dev\/setup-sqlc@[0-9a-f]{40}/); assert.match(local, /sqlc-ceiling-install/);
  assert.match(workflow, /artifact-ids: "\$\{\{ needs\.candidate\.outputs\.artifact-id \}\}"/);
  assert.match(workflow, /publication-candidate-\$\{\{ github\.run_id \}\}/); assert.match(workflow, /release-evidence-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /sqlc-gen-d1-typescript_\$\{\{ needs\.intent\.outputs\.version \}\}\.manifest\.json/); assert.doesNotMatch(workflow, /release-manifest\.json/);
  const candidate = workflow.slice(workflow.indexOf("  candidate:"), workflow.indexOf("  local-verification:"));
  assert.match(candidate, /--allow-create "\$ALLOW_CREATE"/); assert.match(candidate, /github\.run_attempt == 1/);
  const reuse = candidate.slice(candidate.indexOf("steps.lookup.outputs.mode == 'reuse'"), candidate.indexOf("steps.lookup.outputs.mode == 'create'"));
  assert.doesNotMatch(reuse, /make build|upload-artifact|javy/);
});

test("verification/evidence-envelope accepts redacted evidence and rejects unknown fields", () => {
  const schema = readJson("verification/evidence.schema.json");
  const validate = new Ajv({ allErrors: true }).compile(schema as AnySchema);
  const valid = {
    schemaVersion: 1, candidateSha256: "0123456789abcdef".repeat(4),
    tools: { node: "24.12.0", npm: "11.6.2", bun: "1.3.10", sqlc: ["v1.18.0", "v1.31.1"], typescript: ["5.2.2", "5.9.3"], workersTypes: "4.20260214.0", wrangler: "4.63.0", vitestPoolWorkers: "0.12.21", miniflare: "4.20260310.0", workerd: "1.20260310.1", buf: "1.65.0", javy: "8.0.0" },
    configuration: { compatibilityDate: "2026-02-05", compatibilityFlags: [], knownExceptions: [] },
    scenarios: [{ id: "generator/current-commands", status: "passed" }], cleanup: { status: "confirmed" },
  };
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  for (const forbidden of ["sqlSource", "credentials", "managedD1Version", "sqliteVersion", "rows", "values", "bookmarks"]) assert.equal(validate({ ...valid, [forbidden]: "forbidden" }), false, forbidden);
  assert.equal(validate({ ...valid, tools: { ...valid.tools, authorizationHeader: "secret" } }), false);
  assert.equal(validate({ ...valid, scenarios: [{ ...valid.scenarios[0], stack: "secret" }] }), false);
});
