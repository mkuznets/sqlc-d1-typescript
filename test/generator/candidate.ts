import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASI } from "node:wasi";
import { GenerateRequest, GenerateResponse } from "../../src/gen/plugin/codegen_pb.ts";
import type { GeneratorHarness, GeneratorOutcome } from "./harness.ts";

export type CandidateSource = { path: string } | { bytes: Uint8Array };

export async function createCandidateHarness(source: CandidateSource): Promise<GeneratorHarness> {
  const retainedBytes = Uint8Array.from("path" in source ? readFileSync(source.path) : source.bytes);
  const module = new WebAssembly.Module(retainedBytes);
  return {
    async run(request: GenerateRequest): Promise<GeneratorOutcome> {
      return runCandidate(module, request.toBinary());
    },
    async runBytes(input: Uint8Array): Promise<GeneratorOutcome> {
      return runCandidate(module, input);
    },
  };
}

async function runCandidate(module: WebAssembly.Module, input: Uint8Array): Promise<GeneratorOutcome> {
  const directory = mkdtempSync(join(tmpdir(), "sqlc-d1-candidate-"));
  const stdinPath = join(directory, "stdin");
  const stdoutPath = join(directory, "stdout");
  const stderrPath = join(directory, "stderr");
  const descriptors: number[] = [];

  try {
    writeFileSync(stdinPath, input);
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
    const stdoutBytes = Uint8Array.from(readFileSync(stdoutPath));
    if (exitCode !== 0) {
      return { stdout: stdoutBytes, diagnostics: diagnostics || errorMessage(executionError), exitCode };
    }

    try {
      return {
        response: GenerateResponse.fromBinary(stdoutBytes),
        stdout: stdoutBytes,
        diagnostics,
        exitCode: 0,
      };
    } catch (error) {
      return {
        stdout: stdoutBytes,
        diagnostics: diagnostics || `invalid candidate response: ${errorMessage(error)}`,
        exitCode: 1,
      };
    }
  } catch (error) {
    return {
      stdout: readBytesIfPresent(stdoutPath),
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

function readBytesIfPresent(path: string): Uint8Array {
  try {
    return Uint8Array.from(readFileSync(path));
  } catch {
    return new Uint8Array();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "candidate execution failed");
}
