#!/usr/bin/env node
import { chmod, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { parseArguments, readCandidate, runAsCli, usageError, type Candidate } from "./candidate-utils.ts";
import { combinedError, generateCandidate } from "./generate-candidate.ts";

export interface Fixture {
  directory: string;
  config: string;
  generatedDirectory: string;
  staticFiles: string[];
}

export type DriftKind = "deleted" | "added" | "changed";
export interface Difference {
  kind: DriftKind;
  path: string;
}

export const fixtures: readonly Fixture[] = [
  { directory: "test/miniflare", config: "sqlc.yaml", generatedDirectory: "src", staticFiles: ["index.ts"] },
  { directory: "examples/d1-worker", config: "sqlc.yaml", generatedDirectory: "src", staticFiles: ["index.ts"] },
];

export async function compareGeneratedTrees(
  expectedDirectory: string,
  actualDirectory: string,
  staticFiles: readonly string[] = [],
): Promise<Difference[]> {
  const ignored = new Set(staticFiles);
  const expected = (await listFiles(expectedDirectory)).filter((path) => !ignored.has(path));
  const actual = (await listFiles(actualDirectory)).filter((path) => !ignored.has(path));
  const differences: Difference[] = [];
  for (const path of expected.filter((path) => !actual.includes(path))) differences.push({ kind: "deleted", path });
  for (const path of actual.filter((path) => !expected.includes(path))) differences.push({ kind: "added", path });
  for (const path of expected.filter((path) => actual.includes(path))) {
    const left = await readFile(resolve(expectedDirectory, path));
    const right = await readFile(resolve(actualDirectory, path));
    if (!left.equals(right)) differences.push({ kind: "changed", path });
  }
  return differences;
}

export async function clearGeneratedDirectory(directory: string, staticFiles: readonly string[] = []): Promise<void> {
  const preserved = new Set(staticFiles);
  for (const path of await listFiles(directory))
    if (!preserved.has(path)) await rm(resolve(directory, path), { force: true });
}

export interface DriftOptions {
  candidate: string;
  sha256: string;
  root?: string;
  mode?: string;
  sqlc?: string;
}

export async function checkGeneratedDrift({
  candidate,
  sha256,
  root = process.cwd(),
  mode = "mirror",
  sqlc = "sqlc",
}: DriftOptions): Promise<void> {
  if (!["mirror", "worktree"].includes(mode)) throw usageError("--mode must be mirror or worktree");
  const retained = await readCandidate(candidate, sha256);
  const repository = resolve(root);
  return mode === "worktree" ? checkWorktree(retained, repository, sqlc) : checkMirror(retained, repository, sqlc);
}

async function checkMirror(retained: Candidate, repository: string, sqlc: string): Promise<void> {
  const mirror = await mkdtemp(resolve(tmpdir(), "sqlc-d1-generated-drift-"));
  let primaryError: unknown;
  try {
    const changed: string[] = [];
    for (const fixture of fixtures) {
      const source = resolve(repository, fixture.directory);
      const copy = resolve(mirror, fixture.directory);
      await cp(source, copy, {
        recursive: true,
        filter: (path) => !path.includes("node_modules") && !path.includes(".wrangler"),
      });
      await clearGeneratedDirectory(resolve(copy, fixture.generatedDirectory), fixture.staticFiles);
      await withRetainedCandidate(retained, (candidate) =>
        generateCandidate({ candidate, sha256: retained.sha256, config: fixture.config, cwd: copy, sqlc }),
      );
      const differences = await compareGeneratedTrees(
        resolve(source, fixture.generatedDirectory),
        resolve(copy, fixture.generatedDirectory),
        fixture.staticFiles,
      );
      changed.push(
        ...differences.map(({ kind, path }) => `${kind} ${fixture.directory}/${fixture.generatedDirectory}/${path}`),
      );
    }
    if (changed.length) throw new Error(`generated drift:\n${changed.join("\n")}`);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    await rm(mirror, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError || cleanupErrors.length)
    throw combinedError(primaryError, cleanupErrors, "generated drift mirror cleanup failed");
}

async function checkWorktree(retained: Candidate, repository: string, sqlc: string): Promise<void> {
  const directory = await mkdtemp(resolve(tmpdir(), "sqlc-d1-clean-worktree-"));
  await rm(directory, { recursive: true, force: true });
  let added = false;
  let primaryError: unknown;
  try {
    await run("git", ["worktree", "add", "--detach", directory, "HEAD"], repository);
    added = true;
    for (const fixture of fixtures) {
      await clearGeneratedDirectory(
        resolve(directory, fixture.directory, fixture.generatedDirectory),
        fixture.staticFiles,
      );
      await withRetainedCandidate(retained, (candidate) =>
        generateCandidate({
          candidate,
          sha256: retained.sha256,
          config: fixture.config,
          cwd: resolve(directory, fixture.directory),
          sqlc,
        }),
      );
    }
    const paths = fixtures.map(({ directory: path, generatedDirectory }) => `${path}/${generatedDirectory}`);
    const output = await capture("git", ["status", "--porcelain", "--untracked-files=all", "--", ...paths], directory);
    if (output.trim()) throw new Error(`generated drift in clean worktree:\n${output.trim()}`);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  if (added)
    try {
      await run("git", ["worktree", "remove", "--force", directory], repository);
    } catch (error) {
      cleanupErrors.push(error);
    }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError || cleanupErrors.length)
    throw combinedError(primaryError, cleanupErrors, "generated drift worktree cleanup failed");
}

async function withRetainedCandidate(
  retained: Candidate,
  callback: (candidate: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(resolve(tmpdir(), "sqlc-d1-retained-candidate-"));
  const candidate = resolve(directory, "plugin.wasm");
  let primaryError: unknown;
  try {
    await writeFile(candidate, retained.bytes, { mode: 0o400 });
    await chmod(candidate, 0o400);
    await callback(candidate);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError || cleanupErrors.length)
    throw combinedError(primaryError, cleanupErrors, "retained candidate cleanup failed");
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(relative(directory, path));
    }
  }
  try {
    await walk(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  return files.sort();
}

function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise<void>((ok, fail) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${command} exited ${code}`))));
  });
}

function capture(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise<string>((ok, fail) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? ok(stdout) : fail(new Error(stderr || `${command} exited ${code}`))));
  });
}

runAsCli(import.meta.url, async () => {
  const args = parseArguments(process.argv.slice(2), ["candidate", "sha256"], ["candidate", "sha256", "mode"]);
  await checkGeneratedDrift(args as unknown as DriftOptions);
});
