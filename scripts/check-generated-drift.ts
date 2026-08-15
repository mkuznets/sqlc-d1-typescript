#!/usr/bin/env node
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { parseArguments, readCandidate, runAsCli } from "./candidate-utils.ts";
import { generateCandidate } from "./generate-candidate.ts";

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
    if (Buffer.compare(left, right) !== 0) differences.push({ kind: "changed", path });
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
  root?: string;
  sqlc?: string;
}

// Regenerates every fixture into a throwaway copy of the repository and diffs the
// result byte-for-byte against what is checked in. It needs no git and never touches
// the working tree.
export async function checkGeneratedDrift({
  candidate,
  root = process.cwd(),
  sqlc = "sqlc",
}: DriftOptions): Promise<void> {
  const retained = await readCandidate(candidate);
  const repository = resolve(root);
  const mirror = await mkdtemp(resolve(tmpdir(), "sqlc-d1-generated-drift-"));
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
      await generateCandidate({ candidate: retained.path, config: fixture.config, cwd: copy, sqlc });
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
  } finally {
    await rm(mirror, { recursive: true, force: true });
  }
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

runAsCli(import.meta.url, async () => {
  const args = parseArguments(process.argv.slice(2), ["candidate"], ["candidate", "sqlc"]);
  await checkGeneratedDrift(args as unknown as DriftOptions);
});
