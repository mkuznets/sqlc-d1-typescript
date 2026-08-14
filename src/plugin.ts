import {
  GenerationDiagnosticError,
  internalPluginFailure,
  renderFailureDiagnostics,
  renderWarningDiagnostics,
  type Diagnostic,
} from "./diagnostics";
import { GenerateRequest } from "./gen/plugin/codegen_pb";
import { generateValidated } from "./generator";
import { validateGenerateRequest } from "./validation";

export interface PluginRunResult {
  ok: boolean;
  stdout: Uint8Array;
  stderr: string;
}

export function runPlugin(input: Uint8Array): PluginRunResult {
  let request: GenerateRequest;
  try {
    request = GenerateRequest.fromBinary(input);
  } catch {
    return failure([
      {
        severity: "error",
        category: "PROTOCOL",
        reason: "MALFORMED_REQUEST",
        message: "Plugin input is not a valid sqlc GenerateRequest",
      },
    ]);
  }

  try {
    const validated = validateGenerateRequest(request);
    const response = generateValidated(validated);
    return {
      ok: true,
      stdout: response.toBinary(),
      stderr: renderWarningDiagnostics(validated.warnings),
    };
  } catch (error) {
    if (error instanceof GenerationDiagnosticError) return failure(error.diagnostics);
    return failure([internalPluginFailure(error)]);
  }
}

function failure(diagnostics: Diagnostic[]): PluginRunResult {
  return { ok: false, stdout: new Uint8Array(), stderr: renderFailureDiagnostics(diagnostics) };
}
