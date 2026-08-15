#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArguments, readCandidate, runAsCli, UsageError } from "./candidate-utils.ts";

export interface GenerateCandidateOptions {
  candidate: string;
  config: string;
  cwd: string;
  sqlc?: string;
}

export async function generateCandidate({
  candidate,
  config,
  cwd,
  sqlc = "sqlc",
}: GenerateCandidateOptions): Promise<void> {
  const retained = await readCandidate(candidate);
  const workingDirectory = resolve(cwd);
  const configPath = resolve(workingDirectory, config);
  const source = await readFile(configPath, "utf8");
  const temporaryConfig = resolve(dirname(configPath), `.${basename(configPath)}.candidate-${randomUUID()}.yaml`);

  let primaryError: unknown;
  try {
    // sqlc checks the configured sha256 against the wasm it loads, so the generated
    // config carries the digest of the exact bytes this run is testing.
    const sha256 = createHash("sha256").update(retained.bytes).digest("hex");
    const wasmUrl = pathToFileURL(retained.path).href;
    let replaced = source.replace(/(^\s*url:\s*)\S+/m, (_match, prefix: string) => `${prefix}${wasmUrl}`);
    if (replaced === source) throw new Error(`config has no Plugin WASM URL: ${configPath}`);
    replaced = /^\s*sha256:\s*\S+/m.test(replaced)
      ? replaced.replace(/(^\s*sha256:\s*)\S+/m, (_match, prefix: string) => `${prefix}${sha256}`)
      : replaced.replace(/^(\s*url:\s*\S+)$/m, (_match, line: string) => `${line}\n      sha256: ${sha256}`);
    await writeFile(temporaryConfig, replaced, { mode: 0o600 });
    await run(sqlc, ["-f", temporaryConfig, "generate"], workingDirectory);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    await rm(temporaryConfig, { force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError || cleanupErrors.length)
    throw combinedError(primaryError, cleanupErrors, "candidate generation cleanup failed");
}

export function combinedError(primary: unknown, cleanupErrors: readonly unknown[], cleanupLabel: string): Error {
  const parts: string[] = [];
  if (primary) parts.push(primary instanceof Error ? primary.message : String(primary));
  for (const error of cleanupErrors)
    parts.push(`${cleanupLabel}: ${error instanceof Error ? error.message : String(error)}`);
  const combined = new Error(parts.join("\n"));
  if (primary instanceof UsageError) (combined as UsageError).exitCode = primary.exitCode;
  return combined;
}

function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${signal ?? code}`)),
    );
  });
}

runAsCli(import.meta.url, async () => {
  const args = parseArguments(
    process.argv.slice(2),
    ["candidate", "config", "cwd"],
    ["candidate", "config", "cwd", "sqlc"],
  );
  await generateCandidate(args as unknown as GenerateCandidateOptions);
});
