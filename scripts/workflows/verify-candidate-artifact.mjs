#!/usr/bin/env node
// Confirm that a retained run artifact still holds the exact wasm this run built,
// before any credentialed job spends real Cloudflare resources on it.
//
// Usage: verify-candidate-artifact.mjs --candidate retained/plugin.wasm --sha256 <64 hex>
import { readCandidate } from "../candidate-utils.mjs";

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

const candidate = valueOf("--candidate");
const sha256 = valueOf("--sha256");

console.log("==> Verifying the retained candidate artifact");
console.log(`    path:     ${candidate ?? "(missing --candidate)"}`);
console.log(`    expected: ${sha256 ?? "(missing --sha256)"}`);

try {
  const verified = await readCandidate(candidate, sha256);
  console.log(`==> Retained candidate matches the expected digest (${verified.bytes.length} bytes)`);
} catch (error) {
  console.error(
    `::error::retained candidate is unusable: ${error instanceof Error ? error.message : error}; the artifact was not produced by this run or was replaced`,
  );
  process.exit(error?.exitCode ?? 1);
}
