import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCandidateHarness } from "../generator/candidate.ts";
import { compileGeneratedResponse } from "../generator/compile.ts";
import { createPublicTypesRequest } from "../generator/scenarios.ts";
import { publicTypesConsumer } from "./consumer.ts";

const candidate = process.env.CANDIDATE_WASM;
if (!candidate) throw new Error("CANDIDATE_WASM is required");
const harness = createCandidateHarness({ bytes: readFileSync(candidate) });

test("types/public-api", async () => {
  const outcome = await (await harness).run(createPublicTypesRequest());
  assert.equal(outcome.exitCode, 0, outcome.diagnostics);
  assert.ok(outcome.response);
  compileGeneratedResponse(outcome.response, {
    additionalFiles: { "consumer.ts": publicTypesConsumer },
  });
});
