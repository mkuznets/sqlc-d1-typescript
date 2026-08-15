// Shared plumbing for the scripts a workflow step invokes directly: annotate the run
// with an ::error:: line and stop, read a --flag, and write step outputs.
import { appendFile } from "node:fs/promises";

export function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

export function flagValue(flag: string, fallback: string): string;
export function flagValue(flag: string, fallback?: string): string | undefined;
export function flagValue(flag: string, fallback?: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
}

export async function writeStepOutputs(outputs: Record<string, string>): Promise<void> {
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (!githubOutput) fail("GITHUB_OUTPUT is not set; this script only runs inside a GitHub Actions step");
  await appendFile(
    githubOutput,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
