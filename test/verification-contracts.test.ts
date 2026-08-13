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

test("verification/evidence-envelope accepts redacted evidence and rejects unknown fields", () => {
  const schema = readJson("verification/evidence.schema.json");
  const validate = new Ajv({ allErrors: true }).compile(schema as AnySchema);
  const valid = { schemaVersion: 1, candidateSha256: "0123456789abcdef".repeat(4), tools: { node: "24.12.0", sqlc: [], typescript: ["5.9.3"] }, configuration: { compatibilityFlags: [] }, scenarios: [{ id: "generator/current-commands", status: "passed" }], cleanup: { status: "confirmed" } };
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...valid, sqlSource: "SELECT secret" }), false);
  assert.equal(validate({ ...valid, tools: { ...valid.tools, authorizationHeader: "secret" } }), false);
  assert.equal(validate({ ...valid, scenarios: [{ ...valid.scenarios[0], stack: "secret" }] }), false);
});
