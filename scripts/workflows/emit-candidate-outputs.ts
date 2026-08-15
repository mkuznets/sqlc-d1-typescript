#!/usr/bin/env node
// Publish the identity of the publication candidate this run built: its artifact ID,
// digest, and canonical filename.
//
// Reads: CANDIDATE_ARTIFACT_ID
// Usage: emit-candidate-outputs.ts [--candidate candidate.json]
// Outputs: artifact-id, sha256, wasm-filename
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, fail, flagValue, writeStepOutputs } from "./step.ts";
import type { CandidateDescriptor } from "../release-contract.ts";

const candidatePath = resolve(flagValue("--candidate", "candidate.json"));

let candidate: CandidateDescriptor;
try {
  candidate = JSON.parse(await readFile(candidatePath, "utf8")) as CandidateDescriptor;
} catch (error) {
  fail(`cannot read the candidate descriptor at ${candidatePath}: ${describe(error)}; the build step produced none`);
}

const id = process.env.CANDIDATE_ARTIFACT_ID ?? "";
if (!/^\d+$/.test(id)) fail(`numeric artifact ID was not produced (${JSON.stringify(id)}); the upload step failed`);
if (!/^[0-9a-f]{64}$/.test(candidate.sha256 ?? ""))
  fail(`candidate descriptor has an unusable sha256 (${JSON.stringify(candidate.sha256)})`);
if (!candidate.filename) fail("candidate descriptor has no canonical wasm filename");

console.log(`==> Publication candidate ${candidate.filename}`);
console.log(`    artifact-id ${id}`);
console.log(`    sha256      ${candidate.sha256}`);

await writeStepOutputs({
  "artifact-id": id,
  sha256: candidate.sha256,
  "wasm-filename": candidate.filename,
});
