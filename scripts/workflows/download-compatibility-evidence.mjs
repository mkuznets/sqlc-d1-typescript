#!/usr/bin/env node
// Collect every sqlc compatibility evidence artifact produced by THIS run, by exact
// artifact ID, and write the list of extracted paths for the release contract to
// validate. Evidence from another run would attest a different candidate, so a
// missing cell is a hard failure rather than a skipped cell.
//
// Reads: MATRIX (JSON array of {version}), RUN_ID, REPOSITORY, GITHUB_TOKEN/GH_TOKEN
// Usage: download-compatibility-evidence.mjs [--directory evidence] [--output evidence-paths.json]
import { execFileSync } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { listRunArtifacts, selectExactRunArtifact } from "../github-run-artifacts.mjs";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
};

const directory = resolve(valueOf("--directory", "evidence"));
const outputPath = resolve(valueOf("--output", "evidence-paths.json"));
const { MATRIX, RUN_ID, REPOSITORY } = process.env;
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

if (!MATRIX) fail("MATRIX is empty; the intent job did not export the sqlc compatibility matrix");
if (!RUN_ID) fail("RUN_ID is empty; cannot restrict evidence to this workflow run");
if (!REPOSITORY) fail("REPOSITORY is empty; cannot look up run artifacts");
if (!token) fail("GITHUB_TOKEN/GH_TOKEN is empty; the artifact API cannot be queried");

let matrix;
try {
  matrix = JSON.parse(MATRIX);
} catch (error) {
  fail(`MATRIX is not valid JSON: ${error instanceof Error ? error.message : error}`);
}
if (!Array.isArray(matrix) || matrix.length === 0) fail("MATRIX contains no sqlc cells; there is nothing to attest");

const [owner, repo] = REPOSITORY.split("/");
mkdirSync(directory, { recursive: true });

console.log(`==> Collecting compatibility evidence for ${matrix.length} sqlc cell(s) from run ${RUN_ID}`);

const paths = [];
for (const { version } of matrix) {
  const name = `compatibility-evidence-${RUN_ID}-${version}`;
  console.log(`==> ${version}: locating artifact ${name}`);

  let selected;
  try {
    const artifacts = await listRunArtifacts({ owner, repo, runId: RUN_ID, name, token });
    selected = selectExactRunArtifact(artifacts, name, { allowCreate: false });
  } catch (error) {
    fail(
      `missing same-run evidence ${name}: ${error instanceof Error ? error.message : error}; the sqlc-compatibility job for ${version} did not upload its evidence`,
    );
  }

  const zip = `${directory}/${version}.zip`;
  const extracted = `${directory}/${version}`;
  console.log(`    artifact id ${selected.artifactId}; downloading`);
  try {
    execFileSync("gh", ["api", `repos/${REPOSITORY}/actions/artifacts/${selected.artifactId}/zip`], {
      env: process.env,
      stdio: ["ignore", openSync(zip, "w"), "inherit"],
    });
    execFileSync("unzip", ["-q", zip, "-d", extracted]);
  } catch (error) {
    fail(
      `could not download or extract ${name} (artifact ${selected.artifactId}): ${error instanceof Error ? error.message : error}`,
    );
  }

  const evidencePath = `${extracted}/compatibility-evidence.json`;
  paths.push(evidencePath);
  console.log(`    extracted ${evidencePath}`);
}

writeFileSync(outputPath, `${JSON.stringify(paths)}\n`);
console.log(`==> Wrote ${paths.length} evidence path(s) to ${outputPath}`);
