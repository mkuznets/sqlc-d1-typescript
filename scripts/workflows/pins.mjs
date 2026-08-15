#!/usr/bin/env node
// Publish the toolchain pins from verification/compatibility.json as step outputs, so
// no workflow hardcodes a version that is pinned there.
//
// Plain JavaScript on purpose: this runs before setup-node has pinned the runner's
// Node, so it cannot rely on TypeScript type stripping.
import { appendFileSync, readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("verification/compatibility.json", "utf8"));
const samples = config.sqlc.samples.map(({ version }) => ({ version, install: version.replace(/^v/, "") }));

const outputs = {
  node: config.tools.node,
  npm: config.tools.npm,
  bun: config.tools.bun,
  "sqlc-ceiling": config.sqlc.testedCeiling.replace(/^v/, ""),
  "sqlc-matrix": JSON.stringify(samples),
};

console.log("==> Toolchain pinned by verification/compatibility.json");
for (const [key, value] of Object.entries(outputs)) console.log(`    ${key}=${value}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
