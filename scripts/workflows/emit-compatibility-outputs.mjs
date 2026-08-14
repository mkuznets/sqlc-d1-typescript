#!/usr/bin/env node
// Publish the authoritative toolchain pins from verification/compatibility.json as
// step outputs so every job installs exactly the versions the compatibility contract
// names. Nothing in the workflows may hardcode a version that is pinned here.
//
// Usage: emit-compatibility-outputs.mjs [--config verification/compatibility.json]
// Outputs: node, npm, bun, sqlc-ceiling-install, sqlc-matrix
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONFIG_FLAG = "--config";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const flagIndex = argv.indexOf(CONFIG_FLAG);
const configPath = resolve(flagIndex === -1 ? "verification/compatibility.json" : (argv[flagIndex + 1] ?? ""));

console.log(`==> Reading authoritative compatibility inputs from ${configPath}`);

let config;
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  fail(`cannot read the compatibility contract at ${configPath}: ${error instanceof Error ? error.message : error}`);
}

const tools = config.tools ?? {};
for (const key of ["node", "npm", "bun"])
  if (typeof tools[key] !== "string" || tools[key] === "")
    fail(`compatibility contract is missing tools.${key}; jobs cannot pin a toolchain without it`);

const ceiling = config.sqlc?.testedCeiling;
if (typeof ceiling !== "string" || !/^v\d+\.\d+\.\d+$/.test(ceiling))
  fail(`compatibility contract has an unusable sqlc.testedCeiling (${JSON.stringify(ceiling)})`);

const samples = config.sqlc?.samples;
if (!Array.isArray(samples) || samples.length === 0)
  fail("compatibility contract lists no sqlc.samples; the compatibility matrix would be empty");

const matrix = samples.map(({ version }) => {
  if (typeof version !== "string" || !/^v\d+\.\d+\.\d+$/.test(version))
    fail(`compatibility contract has an unusable sqlc sample version (${JSON.stringify(version)})`);
  return { version, install: version.replace(/^v/, "") };
});

const outputs = {
  node: tools.node,
  npm: tools.npm,
  bun: tools.bun,
  "sqlc-ceiling-install": ceiling.replace(/^v/, ""),
  "sqlc-matrix": JSON.stringify(matrix),
};

for (const [key, value] of Object.entries(outputs)) console.log(`    ${key}=${value}`);
console.log(`==> sqlc compatibility matrix has ${matrix.length} cell(s)`);

const githubOutput = process.env.GITHUB_OUTPUT;
if (!githubOutput) fail("GITHUB_OUTPUT is not set; this script only runs inside a GitHub Actions step");
await appendFile(
  githubOutput,
  Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join(""),
);
console.log("==> Published toolchain pins as step outputs");
