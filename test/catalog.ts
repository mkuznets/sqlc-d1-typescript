import { generatorScenarios } from "./generator/scenarios";
import { typeCatalog } from "./types/catalog";

export type CoverageLayer = "generator" | "types" | "miniflare" | "example" | "candidate" | "verification" | "managed-d1";
export interface CatalogTest {
  id: string;
  layer: CoverageLayer;
  file: string;
  title: string;
  availability: "local" | "deferred";
}
const entry = (id: string, layer: CoverageLayer, file: string, title = id, availability: "local" | "deferred" = "local"): CatalogTest => ({ id, layer, file, title, availability });

export const candidateScenarioIds = generatorScenarios.map(({ id }) => `candidate/${id.slice("generator/".length)}`);

export const executableCatalog: readonly CatalogTest[] = [
  ...generatorScenarios.map(({ id }) => entry(id, "generator", "test/generator/scenarios.ts")),
  ...typeCatalog,
  ...candidateScenarioIds.map((id) => entry(id, "candidate", "test/generator/candidate.test.ts")),
  entry("candidate/digest-validation", "candidate", "test/generator/candidate.test.ts"),
  entry("candidate/retained-bytes", "candidate", "test/generator/candidate.test.ts"),
  entry("verification/coverage-graph", "verification", "test/verification-contracts.test.ts"),
  entry("verification/coverage-mutations", "verification", "test/verification-contracts.test.ts"),
  entry("verification/surface-inventory", "verification", "test/verification-contracts.test.ts"),
  entry("verification/evidence-envelope", "verification", "test/verification-contracts.test.ts"),
  entry("verification/generate-candidate-digest", "verification", "test/candidate-scripts.test.ts"),
  entry("verification/generated-tree-comparison", "verification", "test/candidate-scripts.test.ts"),
  entry("verification/generate-candidate-retained", "verification", "test/candidate-scripts.test.ts"),
  entry("verification/generated-drift", "verification", "scripts/check-generated-drift.mjs"),
  ...[
    ["commands.spec.ts", ["command-execrows", "command-execlastid", "command-execresult", "command-one-returning", "command-empty-results", "command-many-returning", "command-all-batch"]],
    ["arguments.spec.ts", ["argument-arg", "argument-narg", "argument-slice", "argument-bind-order", "argument-empty-slice", "argument-slice-commands", "interaction-slice-batch", "argument-hostile-values"]],
    ["embeds.spec.ts", ["embed-reconstruction", "embed-outer-join", "interaction-slice-embed", "interaction-embed-batch", "embed-private-aliases"]],
    ["values.spec.ts", ["conversion-round-trip", "conversion-physical-values", "error-argument", "error-result", "interaction-post-write-mapping", "error-batch-mapping", "error-native-identity"]],
    ["batches-sessions.spec.ts", ["batch-empty", "batch-native-rollback", "batch-post-success-mapping", "session-starts", "session-bookmark-transfer", "session-bookmark-after-failure"]],
  ].flatMap(([file, ids]) => (ids as string[]).map((id) => entry(`miniflare/${id}`, "miniflare", `test/miniflare/test/${file}`))),
  ...["list-users", "get-user", "rename-user", "error-boundary", "routing-statuses"].map((id) => entry(`example/${id}`, "example", "examples/d1-worker/test/index.spec.ts")),
  entry("managed-d1/batch-rollback", "managed-d1", "test/managed-d1/batch.spec.ts", undefined, "deferred"),
  entry("managed-d1/bookmark-transfer", "managed-d1", "test/managed-d1/session.spec.ts", undefined, "deferred"),
];
