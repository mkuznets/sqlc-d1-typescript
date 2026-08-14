#!/usr/bin/env node
// Rebuild intent.json in a downstream job from the outputs the `intent` job already
// validated. Jobs never re-derive the release identity from the event payload: they
// reconstruct exactly what was validated once, so a mismatch cannot slip in later.
//
// Reads: RELEASE_VERSION, RELEASE_TAG, RELEASE_SOURCE_COMMIT, RELEASE_DEFAULT_BRANCH,
//        RELEASE_DRY_RUN, RELEASE_RUN_ID, RELEASE_WORKFLOW_URL
// Writes: intent.json (path overridable with --output)
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const outputIndex = argv.indexOf("--output");
const outputPath = resolve(outputIndex === -1 ? "intent.json" : (argv[outputIndex + 1] ?? ""));

const env = process.env;
for (const key of [
  "RELEASE_VERSION",
  "RELEASE_SOURCE_COMMIT",
  "RELEASE_DEFAULT_BRANCH",
  "RELEASE_DRY_RUN",
  "RELEASE_RUN_ID",
  "RELEASE_WORKFLOW_URL",
])
  if (!env[key]) fail(`${key} is empty; the intent job did not export the validated release identity`);

if (!/^\d+\.\d+\.\d+/.test(env.RELEASE_VERSION))
  fail(`RELEASE_VERSION ${JSON.stringify(env.RELEASE_VERSION)} is not a strict SemVer identity`);
if (!/^[0-9a-f]{40}$/.test(env.RELEASE_SOURCE_COMMIT))
  fail(`RELEASE_SOURCE_COMMIT ${JSON.stringify(env.RELEASE_SOURCE_COMMIT)} is not a full commit SHA`);
if (env.RELEASE_DRY_RUN !== "true" && env.RELEASE_DRY_RUN !== "false")
  fail(`RELEASE_DRY_RUN must be exactly "true" or "false", received ${JSON.stringify(env.RELEASE_DRY_RUN)}`);

const intent = {
  version: env.RELEASE_VERSION,
  tag: env.RELEASE_TAG || null,
  sourceCommit: env.RELEASE_SOURCE_COMMIT,
  defaultBranch: env.RELEASE_DEFAULT_BRANCH,
  dryRun: env.RELEASE_DRY_RUN === "true",
  workflowRunId: env.RELEASE_RUN_ID,
  workflowUrl: env.RELEASE_WORKFLOW_URL,
};

await writeFile(outputPath, JSON.stringify(intent));
console.log(`==> Reconstructed the validated release intent at ${outputPath}`);
console.log(`    version ${intent.version} tag ${intent.tag ?? "(none)"} dryRun ${intent.dryRun}`);
console.log(`    source commit ${intent.sourceCommit} on ${intent.defaultBranch}`);
