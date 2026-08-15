#!/usr/bin/env node
// Rebuild intent.json in a downstream job from the outputs the `intent` job already
// validated. Jobs never re-derive the release identity from the event payload: they
// reconstruct exactly what was validated once, so a mismatch cannot slip in later.
//
// Reads: RELEASE_VERSION, RELEASE_TAG, RELEASE_SOURCE_COMMIT, RELEASE_DEFAULT_BRANCH,
//        RELEASE_RUN_ID, RELEASE_WORKFLOW_URL
// Writes: intent.json (path overridable with --output)
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fail, flagValue } from "./step.ts";
import type { ReleaseIntent } from "../release-contract.ts";

const outputPath = resolve(flagValue("--output", "intent.json"));

const env = process.env;
for (const key of [
  "RELEASE_VERSION",
  "RELEASE_SOURCE_COMMIT",
  "RELEASE_DEFAULT_BRANCH",
  "RELEASE_RUN_ID",
  "RELEASE_WORKFLOW_URL",
])
  if (!env[key]) fail(`${key} is empty; the intent job did not export the validated release identity`);

const version = env.RELEASE_VERSION ?? "";
const sourceCommit = env.RELEASE_SOURCE_COMMIT ?? "";
if (!/^\d+\.\d+\.\d+/.test(version)) fail(`RELEASE_VERSION ${JSON.stringify(version)} is not a strict SemVer identity`);
if (!/^[0-9a-f]{40}$/.test(sourceCommit))
  fail(`RELEASE_SOURCE_COMMIT ${JSON.stringify(sourceCommit)} is not a full commit SHA`);

const intent: ReleaseIntent = {
  version,
  tag: env.RELEASE_TAG || null,
  sourceCommit,
  defaultBranch: env.RELEASE_DEFAULT_BRANCH ?? "",
  workflowRunId: env.RELEASE_RUN_ID ?? "",
  workflowUrl: env.RELEASE_WORKFLOW_URL ?? "",
};

await writeFile(outputPath, JSON.stringify(intent));
console.log(`==> Reconstructed the validated release intent at ${outputPath}`);
console.log(`    version ${intent.version} tag ${intent.tag ?? "(none)"}`);
console.log(`    source commit ${intent.sourceCommit} on ${intent.defaultBranch}`);
