import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function readCandidate(candidate, sha256) {
  if (!candidate) throw usageError("--candidate is required");
  if (!sha256) throw usageError("--sha256 is required");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw usageError("SHA-256 must be exactly 64 lowercase hexadecimal characters");
  const candidatePath = resolve(candidate);
  let bytes;
  try {
    bytes = await readFile(candidatePath);
  } catch {
    throw usageError(`candidate is not readable: ${candidatePath}`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) throw usageError(`candidate SHA-256 mismatch: expected ${sha256}, received ${actual}`);
  return { bytes, path: candidatePath, sha256 };
}

export async function validateCandidate(candidate, sha256) {
  return (await readCandidate(candidate, sha256)).path;
}

export function parseArguments(argv, required, allowed = required) {
  const values = {};
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

export function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}
