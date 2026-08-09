import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Column,
  GenerateRequest,
  Identifier,
  Parameter,
  Query,
  Settings,
} from "../../src/gen/plugin/codegen_pb";
import { GeneratorHarness, GeneratorOutcome } from "./harness";

export type GeneratorScenarioInput =
  | { kind: "request"; request: GenerateRequest }
  | { kind: "bytes"; bytes: Uint8Array };

export interface GeneratorScenario {
  id: string;
  createInput(): GeneratorScenarioInput;
  assert(outcome: GeneratorOutcome): void;
}

const encoder = new TextEncoder();
const options = encoder.encode('{"interface":"workers"}');
const type = (name: string) => new Identifier({ name });
const column = (name: string, typeName: string, notNull = true) =>
  new Column({ name, type: type(typeName), notNull });
const parameter = (number: number, value: Column) => new Parameter({ number, column: value });
const queryInput = (request: GenerateRequest): GeneratorScenarioInput => ({ kind: "request", request });

function validRequest(data: Partial<GenerateRequest> = {}): GenerateRequest {
  return new GenerateRequest({
    settings: new Settings({ engine: "sqlite" }),
    sqlcVersion: "v1.31.1",
    pluginOptions: options,
    ...data,
  });
}

export function createCurrentCommandsRequest(): GenerateRequest {
  const name = column("name", "text");
  const id = column("id", "integer");
  return validRequest({
    queries: [
      new Query({ filename: "queries.sql", name: "UpdateName", cmd: ":exec", text: "UPDATE users SET name = ? WHERE id = ?;", params: [parameter(1, name), parameter(2, id)] }),
      new Query({ filename: "queries.sql", name: "GetUser", cmd: ":one", text: "SELECT id, nickname FROM users LIMIT 1;", columns: [id, column("nickname", "text", false)] }),
      new Query({ filename: "queries.sql", name: "CreateUser", cmd: ":one", text: "INSERT INTO users (name) VALUES (?) RETURNING id;", params: [parameter(1, name)], columns: [id], insertIntoTable: new Identifier({ name: "users" }) }),
      new Query({ filename: "queries.sql", name: "ListUsers", cmd: ":many", text: "SELECT id, name FROM users;", columns: [id, name] }),
      new Query({ filename: "audit.sql", name: "ClearAuditLog", cmd: ":exec", text: "DELETE FROM audit_log;" }),
    ],
  });
}

const currentCommands: GeneratorScenario = {
  id: "generator/current-commands",
  createInput: () => queryInput(createCurrentCommandsRequest()),
  assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.equal(outcome.diagnostics, "");
    assert.ok(outcome.stdout.length > 0);
    assert.ok(outcome.response);
    assert.equal(outcome.response.files.length, 2);
    assert.deepEqual(outcome.response.files.map((file) => file.name), ["queries_sql.ts", "audit_sql.ts"]);
    const actual = new TextDecoder().decode(outcome.response.files[0].contents);
    const expected = readFileSync(resolve(process.cwd(), "test/generator/goldens/current-output.ts.txt"), "utf8");
    assert.equal(actual, expected);
  },
};

const fileGrouping: GeneratorScenario = {
  id: "generator/file-grouping",
  createInput: () => queryInput(validRequest({ queries: [
    new Query({ filename: "one.sql", name: "First", cmd: ":exec", text: "DELETE FROM one;" }),
    new Query({ filename: "one.sql", name: "Second", cmd: ":exec", text: "DELETE FROM two;" }),
    new Query({ filename: "two.sql", name: "Third", cmd: ":exec", text: "DELETE FROM three;" }),
  ] })),
  assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.deepEqual(outcome.response?.files.map((file) => file.name), ["one_sql.ts", "two_sql.ts"]);
  },
};

const optionsBoundary: GeneratorScenario = {
  id: "generator/options-boundary",
  createInput: () => queryInput(validRequest({ pluginOptions: encoder.encode('{"interfaces":"workers"}') })),
  assert(outcome) {
    assertFailure(outcome);
    assert.match(outcome.diagnostics, /^sqlc-d1-typescript: generation failed with 1 error\n\nErrors:\n\[OPTIONS\/UNKNOWN_OPTION\]/);
    assert.doesNotMatch(outcome.diagnostics, /\{"interfaces"/);
  },
};

const protocolBoundary: GeneratorScenario = {
  id: "generator/protocol-boundary",
  createInput: () => ({ kind: "bytes", bytes: new Uint8Array([0x0a, 0x05, 0x01]) }),
  assert(outcome) {
    assertFailure(outcome);
    assert.equal(outcome.diagnostics, `sqlc-d1-typescript: generation failed with 1 error

Errors:
[PROTOCOL/MALFORMED_REQUEST]
Plugin input is not a valid sqlc GenerateRequest
`);
    assertNoStack(outcome.diagnostics);
  },
};

const unknownProtobufField: GeneratorScenario = {
  id: "generator/unknown-protobuf-field",
  createInput() {
    const bytes = createCurrentCommandsRequest().toBinary();
    return { kind: "bytes", bytes: Uint8Array.from([...bytes, 0xa0, 0x06, 0x01]) };
  },
  assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.ok(outcome.response);
  },
};

const compatibility: GeneratorScenario = {
  id: "generator/sqlc-compatibility",
  createInput: () => queryInput(validRequest({ sqlcVersion: "v1.32.0" })),
  assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.ok(outcome.response);
    assert.ok(outcome.stdout.length > 0);
    assert.equal(outcome.diagnostics, `sqlc-d1-typescript: generation completed with 1 warning

Warnings:
[COMPATIBILITY/UNTESTED_SQLC_VERSION]
sqlc "v1.32.0" is newer than the tested ceiling v1.31.1; generation will continue
`);
  },
};

const queryBoundary: GeneratorScenario = {
  id: "generator/query-boundary",
  createInput: () => queryInput(validRequest({ queries: [
    new Query({ filename: "queries.sql", name: "Unsupported", cmd: ":copyfrom", text: "COPY secret" }),
    new Query({ filename: "queries.sql", name: "Duplicate", cmd: ":many", text: "SELECT secret", columns: [column("id", "integer"), column("id", "integer")] }),
  ] })),
  assert(outcome) {
    assertFailure(outcome);
    assert.match(outcome.diagnostics, /\[QUERY\/UNSUPPORTED_COMMAND\]/);
    assert.match(outcome.diagnostics, /\[QUERY\/DUPLICATE_PHYSICAL_COLUMN\]/);
    assert.doesNotMatch(outcome.diagnostics, /COPY secret|SELECT secret/);
  },
};

const diagnosticAggregation: GeneratorScenario = {
  id: "generator/diagnostic-aggregation",
  createInput: () => queryInput(validRequest({
    pluginOptions: encoder.encode("{"),
    sqlcVersion: "v1.32.0",
    queries: [
      new Query({ filename: "z.sql", name: "Zed", cmd: ":one", text: "SELECT z" }),
      new Query({ filename: "a.sql", name: "Alpha", cmd: ":future", text: "SELECT a" }),
    ],
  })),
  assert(outcome) {
    assertFailure(outcome);
    assert.match(outcome.diagnostics, /generation failed with 3 errors and 1 warning/);
    const identifiers = ["[OPTIONS/MALFORMED_JSON]", "[QUERY/UNSUPPORTED_COMMAND]", "[QUERY/MISSING_RESULT_COLUMNS]", "[COMPATIBILITY/UNTESTED_SQLC_VERSION]"];
    let position = -1;
    for (const identifier of identifiers) {
      const next = outcome.diagnostics.indexOf(identifier);
      assert.ok(next > position, `${identifier} has the wrong order`);
      position = next;
    }
  },
};

const noQueryRuntime: GeneratorScenario = {
  id: "generator/no-query-runtime",
  createInput: () => queryInput(validRequest({ pluginOptions: new Uint8Array() })),
  assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.deepEqual(outcome.response?.files.map((file) => file.name), ["runtime.ts"]);
    const runtimeSource = readFileSync(resolve(process.cwd(), "src/runtime.d1.ts"), "utf8");
    const expected = runtimeSource.split("// --- RUNTIME BEGIN ---")[1].split("// --- RUNTIME END ---")[0].slice(1, -1);
    assert.equal(new TextDecoder().decode(outcome.response?.files[0].contents), expected);
  },
};

export const generatorScenarios = [
  currentCommands,
  fileGrouping,
  optionsBoundary,
  protocolBoundary,
  unknownProtobufField,
  compatibility,
  queryBoundary,
  diagnosticAggregation,
  noQueryRuntime,
];

export async function runScenario(harness: GeneratorHarness, scenario: GeneratorScenario): Promise<void> {
  const input = scenario.createInput();
  scenario.assert(await (input.kind === "request" ? harness.run(input.request) : harness.runBytes(input.bytes)));
}

function assertFailure(outcome: GeneratorOutcome): void {
  assert.notEqual(outcome.exitCode, 0);
  assert.equal(outcome.response, undefined);
  assert.equal(outcome.stdout.length, 0);
}

function assertNoStack(diagnostics: string): void {
  assert.doesNotMatch(diagnostics, /function\.mjs|\sat\s|Error:|stack/);
}
