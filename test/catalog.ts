import { generatorScenarios } from "./generator/scenarios";
import { typeCatalog } from "./types/catalog";

export type CoverageLayer =
  "generator" | "types" | "miniflare" | "example" | "candidate" | "verification" | "managed-d1";

export interface CatalogTest {
  id: string;
  layer: CoverageLayer;
  file: string;
  title: string;
  availability: "local" | "deferred";
}

const entry = (
  id: string,
  layer: CoverageLayer,
  file: string,
  title = id,
  availability: "local" | "deferred" = "local",
): CatalogTest => ({ id, layer, file, title, availability });

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
  entry("verification/managed-workflow-security", "verification", "test/verification-contracts.test.ts"),
  entry("verification/compatibility-config", "verification", "test/compatibility-scripts.test.ts"),
  entry("verification/compatibility-mutations", "verification", "test/compatibility-scripts.test.ts"),
  entry("verification/upstream-comparison", "verification", "test/compatibility-scripts.test.ts"),
  entry("verification/ci-security-contract", "verification", "test/compatibility-scripts.test.ts"),
  entry("verification/sqlc-matrix", "verification", "test/compatibility-scripts.test.ts"),
  entry("verification/generate-candidate-digest", "verification", "test/candidate-scripts.test.ts"),
  entry("verification/generated-tree-comparison", "verification", "test/candidate-scripts.test.ts"),
  entry("verification/generate-candidate-retained", "verification", "test/candidate-scripts.test.ts"),
  entry("verification/generated-drift", "verification", "scripts/check-generated-drift.mjs"),
  entry("verification/agent-guidance", "verification", "test/agents-guidance.test.ts"),
  entry("verification/consumer-skill", "verification", "test/consumer-skill.test.ts"),
  entry("verification/publication-workflow-security", "verification", "test/verification-contracts.test.ts"),

  ...[
    "publication-object-contract",
    "publication-release-body",
    "publication-record-contract",
    "publication-object-command",
    "publication-preflight",
    "publication-order",
    "publication-retry",
    "publication-conflict",
    "publication-download-verification",
    "publication-recovery",
    "publication-dry-run",
  ].map((id) => entry(`verification/${id}`, "verification", "test/publication-scripts.test.ts")),

  ...[
    [
      "commands.spec.ts",
      [
        "command-execrows",
        "command-execlastid",
        "command-execresult",
        "command-one-returning",
        "command-empty-results",
        "command-many-returning",
        "command-all-batch",
      ],
    ],
    [
      "arguments.spec.ts",
      [
        "argument-arg",
        "argument-narg",
        "argument-slice",
        "argument-bind-order",
        "argument-empty-slice",
        "argument-slice-commands",
        "interaction-slice-batch",
        "argument-hostile-values",
      ],
    ],
    [
      "embeds.spec.ts",
      [
        "embed-reconstruction",
        "embed-outer-join",
        "interaction-slice-embed",
        "interaction-embed-batch",
        "embed-private-aliases",
      ],
    ],
    [
      "values.spec.ts",
      [
        "conversion-round-trip",
        "conversion-physical-values",
        "error-argument",
        "error-result",
        "interaction-post-write-mapping",
        "error-batch-mapping",
        "error-native-identity",
      ],
    ],
    [
      "batches-sessions.spec.ts",
      [
        "batch-empty",
        "batch-native-rollback",
        "batch-post-success-mapping",
        "session-starts",
        "session-bookmark-transfer",
        "session-bookmark-after-failure",
      ],
    ],
  ].flatMap(([file, ids]) =>
    (ids as string[]).map((id) => entry(`miniflare/${id}`, "miniflare", `test/miniflare/test/${file}`)),
  ),
  ...["list-users", "get-user", "rename-user", "error-boundary", "routing-statuses"].map((id) =>
    entry(`example/${id}`, "example", "examples/d1-worker/test/index.spec.ts"),
  ),
  ...[
    "value-command-metadata",
    "macro-smoke",
    "batch-success",
    "batch-rollback",
    "direct-session",
    "bookmark-transfer",
    "native-error-identity",
    "post-execution-result-error",
  ].map((id) => entry(`managed-d1/${id}`, "managed-d1", "test/managed-d1/src/scenarios.ts")),

  entry("verification/managed-name-contract", "verification", "test/managed-d1-contracts.test.ts"),
  entry("verification/managed-evidence-contract", "verification", "test/managed-d1-contracts.test.ts"),
  entry("verification/managed-protocol", "verification", "test/managed-d1-contracts.test.ts"),
  entry("verification/managed-protocol-safe-errors", "verification", "test/managed-d1-contracts.test.ts"),
  entry("verification/managed-reaper", "verification", "test/managed-d1-contracts.test.ts"),
  entry("verification/managed-reaper-exact-deletion", "verification", "test/managed-d1-contracts.test.ts"),
  entry("verification/managed-lifecycle-json", "verification", "test/managed-d1-contracts.test.ts"),

  ...[
    "managed-protocol-size",
    "managed-reaper-pagination",
    "managed-lifecycle-failures",
    "managed-lifecycle-attempts",
    "managed-lifecycle-signal",
    "managed-lifecycle-timeout",
    "managed-lifecycle-provision-races",
    "managed-lifecycle-diagnostics",
    "managed-command-output",
    "managed-route-propagation",
    "managed-secret-rollout",
  ].map((id) => entry(`verification/${id}`, "verification", "test/managed-d1-contracts.test.ts")),
];
