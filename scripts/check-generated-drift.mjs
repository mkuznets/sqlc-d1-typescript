#!/usr/bin/env node
import { chmod, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArguments, readCandidate, usageError } from "./candidate-utils.mjs";
import { combinedError, generateCandidate } from "./generate-candidate.mjs";

export const fixtures = [
  { directory: "test/miniflare", config: "sqlc.yaml", generatedDirectory: "src", staticFiles: ["index.ts"] },
  { directory: "examples/d1-worker", config: "sqlc.yaml", generatedDirectory: "src", staticFiles: ["index.ts"] },
];

export async function compareGeneratedTrees(expectedDirectory, actualDirectory, staticFiles = []) {
  const ignored = new Set(staticFiles);
  const expected = (await listFiles(expectedDirectory)).filter((path) => !ignored.has(path));
  const actual = (await listFiles(actualDirectory)).filter((path) => !ignored.has(path));
  const differences = [];
  for (const path of expected.filter((path) => !actual.includes(path))) differences.push({ kind: "deleted", path });
  for (const path of actual.filter((path) => !expected.includes(path))) differences.push({ kind: "added", path });
  for (const path of expected.filter((path) => actual.includes(path))) {
    const left = await readFile(resolve(expectedDirectory, path));
    const right = await readFile(resolve(actualDirectory, path));
    if (!left.equals(right)) differences.push({ kind: "changed", path });
  }
  return differences;
}

export async function clearGeneratedDirectory(directory, staticFiles = []) {
  const preserved = new Set(staticFiles);
  for (const path of await listFiles(directory)) if (!preserved.has(path)) await rm(resolve(directory, path), { force: true });
}

export async function checkGeneratedDrift({ candidate, sha256, root = process.cwd(), mode = "mirror" }) {
  if (!(["mirror", "worktree"].includes(mode))) throw usageError("--mode must be mirror or worktree");
  const retained = await readCandidate(candidate, sha256);
  const repository = resolve(root);
  return mode === "worktree"
    ? checkWorktree(retained, repository)
    : checkMirror(retained, repository);
}

async function checkMirror(retained, repository) {
  const mirror = await mkdtemp(resolve(tmpdir(), "sqlc-d1-generated-drift-"));
  let primaryError;
  try {
    const changed = [];
    for (const fixture of fixtures) {
      const source = resolve(repository, fixture.directory);
      const copy = resolve(mirror, fixture.directory);
      await cp(source, copy, { recursive: true, filter: (path) => !path.includes("node_modules") && !path.includes(".wrangler") });
      await clearGeneratedDirectory(resolve(copy, fixture.generatedDirectory), fixture.staticFiles);
      await withRetainedCandidate(retained, (candidate) => generateCandidate({ candidate, sha256: retained.sha256, config: fixture.config, cwd: copy }));
      const differences = await compareGeneratedTrees(resolve(source, fixture.generatedDirectory), resolve(copy, fixture.generatedDirectory), fixture.staticFiles);
      changed.push(...differences.map(({ kind, path }) => `${kind} ${fixture.directory}/${fixture.generatedDirectory}/${path}`));
    }
    if (changed.length) throw new Error(`generated drift:\n${changed.join("\n")}`);
  } catch (error) { primaryError = error; }
  const cleanupErrors = [];
  try { await rm(mirror, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (primaryError || cleanupErrors.length) throw combinedError(primaryError, cleanupErrors, "generated drift mirror cleanup failed");
}

async function checkWorktree(retained, repository) {
  const directory = await mkdtemp(resolve(tmpdir(), "sqlc-d1-clean-worktree-"));
  await rm(directory, { recursive: true, force: true });
  let added = false;
  let primaryError;
  try {
    await run("git", ["worktree", "add", "--detach", directory, "HEAD"], repository);
    added = true;
    for (const fixture of fixtures) {
      await clearGeneratedDirectory(resolve(directory, fixture.directory, fixture.generatedDirectory), fixture.staticFiles);
      await withRetainedCandidate(retained, (candidate) => generateCandidate({ candidate, sha256: retained.sha256, config: fixture.config, cwd: resolve(directory, fixture.directory) }));
    }
    const paths = fixtures.map(({ directory: path, generatedDirectory }) => `${path}/${generatedDirectory}`);
    const output = await capture("git", ["status", "--porcelain", "--untracked-files=all", "--", ...paths], directory);
    if (output.trim()) throw new Error(`generated drift in clean worktree:\n${output.trim()}`);
  } catch (error) { primaryError = error; }
  const cleanupErrors = [];
  if (added) try { await run("git", ["worktree", "remove", "--force", directory], repository); } catch (error) { cleanupErrors.push(error); }
  try { await rm(directory, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (primaryError || cleanupErrors.length) throw combinedError(primaryError, cleanupErrors, "generated drift worktree cleanup failed");
}

async function withRetainedCandidate(retained, callback) {
  const directory = await mkdtemp(resolve(tmpdir(), "sqlc-d1-retained-candidate-"));
  const candidate = resolve(directory, "plugin.wasm");
  let primaryError;
  try {
    await writeFile(candidate, retained.bytes, { mode: 0o400 });
    await chmod(candidate, 0o400);
    await callback(candidate);
  } catch (error) { primaryError = error; }
  const cleanupErrors = [];
  try { await rm(directory, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (primaryError || cleanupErrors.length) throw combinedError(primaryError, cleanupErrors, "retained candidate cleanup failed");
}

async function listFiles(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(relative(directory, path));
    }
  }
  try { await walk(directory); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return files.sort();
}
function run(command, args, cwd) { return new Promise((ok, fail) => { const child = spawn(command, args, { cwd, stdio: "inherit" }); child.on("error", fail); child.on("exit", (code) => code === 0 ? ok() : fail(new Error(`${command} exited ${code}`))); }); }
function capture(command, args, cwd) { return new Promise((ok, fail) => { const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk); child.on("error", fail); child.on("exit", (code) => code === 0 ? ok(stdout) : fail(new Error(stderr || `${command} exited ${code}`))); }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => {
    try {
      const args = parseArguments(process.argv.slice(2), ["candidate", "sha256"], ["candidate", "sha256", "mode"]);
      await checkGeneratedDrift(args);
    } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = error?.exitCode ?? 1; }
  })();
}
