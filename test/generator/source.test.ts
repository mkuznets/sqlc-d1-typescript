import test from "node:test";
import { GenerateRequest, GenerateResponse } from "../../src/gen/plugin/codegen_pb";
import { runPlugin } from "../../src/plugin";
import { GeneratorHarness } from "./harness";
import { generatorScenarios, runScenario } from "./scenarios";

const sourceHarness: GeneratorHarness = {
  async run(request: GenerateRequest) {
    return this.runBytes(request.toBinary());
  },
  async runBytes(input: Uint8Array) {
    const result = runPlugin(input);
    return {
      response: result.ok ? GenerateResponse.fromBinary(result.stdout) : undefined,
      stdout: result.stdout,
      diagnostics: result.stderr,
      exitCode: result.ok ? 0 : 1,
    };
  },
};

for (const scenario of generatorScenarios) {
  test(`source: ${scenario.id}`, () => runScenario(sourceHarness, scenario));
}
