import { createHash } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASI } from "node:wasi";
import { GenerateRequest, GenerateResponse } from "../../src/gen/plugin/codegen_pb";
import { GeneratorHarness, GeneratorOutcome } from "./harness";

export type CandidateSource = { path: string } | { bytes: Uint8Array };

export async function createCandidateHarness(
  source: CandidateSource,
  expectedSha256: string,
): Promise<GeneratorHarness> {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error("candidate SHA-256 must be exactly 64 lowercase hexadecimal characters");
  }

  const retainedBytes = Uint8Array.from(
    "path" in source ? readFileSync(source.path) : source.bytes,
  );
  const actualSha256 = createHash("sha256").update(retainedBytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`candidate SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }

  const module = new WebAssembly.Module(retainedBytes);
  return {
    candidateSha256: actualSha256,
    async run(request: GenerateRequest): Promise<GeneratorOutcome> {
      return runCandidate(module, request);
    },
  };
}

async function runCandidate(
  module: WebAssembly.Module,
  request: GenerateRequest,
): Promise<GeneratorOutcome> {
  const directory = mkdtempSync(join(tmpdir(), "sqlc-d1-candidate-"));
  const stdinPath = join(directory, "stdin");
  const stdoutPath = join(directory, "stdout");
  const stderrPath = join(directory, "stderr");
  const descriptors: number[] = [];

  try {
    writeFileSync(stdinPath, request.toBinary());
    const stdin = openSync(stdinPath, "r");
    descriptors.push(stdin);
    const stdout = openSync(stdoutPath, "w+");
    descriptors.push(stdout);
    const stderr = openSync(stderrPath, "w+");
    descriptors.push(stderr);

    let exitCode = 1;
    let executionError: unknown;
    try {
      const wasi = new WASI({
        version: "preview1",
        args: [],
        env: {},
        preopens: {},
        stdin,
        stdout,
        stderr,
        returnOnExit: true,
      });
      const instance = await WebAssembly.instantiate(module, {
        wasi_snapshot_preview1: wasi.wasiImport,
      });
      exitCode = wasi.start(instance as WebAssembly.Instance);
    } catch (error) {
      executionError = error;
    }

    closeDescriptors(descriptors);
    const diagnostics = readTextIfPresent(stderrPath);
    if (exitCode !== 0) {
      return { diagnostics: diagnostics || errorMessage(executionError), exitCode };
    }

    try {
      return {
        response: GenerateResponse.fromBinary(readFileSync(stdoutPath)),
        diagnostics,
        exitCode: 0,
      };
    } catch (error) {
      return {
        diagnostics: diagnostics || `invalid candidate response: ${errorMessage(error)}`,
        exitCode: 1,
      };
    }
  } catch (error) {
    return {
      diagnostics: readTextIfPresent(stderrPath) || errorMessage(error),
      exitCode: 1,
    };
  } finally {
    closeDescriptors(descriptors);
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; preserve the generation outcome.
    }
  }
}

function closeDescriptors(descriptors: number[]): void {
  for (const descriptor of descriptors.splice(0)) {
    try {
      closeSync(descriptor);
    } catch {
      // Best-effort cleanup; preserve the generation outcome.
    }
  }
}

function readTextIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "candidate execution failed");
}
