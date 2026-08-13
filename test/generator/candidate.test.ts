import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCandidateHarness } from "./candidate";
import { createCurrentCommandsRequest, generatorScenarios, runScenario } from "./scenarios";

const candidatePath = requiredEnvironment("CANDIDATE_WASM");
const candidateSha256 = requiredEnvironment("CANDIDATE_SHA256");
const candidateBytes = readFileSync(candidatePath);
const candidateHarness = createCandidateHarness({ bytes: candidateBytes }, candidateSha256);

export const candidateScenarioIds = generatorScenarios.map(({ id }) => `candidate/${id.slice("generator/".length)}`);

for (const [index, scenario] of generatorScenarios.entries()) {
  test(candidateScenarioIds[index], async () => {
    await runScenario(await candidateHarness, scenario);
  });
}

test("candidate/digest-validation rejects missing, malformed, uppercase, and mismatched digests", async () => {
  const attempts = [
    undefined,
    "abc",
    "A".repeat(64),
    candidateSha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64),
  ];
  for (const digest of attempts) {
    await assert.rejects(
      createCandidateHarness({ bytes: candidateBytes }, digest as string),
      /candidate SHA-256/,
    );
  }
});

test("candidate/retained-bytes executes after the selected path is removed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlc-d1-retention-"));
  const selectedPath = join(directory, "plugin.wasm");
  try {
    writeFileSync(selectedPath, candidateBytes);
    const digest = createHash("sha256").update(candidateBytes).digest("hex");
    const harness = await createCandidateHarness({ path: selectedPath }, digest);
    unlinkSync(selectedPath);
    const outcome = await harness.run(createCurrentCommandsRequest());
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.equal(harness.candidateSha256, digest);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
