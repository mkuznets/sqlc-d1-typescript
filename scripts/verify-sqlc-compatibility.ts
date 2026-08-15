#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readCandidate, parseArguments, runAsCli, usageError } from "./candidate-utils.ts";
import { fixtures, clearGeneratedDirectory, type Fixture } from "./check-generated-drift.ts";
import { generateCandidate } from "./generate-candidate.ts";
import { loadCompatibilityConfig } from "./compatibility-config.ts";

function capture(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise<string>((ok, fail) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data: Buffer) => (stdout += data));
    child.stderr.on("data", (data: Buffer) => (stderr += data));
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? ok(stdout.trim()) : fail(new Error(`${command} exited ${code}: ${stderr.trim()}`)),
    );
  });
}

function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise<void>((ok, fail) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${command} exited ${code}`))));
  });
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const floorFixture: Fixture = {
  directory: "test/sqlc-v1-18",
  config: "sqlc.yaml",
  generatedDirectory: "src",
  staticFiles: [],
};

// sqlc v1.18.0 cannot parse the current fixture syntax, so the floor cell runs its own
// corpus. Every other sample runs the fixtures the repository actually ships.
export function fixturesForSqlcVersion(version: string): readonly Fixture[] {
  return version === "v1.18.0" ? [floorFixture] : fixtures;
}

const normalizeVersion = (text: string): string | undefined => {
  const match = text.match(/v?(\d+\.\d+\.\d+)/);
  return match ? `v${match[1]}` : undefined;
};

export async function verifySqlcCompatibility({
  candidate,
  sqlcVersion,
  sqlc,
  root = process.cwd(),
}: {
  candidate: string;
  sqlcVersion: string;
  sqlc: string;
  root?: string;
}): Promise<void> {
  const retained = await readCandidate(candidate);
  const config = await loadCompatibilityConfig({ root });
  if (!config.sqlc.samples.some(({ version }) => version === sqlcVersion))
    throw usageError(`sqlc version ${sqlcVersion} is not listed in compatibility.sqlc.samples`);
  const actual = normalizeVersion(await capture(sqlc, ["version"], root));
  if (actual !== sqlcVersion)
    throw usageError(
      `sqlc version mismatch: requested ${sqlcVersion}, executable reported ${actual ?? "an unparseable version"}`,
    );

  const cacheRoot = resolve(root, "node_modules/.cache");
  await mkdir(cacheRoot, { recursive: true });
  const mirror = await mkdtemp(resolve(cacheRoot, "sqlc-compatibility-"));
  try {
    for (const fixture of fixturesForSqlcVersion(sqlcVersion)) {
      const destination = resolve(mirror, fixture.directory);
      await cp(resolve(root, fixture.directory), destination, {
        recursive: true,
        filter: (path) => !path.includes("node_modules") && !path.includes(".wrangler"),
      });
      await clearGeneratedDirectory(resolve(destination, fixture.generatedDirectory), fixture.staticFiles);
      try {
        await generateCandidate({ candidate: retained.path, config: fixture.config, cwd: destination, sqlc });
      } catch (error) {
        throw new Error(`${sqlcVersion} generation failed for ${fixture.directory}: ${describe(error)}`);
      }

      const tsconfig = JSON.parse(await readFile(resolve(destination, "tsconfig.json"), "utf8")) as any;
      tsconfig.compilerOptions.types = [resolve(root, "node_modules/@cloudflare/workers-types")];
      tsconfig.exclude = ["test", "vitest.config.ts"];
      const matrixTsconfig = resolve(destination, ".matrix-tsconfig.json");
      await writeFile(matrixTsconfig, JSON.stringify(tsconfig));

      try {
        await run(
          process.execPath,
          [resolve(root, "node_modules/typescript/bin/tsc"), "-p", matrixTsconfig, "--noEmit"],
          destination,
        );
      } catch (error) {
        throw new Error(
          `${sqlcVersion} compile failed for ${fixture.directory} with TypeScript ${config.typescript.current}: ${describe(error)}`,
        );
      }
    }
  } finally {
    await rm(mirror, { recursive: true, force: true });
  }
}

runAsCli(import.meta.url, async () => {
  const args = parseArguments(process.argv.slice(2), ["candidate", "sqlc-version", "sqlc"]);
  await verifySqlcCompatibility({
    candidate: args.candidate,
    sqlcVersion: args["sqlc-version"],
    sqlc: args.sqlc,
  });
});
