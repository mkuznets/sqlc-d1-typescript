import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface Candidate {
  bytes: Buffer;
  path: string;
  sha256: string;
}

export class UsageError extends Error {
  exitCode = 2;
}

export function usageError(message: string): UsageError {
  return new UsageError(message);
}

export async function readCandidate(candidate: string | undefined, sha256: string | undefined): Promise<Candidate> {
  if (!candidate) throw usageError("--candidate is required");
  if (!sha256) throw usageError("--sha256 is required");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw usageError("SHA-256 must be exactly 64 lowercase hexadecimal characters");
  const candidatePath = resolve(candidate);
  let bytes: Buffer;
  try {
    bytes = await readFile(candidatePath);
  } catch {
    throw usageError(`candidate is not readable: ${candidatePath}`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) throw usageError(`candidate SHA-256 mismatch: expected ${sha256}, received ${actual}`);
  return { bytes, path: candidatePath, sha256 };
}

export async function validateCandidate(candidate: string, sha256: string): Promise<string> {
  return (await readCandidate(candidate, sha256)).path;
}

export function parseArguments(
  argv: readonly string[],
  required: readonly string[],
  allowed: readonly string[] = required,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw usageError(`invalid argument ${key ?? ""}`.trim());
    const name = key.slice(2);
    if (!allowed.includes(name)) throw usageError(`unknown argument --${name}`);
    values[name] = value;
  }
  for (const key of required) if (!values[key]) throw usageError(`--${key} is required`);
  return values;
}

// Every CLI in scripts/ ends the same way: run when invoked directly, print the
// message and exit with the error's code when it throws. Inside Actions the message
// becomes an ::error:: annotation so it shows on the run summary without opening logs.
export function runAsCli(entryUrl: string, main: () => Promise<unknown>): void {
  if (!process.argv[1] || entryUrl !== pathToFileURL(resolve(process.argv[1])).href) return;
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(process.env.GITHUB_ACTIONS ? `::error::${message.replace(/\r?\n/g, "%0A")}` : message);
    process.exitCode = error instanceof UsageError ? error.exitCode : 1;
  });
}
