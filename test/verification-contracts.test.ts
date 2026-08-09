import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import Ajv, { AnySchema } from "ajv";

type Scenario = { id: string; layer: string };
type PromiseContract = { id: string; primary: string; smoke: string[] };
type CoverageManifest = {
  schemaVersion: number;
  scenarios: Scenario[];
  promises: PromiseContract[];
};

const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));

test("verification/coverage-manifest has unique stable IDs and valid references", () => {
  const manifest = readJson("verification/coverage-manifest.json") as CoverageManifest;
  assert.equal(manifest.schemaVersion, 1);
  const scenarioIds = manifest.scenarios.map(({ id }) => id);
  const promiseIds = manifest.promises.map(({ id }) => id);
  assertUnique(scenarioIds, "scenario");
  assertUnique(promiseIds, "promise");
  for (const id of scenarioIds) assert.match(id, /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/);
  for (const id of promiseIds) assert.match(id, /^[a-z][a-z0-9-]*$/);

  const scenarios = new Set(scenarioIds);
  for (const promise of manifest.promises) {
    assert.equal(typeof promise.primary, "string");
    assert.ok(scenarios.has(promise.primary), `unknown primary scenario ${promise.primary}`);
    assertUnique(promise.smoke, `smoke reference in ${promise.id}`);
    assert.ok(!promise.smoke.includes(promise.primary), `${promise.id} repeats its primary as smoke`);
    for (const id of promise.smoke) assert.ok(scenarios.has(id), `unknown smoke scenario ${id}`);
  }
});

test("verification/evidence-envelope accepts redacted evidence and rejects unknown fields", () => {
  const schema = readJson("verification/evidence.schema.json");
  const validate = new Ajv({ allErrors: true }).compile(schema as AnySchema);
  const valid = {
    schemaVersion: 1,
    candidateSha256: "0123456789abcdef".repeat(4),
    tools: { node: "24.12.0", sqlc: [], typescript: ["5.9.3"] },
    configuration: { compatibilityFlags: [] },
    scenarios: [{ id: "generator/current-commands", status: "passed" }],
    cleanup: { status: "confirmed" },
  };
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...valid, sqlSource: "SELECT secret" }), false);
  assert.equal(validate({ ...valid, tools: { ...valid.tools, authorizationHeader: "secret" } }), false);
  assert.equal(validate({ ...valid, scenarios: [{ ...valid.scenarios[0], stack: "secret" }] }), false);
});

function assertUnique(values: string[], kind: string): void {
  assert.equal(new Set(values).size, values.length, `duplicate ${kind} ID`);
}
