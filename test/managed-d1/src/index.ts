import { createScenarioHandler } from "./protocol";
import { managedScenarios } from "./scenarios";

const handle = createScenarioHandler(managedScenarios);
export default { fetch: handle } satisfies ExportedHandler<{ DB: D1Database; SCENARIO_AUTH_TOKEN?: string }>;
