import { GenerateRequest, GenerateResponse } from "../../src/gen/plugin/codegen_pb.ts";

export interface GeneratorOutcome {
  response?: GenerateResponse;
  stdout: Uint8Array;
  diagnostics: string;
  exitCode: number;
}

export interface GeneratorHarness {
  run(request: GenerateRequest): Promise<GeneratorOutcome>;
  runBytes(input: Uint8Array): Promise<GeneratorOutcome>;
}
