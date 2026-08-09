import test from "node:test";
import { GenerateRequest } from "../../src/gen/plugin/codegen_pb";
import { generate } from "../../src/generator";
import { GeneratorHarness } from "./harness";
import { generatorScenarios, runScenario } from "./scenarios";

const sourceHarness: GeneratorHarness = {
  async run(request: GenerateRequest) {
    try {
      return { response: generate(request), diagnostics: "", exitCode: 0 };
    } catch (error) {
      return {
        diagnostics: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    }
  },
};

for (const scenario of generatorScenarios) {
  test(`source: ${scenario.id}`, () => runScenario(sourceHarness, scenario));
}
