import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCandidateHarness } from "../generator/candidate";
import { compileGeneratedResponse } from "../generator/compile";
import { createPublicTypesRequest } from "../generator/scenarios";
import { publicTypesConsumer } from "./consumer";
import { typeCatalog } from "./catalog";

const candidate = process.env.CANDIDATE_WASM;
const sha256 = process.env.CANDIDATE_SHA256;
if (!candidate || !sha256) throw new Error("CANDIDATE_WASM and CANDIDATE_SHA256 are required");
const harness = createCandidateHarness({ bytes: readFileSync(candidate) }, sha256);

for (const catalog of typeCatalog) {
  test(catalog.id, async () => {
    const outcome = await (await harness).run(createPublicTypesRequest());
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.ok(outcome.response);
    compileGeneratedResponse(outcome.response, {
      compiler: catalog.id.endsWith("5-2") ? "typescript-5-2" : "typescript",
      additionalFiles: { "consumer.ts": publicTypesConsumer },
    });
  });
}
