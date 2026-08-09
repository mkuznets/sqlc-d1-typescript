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
import { compileGeneratedResponse } from "./compile";

export type GeneratorScenarioInput =
  | { kind: "request"; request: GenerateRequest }
  | { kind: "bytes"; bytes: Uint8Array };

export interface GeneratorScenario {
  id: string;
  createInput(): GeneratorScenarioInput;
  assert(outcome: GeneratorOutcome): void | Promise<void>;
  run?(harness: GeneratorHarness): Promise<void>;
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
    assert.equal(outcome.response.files.length, 3);
    assert.deepEqual(outcome.response.files.map((file) => file.name), ["runtime.ts", "audit_sql.ts", "queries_sql.ts"]);
    const actual = new TextDecoder().decode(outcome.response.files[2].contents);
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
    assert.deepEqual(outcome.response?.files.map((file) => file.name), ["runtime.ts", "one_sql.ts", "two_sql.ts"]);
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

const emissionReadiness: GeneratorScenario = {
  id: "generator/emission-readiness",
  createInput: () => queryInput(validRequest({ queries: [
    new Query({ filename: "queries.sql", name: "DeleteUsers", cmd: ":execrows", text: "DELETE FROM users", columns: [column("id", "integer")] }),
  ] })),
  assert(outcome) {
    assertFailure(outcome);
    assert.match(outcome.diagnostics, /\[EMISSION\/UNIMPLEMENTED_COMMAND\]/);
    assert.doesNotMatch(outcome.diagnostics, /\[QUERY\/UNSUPPORTED_COMMAND\]/);
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

export function createSafeEmissionRequest(): GenerateRequest {
  const hostileSql = "SELECT '\"\\\\` ${notSource}' AS user_id\r\n-- \0\u2028\u2029";
  const repeated = column("default", "text");
  return validRequest({ queries: [
    new Query({ filename: "z.root.sql", name: "GetURL", cmd: ":one", text: hostileSql, params: [parameter(1, repeated), parameter(1, repeated), parameter(2, column("", "text"))], columns: [column("user_id", "text"), column("userID", "text"), column("USER_ID", "text"), column("", "text")] }),
    new Query({ filename: "admin/a.b.sql", name: "CreateItem", cmd: ":one", text: "INSERT RETURNING", columns: [column("default", "text")], insertIntoTable: new Identifier({ name: "items" }) }),
    new Query({ filename: "admin/a.b.sql", name: "ListItems", cmd: ":many", text: "SELECT", columns: [column("created_at_2", "text")] }),
    new Query({ filename: "deep/audit.log.sql", name: "ClearLog", cmd: ":exec", text: "DELETE" }),
  ] });
}

const safeEmission: GeneratorScenario = {
  id: "generator/safe-emission",
  createInput: () => queryInput(createSafeEmissionRequest()),
  async assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.equal(outcome.diagnostics, "");
    assert.ok(outcome.response);
    assert.deepEqual(outcome.response.files.map((file) => file.name), ["runtime.ts", "admin/a_b_sql.ts", "deep/audit_log_sql.ts", "z_root_sql.ts"]);
    const sources = new Map(outcome.response.files.map((file) => [file.name, new TextDecoder().decode(file.contents)]));
    assert.match(sources.get("admin/a_b_sql.ts")!, /from "\.\.\/runtime"/);
    assert.match(sources.get("deep/audit_log_sql.ts")!, /from "\.\.\/runtime"/);
    assert.match(sources.get("z_root_sql.ts")!, /import type \{ OneQuery \} from "\.\/runtime"/);
    assert.match(sources.get("z_root_sql.ts")!, /"userId_2"/);
    assert.match(sources.get("z_root_sql.ts")!, /"userId_3"/);
    assert.match(sources.get("z_root_sql.ts")!, /args\["default"\]/);
    assert.match(sources.get("z_root_sql.ts")!, /args\["column3"\]/);
    assert.match(sources.get("z_root_sql.ts")!, /"column4": string/);
    const sqlLiteral = /const getURLQuery = (.*);/.exec(sources.get("z_root_sql.ts")!)?.[1];
    assert.ok(sqlLiteral);
    assert.equal(JSON.parse(sqlLiteral), createSafeEmissionRequest().queries[0].text);
    assert.match(sqlLiteral, /\\u2028/);
    assert.match(sqlLiteral, /\\u2029/);
    assert.doesNotMatch(sources.get("z_root_sql.ts")!, /-- name:/);
    assert.doesNotMatch(sources.get("z_root_sql.ts")!, /class QueryExecutor/);
    compileGeneratedResponse(outcome.response);
  },
};

const typescriptFloor: GeneratorScenario = {
  id: "generator/typescript-floor",
  createInput: () => queryInput(createSafeEmissionRequest()),
  assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.ok(outcome.response);
    compileGeneratedResponse(outcome.response);
  },
};

export function createEmissionDiagnosticsRequest(): GenerateRequest {
  return validRequest({ sqlcVersion: "v1.32.0", queries: [
    new Query({ filename: "a.b", name: "Class", cmd: ":exec", text: "DELETE" }),
    new Query({ filename: "a_b", name: "URLValue", cmd: ":exec", text: "DELETE" }),
    new Query({ filename: "a_b", name: "UrlValue", cmd: ":exec", text: "DELETE" }),
    new Query({ filename: "Foo.sql", name: "GoodOne", cmd: ":exec", text: "DELETE" }),
    new Query({ filename: "foo.sql", name: "GoodTwo", cmd: ":exec", text: "DELETE" }),
    new Query({ filename: "../bad.sql", name: "Bad-Name", cmd: ":one", text: "SELECT", params: [parameter(1, column("bad-name", "text"))], columns: [column("also-bad", "text")] }),
    new Query({ filename: "/absolute.sql", name: "AbsolutePath", cmd: ":exec", text: "DELETE" }),
    new Query({ filename: "bad\\path.sql", name: "BackslashPath", cmd: ":exec", text: "DELETE" }),
    new Query({ filename: "CON.sql", name: "DevicePath", cmd: ":exec", text: "DELETE" }),
    new Query({ filename: "runtime", name: "RuntimeOwner", cmd: ":exec", text: "DELETE" }),
  ] });
}

const expectedEmissionDiagnostics = String.raw`sqlc-d1-typescript: generation failed with 13 errors and 1 warning

Errors:
[EMISSION/INVALID_OUTPUT_PATH] file "../bad.sql", field "filename":
source filename "../bad.sql" is not a safe portable relative path

[EMISSION/INVALID_QUERY_NAME] file "../bad.sql", query "Bad-Name", field "name":
query name "Bad-Name" must match "^[A-Z][A-Za-z0-9]*$"

[EMISSION/INVALID_FIELD_NAME] file "../bad.sql", query "Bad-Name", field "columns[0].name", position 1:
result name "also-bad" must match "^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$"; add a safe ASCII SQL alias

[EMISSION/INVALID_FIELD_NAME] file "../bad.sql", query "Bad-Name", field "params[0].column.name", position 1:
argument name "bad-name" must match "^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$"

[EMISSION/INVALID_OUTPUT_PATH] file "/absolute.sql", field "filename":
source filename "/absolute.sql" is not a safe portable relative path

[EMISSION/INVALID_OUTPUT_PATH] file "CON.sql", field "filename":
source filename "CON.sql" is not a safe portable relative path

[EMISSION/RESERVED_DECLARATION] file "a.b", query "Class", field "name":
query "Class" derives reserved factory binding "class"

[EMISSION/OUTPUT_PATH_COLLISION] file "a_b", field "filename":
source files "a.b" and "a_b" both derive output path "a_b.ts"

[EMISSION/DECLARATION_COLLISION] file "a_b", query "UrlValue", field "name":
factory for query "URLValue" and factory for query "UrlValue" both derive module binding "urlValue"; rename a query

[EMISSION/DECLARATION_COLLISION] file "a_b", query "UrlValue", field "name":
SQL constant for query "URLValue" and SQL constant for query "UrlValue" both derive module binding "urlValueQuery"; rename a query

[EMISSION/INVALID_OUTPUT_PATH] file "bad\\path.sql", field "filename":
source filename "bad\\path.sql" is not a safe portable relative path

[EMISSION/PORTABLE_OUTPUT_PATH_COLLISION] file "foo.sql", field "filename":
source files "Foo.sql" and "foo.sql" derive paths "Foo_sql.ts" and "foo_sql.ts", which collide on case-insensitive filesystems

[EMISSION/OUTPUT_PATH_COLLISION] file "runtime", field "filename":
source files "generated runtime" and "runtime" both derive output path "runtime.ts"

Warnings:
[COMPATIBILITY/UNTESTED_SQLC_VERSION]
sqlc "v1.32.0" is newer than the tested ceiling v1.31.1; generation will continue
`;

const emissionDiagnostics: GeneratorScenario = {
  id: "generator/emission-diagnostics",
  createInput: () => queryInput(createEmissionDiagnosticsRequest()),
  assert(outcome) {
    assertFailure(outcome);
    assert.equal(outcome.diagnostics, expectedEmissionDiagnostics);
    assert.doesNotMatch(outcome.diagnostics, /SELECT|DELETE/);
  },
};

const emissionDeterminism: GeneratorScenario = {
  id: "generator/emission-determinism",
  createInput: () => queryInput(createSafeEmissionRequest()),
  assert() {},
  async run(harness) {
    const first = await harness.run(createSafeEmissionRequest());
    const second = await harness.run(createSafeEmissionRequest());
    assert.equal(first.exitCode, 0, first.diagnostics);
    assert.deepEqual(first.stdout, second.stdout);
    const failing = emissionDiagnostics.createInput();
    assert.equal(failing.kind, "request");
    const failureOne = await harness.run(failing.request);
    const permuted = GenerateRequest.fromBinary(failing.request.toBinary());
    permuted.queries.reverse();
    const failureTwo = await harness.run(permuted);
    assert.equal(failureOne.diagnostics, failureTwo.diagnostics);
    assert.equal(failureOne.stdout.length, 0);
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
  emissionReadiness,
  diagnosticAggregation,
  safeEmission,
  typescriptFloor,
  emissionDiagnostics,
  emissionDeterminism,
  noQueryRuntime,
];

export async function runScenario(harness: GeneratorHarness, scenario: GeneratorScenario): Promise<void> {
  if (scenario.run) return scenario.run(harness);
  const input = scenario.createInput();
  await scenario.assert(await (input.kind === "request" ? harness.run(input.request) : harness.runBytes(input.bytes)));
}

function assertFailure(outcome: GeneratorOutcome): void {
  assert.notEqual(outcome.exitCode, 0);
  assert.equal(outcome.response, undefined);
  assert.equal(outcome.stdout.length, 0);
}

function assertNoStack(diagnostics: string): void {
  assert.doesNotMatch(diagnostics, /function\.mjs|\sat\s|Error:|stack/);
}
