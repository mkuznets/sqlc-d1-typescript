#!/usr/bin/env node
// Publish the identity of the publication candidate — its artifact ID, digest and
// canonical filename — whether this attempt built it or reused the one an earlier
// attempt of the same run uploaded.
//
// Reads: CREATED_ID, REUSED_ID
// Usage: emit-candidate-outputs.mjs [--candidate candidate.json]
// Outputs: artifact-id, sha256, wasm-filename
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const index = argv.indexOf("--candidate");
const candidatePath = resolve(index === -1 ? "candidate.json" : (argv[index + 1] ?? ""));

let candidate;
try {
  candidate = JSON.parse(await readFile(candidatePath, "utf8"));
} catch (error) {
  fail(
    `cannot read the candidate descriptor at ${candidatePath}: ${error instanceof Error ? error.message : error}; neither the build nor the reuse path produced one`,
  );
}

const reused = process.env.REUSED_ID ?? "";
const id = reused || (process.env.CREATED_ID ?? "");
if (!/^\d+$/.test(id))
  fail(
    `numeric artifact ID was not produced (reused=${JSON.stringify(reused)}, created=${JSON.stringify(process.env.CREATED_ID ?? "")}); the upload step failed or the lookup returned nothing`,
  );
if (!/^[0-9a-f]{64}$/.test(candidate.sha256 ?? ""))
  fail(`candidate descriptor has an unusable sha256 (${JSON.stringify(candidate.sha256)})`);
if (!candidate.filename) fail("candidate descriptor has no canonical wasm filename");

console.log(`==> Publication candidate ${candidate.filename}`);
console.log(
  `    artifact-id ${id} (${reused ? "reused from an earlier attempt of this run" : "built by this attempt"})`,
);
console.log(`    sha256      ${candidate.sha256}`);

const githubOutput = process.env.GITHUB_OUTPUT;
if (!githubOutput) fail("GITHUB_OUTPUT is not set; this script only runs inside a GitHub Actions step");
await appendFile(githubOutput, `artifact-id=${id}\nsha256=${candidate.sha256}\nwasm-filename=${candidate.filename}\n`);
