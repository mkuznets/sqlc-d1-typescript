import { GenerateRequest, GenerateResponse } from "../../src/gen/plugin/codegen_pb";

export interface GeneratorOutcome {
  response?: GenerateResponse;
  stdout: Uint8Array;
  diagnostics: string;
  exitCode: number;
}

export interface GeneratorHarness {
  readonly candidateSha256?: string;
  run(request: GenerateRequest): Promise<GeneratorOutcome>;
  runBytes(input: Uint8Array): Promise<GeneratorOutcome>;
}
