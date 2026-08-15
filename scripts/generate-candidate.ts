#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArguments, readCandidate, runAsCli, UsageError } from "./candidate-utils.ts";

export interface GenerateCandidateOptions {
  candidate: string;
  sha256: string;
  config: string;
  cwd: string;
  sqlc?: string;
}

export async function generateCandidate({
  candidate,
  sha256,
  config,
  cwd,
  sqlc = "sqlc",
}: GenerateCandidateOptions): Promise<void> {
  const retained = await readCandidate(candidate, sha256);
  const workingDirectory = resolve(cwd);
  const configPath = resolve(workingDirectory, config);
  const source = await readFile(configPath, "utf8");
  const token = randomUUID();
  const temporaryConfig = resolve(dirname(configPath), `.${basename(configPath)}.candidate-${token}.yaml`);
  const temporaryCandidate = resolve(dirname(configPath), `.plugin.candidate-${token}.wasm`);

  let primaryError: unknown;
  try {
    await writeFile(temporaryCandidate, retained.bytes, { mode: 0o400 });
    await chmod(temporaryCandidate, 0o400);
    const wasmUrl = pathToFileURL(temporaryCandidate).href;
    let replaced = source.replace(/(^\s*url:\s*)\S+/m, (_match, prefix: string) => `${prefix}${wasmUrl}`);
    if (replaced === source) throw new Error(`config has no Plugin WASM URL: ${configPath}`);
    if (/^\s*sha256:\s*\S+/m.test(replaced))
      replaced = replaced.replace(/(^\s*sha256:\s*)\S+/m, `$1${retained.sha256}`);
    else replaced = replaced.replace(/^(\s*url:\s*\S+)$/m, `$1\n      sha256: ${retained.sha256}`);
    await writeFile(temporaryConfig, replaced, { mode: 0o600 });
    await run(sqlc, ["-f", temporaryConfig, "generate"], workingDirectory);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const path of [temporaryConfig, temporaryCandidate]) {
    try {
      await rm(path, { force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
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
  const args = parseArguments(process.argv.slice(2), ["candidate", "sha256", "config", "cwd"]);
  await generateCandidate(args as unknown as GenerateCandidateOptions);
});
