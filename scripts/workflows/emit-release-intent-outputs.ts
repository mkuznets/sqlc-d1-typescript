#!/usr/bin/env node
// Publish the release identity that `release-contract.ts intent` validated as step
// outputs, so downstream jobs reconstruct it instead of re-deriving it from the event.
//
// Usage: emit-release-intent-outputs.ts [--intent intent.json]
// Outputs: version, tag, source-commit, workflow-url
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, fail, flagValue, writeStepOutputs } from "./step.ts";
import type { ReleaseIntent } from "../release-contract.ts";

const intentPath = resolve(flagValue("--intent", "intent.json"));
console.log(`==> Reading the validated release intent from ${intentPath}`);

let intent: ReleaseIntent;
try {
  intent = JSON.parse(await readFile(intentPath, "utf8")) as ReleaseIntent;
} catch (error) {
  fail(
    `cannot read the validated intent at ${intentPath}: ${describe(error)}; the intent validation step did not produce it`,
  );
}

for (const key of ["version", "sourceCommit", "workflowUrl"] as const)
  if (typeof intent[key] !== "string" || intent[key] === "")
    fail(`validated intent is missing ${key}; refusing to release without a complete identity`);

const outputs = {
  version: intent.version,
  tag: intent.tag ?? "",
  "source-commit": intent.sourceCommit,
  "workflow-url": intent.workflowUrl,
};

console.log(`==> This run releases tag ${intent.tag ?? "(none)"} as version ${intent.version}`);
for (const [key, value] of Object.entries(outputs)) console.log(`    ${key}=${value}`);

await writeStepOutputs(outputs);
console.log("==> Published the release identity as step outputs");
