#!/usr/bin/env node
// Publish the release identity that `release-contract.mjs intent` validated as step
// outputs, so downstream jobs reconstruct it instead of re-deriving it from the event.
//
// Usage: emit-release-intent-outputs.mjs [--intent intent.json]
// Outputs: version, tag, source-commit, dry-run, workflow-url
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const intentIndex = argv.indexOf("--intent");
const intentPath = resolve(intentIndex === -1 ? "intent.json" : (argv[intentIndex + 1] ?? ""));

console.log(`==> Reading the validated release intent from ${intentPath}`);

let intent;
try {
  intent = JSON.parse(await readFile(intentPath, "utf8"));
} catch (error) {
  fail(
    `cannot read the validated intent at ${intentPath}: ${error instanceof Error ? error.message : error}; the intent validation step did not produce it`,
  );
}

for (const key of ["version", "sourceCommit", "workflowUrl"])
  if (typeof intent[key] !== "string" || intent[key] === "")
    fail(`validated intent is missing ${key}; refusing to release without a complete identity`);
if (typeof intent.dryRun !== "boolean") fail("validated intent is missing the dryRun flag");

const outputs = {
  version: intent.version,
  tag: intent.tag ?? "",
  "source-commit": intent.sourceCommit,
  "dry-run": String(intent.dryRun),
  "workflow-url": intent.workflowUrl,
};

console.log(
  intent.dryRun
    ? "==> This run is a NON-PUBLISHING dry run"
    : `==> This run releases tag ${intent.tag ?? "(none)"} as version ${intent.version}`,
);
for (const [key, value] of Object.entries(outputs)) console.log(`    ${key}=${value}`);

const githubOutput = process.env.GITHUB_OUTPUT;
if (!githubOutput) fail("GITHUB_OUTPUT is not set; this script only runs inside a GitHub Actions step");
await appendFile(
  githubOutput,
  Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join(""),
);
console.log("==> Published the release identity as step outputs");
