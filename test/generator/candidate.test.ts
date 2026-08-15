import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCandidateHarness } from "./candidate.ts";
import { createCurrentCommandsRequest, generatorScenarios, runScenario } from "./scenarios.ts";

const candidatePath = requiredEnvironment("CANDIDATE_WASM");
const candidateBytes = readFileSync(candidatePath);
const candidateHarness = createCandidateHarness({ bytes: candidateBytes });

export const candidateScenarioIds = generatorScenarios.map(({ id }) => `candidate/${id.slice("generator/".length)}`);

for (const [index, scenario] of generatorScenarios.entries()) {
  test(candidateScenarioIds[index], async () => {
    await runScenario(await candidateHarness, scenario);
  });
}

test("candidate/retained-bytes executes after the selected path is removed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlc-d1-retention-"));
  const selectedPath = join(directory, "plugin.wasm");
  try {
    writeFileSync(selectedPath, candidateBytes);
    const harness = await createCandidateHarness({ path: selectedPath });
    unlinkSync(selectedPath);
    const outcome = await harness.run(createCurrentCommandsRequest());
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
