#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readCandidate, parseArguments, usageError } from "./candidate-utils.mjs";
import { fixtures, clearGeneratedDirectory } from "./check-generated-drift.mjs";
import { generateCandidate, combinedError } from "./generate-candidate.mjs";
import { loadCompatibilityConfig } from "./compatibility-config.mjs";

function capture(command, args, cwd) { return new Promise((ok, fail) => { const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.on("data", (data) => stdout += data); child.stderr.on("data", (data) => stderr += data); child.on("error", fail); child.on("exit", (code) => code === 0 ? ok(stdout.trim()) : fail(new Error(`${command} exited ${code}: ${stderr.trim()}`))); }); }
function run(command, args, cwd) { return new Promise((ok, fail) => { const child = spawn(command, args, { cwd, stdio: "inherit" }); child.on("error", fail); child.on("exit", (code) => code === 0 ? ok() : fail(new Error(`${command} exited ${code}`))); }); }
const floorFixture = { directory: "test/sqlc-v1-18", config: "sqlc.yaml", generatedDirectory: "src", staticFiles: [] };
export function fixturesForSqlcVersion(version) { return version === "v1.18.0" ? [floorFixture] : fixtures; }
const normalizeVersion = (text) => { const match = text.match(/v?(\d+\.\d+\.\d+)/); return match ? `v${match[1]}` : undefined; };
export async function verifySqlcCompatibility({ candidate, sha256, sqlcVersion, sqlc, root = process.cwd() }) {
  const retained = await readCandidate(candidate, sha256);
  const config = await loadCompatibilityConfig({ root });
  if (!config.sqlc.samples.some(({ version }) => version === sqlcVersion)) throw usageError(`sqlc version ${sqlcVersion} is not listed in compatibility.sqlc.samples`);
  const actual = normalizeVersion(await capture(sqlc, ["version"], root));
  if (actual !== sqlcVersion) throw usageError(`sqlc version mismatch: requested ${sqlcVersion}, executable reported ${actual ?? "an unparseable version"}`);
  const selectedFixtures = fixturesForSqlcVersion(sqlcVersion);
  const cacheRoot = resolve(root, "node_modules/.cache"); await mkdir(cacheRoot, { recursive: true });
  const mirror = await mkdtemp(resolve(cacheRoot, "sqlc-compatibility-"));
  let primaryError;
  try {
    const retainedPath = resolve(mirror, "plugin.wasm"); await writeFile(retainedPath, retained.bytes, { mode: 0o400 });
    for (const fixture of selectedFixtures) {
      const destination = resolve(mirror, fixture.directory);
      await cp(resolve(root, fixture.directory), destination, { recursive: true, filter: (path) => !path.includes("node_modules") && !path.includes(".wrangler") });
      await clearGeneratedDirectory(resolve(destination, fixture.generatedDirectory), fixture.staticFiles);
      try { await generateCandidate({ candidate: retainedPath, sha256, config: fixture.config, cwd: destination, sqlc }); }
      catch (error) { throw new Error(`${sqlcVersion} generation failed for ${fixture.directory}: ${error.message}`); }
      const tsconfig = JSON.parse(await readFile(resolve(destination, "tsconfig.json"), "utf8"));
      tsconfig.compilerOptions.types = [resolve(root, "node_modules/@cloudflare/workers-types")];
      tsconfig.exclude = ["test", "vitest.config.ts"];
      const matrixTsconfig = resolve(destination, ".matrix-tsconfig.json"); await writeFile(matrixTsconfig, JSON.stringify(tsconfig));
      try { await run(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", matrixTsconfig, "--noEmit"], destination); }
      catch (error) { throw new Error(`${sqlcVersion} compile failed for ${fixture.directory} with TypeScript ${config.typescript.current}: ${error.message}`); }
    }
  } catch (error) { primaryError = error; }
  const cleanupErrors = []; try { await rm(mirror, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (primaryError || cleanupErrors.length) throw combinedError(primaryError, cleanupErrors, "sqlc compatibility cleanup failed");
  return { sqlcVersion: actual, fixtures: selectedFixtures.map(({ directory }) => directory), knownExceptions: config.sqlc.knownExceptions, typescriptVersion: config.typescript.current, candidateSha256: sha256, cleanup: "confirmed" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => { try {
    const args = parseArguments(process.argv.slice(2), ["candidate", "sha256", "sqlc-version", "sqlc"], ["candidate", "sha256", "sqlc-version", "sqlc", "output"]);
    const result = JSON.stringify(await verifySqlcCompatibility({ candidate: args.candidate, sha256: args.sha256, sqlcVersion: args["sqlc-version"], sqlc: args.sqlc }), null, 2);
    if (args.output) await writeFile(resolve(args.output), `${result}\n`, { mode: 0o600 });
    else console.log(result);
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = error?.exitCode ?? 1; } })();
}
