#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readCandidate, parseArguments, runAsCli, usageError } from "./candidate-utils.ts";
import { fixtures, clearGeneratedDirectory } from "./check-generated-drift.ts";
import { generateCandidate } from "./generate-candidate.ts";

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

const normalizeVersion = (text: string): string | undefined => text.match(/v?(\d+\.\d+\.\d+)/)?.[1];

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
  const actual = normalizeVersion(await capture(sqlc, ["version"], root));
  if (actual !== sqlcVersion)
    throw usageError(
      `sqlc version mismatch: requested ${sqlcVersion}, executable reported ${actual ?? "an unparseable version"}`,
    );

  const cacheRoot = resolve(root, "node_modules/.cache");
  await mkdir(cacheRoot, { recursive: true });
  const mirror = await mkdtemp(resolve(cacheRoot, "sqlc-compatibility-"));
  try {
    for (const fixture of fixtures) {
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
      // Compile the emitted files and nothing else. The mirror has no node_modules,
      // so a hand-written source importing a dependency cannot resolve here — and
      // excluding those files is not enough, because `wrangler types` writes
      // `mainModule: typeof import("./src/index")` into worker-configuration.d.ts,
      // and a file reached through a reference cannot be excluded. Their real
      // type-check is `make test-example` and `make test-miniflare`, against
      // installed dependencies. D1 types come from compilerOptions.types above.
      tsconfig.include = [`${fixture.generatedDirectory}/**/*.ts`];
      tsconfig.exclude = fixture.staticFiles.map((file) => `${fixture.generatedDirectory}/${file}`);
      const matrixTsconfig = resolve(destination, ".matrix-tsconfig.json");
      await writeFile(matrixTsconfig, JSON.stringify(tsconfig));

      try {
        await run(
          process.execPath,
          [resolve(root, "node_modules/typescript/bin/tsc"), "-p", matrixTsconfig, "--noEmit"],
          destination,
        );
      } catch (error) {
        throw new Error(`${sqlcVersion} compile failed for ${fixture.directory} with TypeScript: ${describe(error)}`);
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
