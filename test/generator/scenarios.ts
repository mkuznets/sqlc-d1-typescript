import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
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
import { FakeExecutor, loadGeneratedModules } from "./evaluate";

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

const publicApiConsumer = `import {
  DB,
  type QueryExecutor,
  SessionExecutor,
  type QueryDescriptor,
  type D1NonNullValue,
  type D1Value,
  type JsonValue,
  SqlcD1Error,
  type SqlcD1ErrorContext,
  QueryArgumentError,
  QueryUsageError,
  QueryResultError,
} from "./runtime";
import {
  createUser,
  getUser,
  listUsers,
  updateName,
  type CreateUserRow,
  type GetUserRow,
  type ListUsersRow,
} from "./queries_sql";
// @ts-expect-error command-specific descriptor variants are not public
import type { OneQuery } from "./runtime";
// @ts-expect-error command-specific descriptor variants are not public
import type { OneInsertQuery } from "./runtime";
// @ts-expect-error command-specific descriptor variants are not public
import type { ManyQuery } from "./runtime";
// @ts-expect-error command-specific descriptor variants are not public
import type { ExecQuery } from "./runtime";
// @ts-expect-error SQL constants are module-private
import { getUserQuery } from "./queries_sql";
// @ts-expect-error row parsers are module-private
import { parseGetUserRow } from "./queries_sql";

declare const binding: D1Database;
const db = new DB(binding);
const descriptor = getUser();
const direct: Promise<GetUserRow | null> = db.execute(descriptor);
const session = db.withSession("opaque-bookmark");
const throughSession: Promise<GetUserRow | null> = session.execute(descriptor);
const bookmark: string | null = session.getBookmark();
const executor: QueryExecutor = session;
void [direct, throughSession, bookmark, executor];
const mixedResult: Promise<[
  GetUserRow | null,
  CreateUserRow | null,
  ListUsersRow[],
  void,
]> = db.batch(
  getUser(),
  createUser({ name: "Ada" }),
  listUsers(),
  updateName({ name: "Ada", id: 1 }),
);
void mixedResult;
// @ts-expect-error descriptor representation is opaque
void descriptor.sql;
// @ts-expect-error the hidden brand prevents structural construction
const forged: QueryDescriptor<GetUserRow | null> = {};
void forged;
// @ts-expect-error SessionExecutor is abstract and cannot be directly constructed
new SessionExecutor();
class ExternalSessionExecutor extends SessionExecutor {
  public constructor(sessionBinding: D1DatabaseSession) {
    // @ts-expect-error external subclasses cannot supply the module-private capability
    super(sessionBinding);
  }
  getBookmark(): string | null { return null; }
}
void ExternalSessionExecutor;
const nonNullValues: D1NonNullValue[] = [true, 1, "text", new Uint8Array()];
const nullableValue: D1Value = null;
const json: JsonValue = { values: [null, true, 1, "text"] };
void [nonNullValues, nullableValue, json];
const argumentContext: SqlcD1ErrorContext = {
  operation: "construct",
  queryName: "GetUser",
  path: "id",
  expected: "safe integer",
  received: "non-integer number",
};
const errors: SqlcD1Error[] = [
  new QueryArgumentError("bad argument", argumentContext),
  new QueryUsageError("bad usage", { operation: "batch", batchIndex: 0 }),
  new QueryResultError("bad row", { operation: "execute", queryName: "GetUser", rowIndex: 0, cause: new SyntaxError("x") }),
];
const operation: "construct" | "execute" | "batch" | "withSession" = errors[0].operation;
const queryName: string | undefined = errors[0].queryName;
const batchIndex: number | undefined = errors[1].batchIndex;
const rowIndex: number | undefined = errors[2].rowIndex;
const path: string | undefined = errors[0].path;
const expected: string | undefined = errors[0].expected;
const received: string | undefined = errors[0].received;
const cause: unknown = errors[2].cause;
void [errors, operation, queryName, batchIndex, rowIndex, path, expected, received, cause];
// @ts-expect-error post-execution failures make no commit-state claim
void errors[2].effectsMayHaveCommitted;
`;

const currentCommands: GeneratorScenario = {
  id: "generator/current-commands",
  createInput: () => queryInput(createCurrentCommandsRequest()),
  assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.equal(outcome.diagnostics, "");
    assert.ok(outcome.stdout.length > 0);
    assert.ok(outcome.response);
    const response = outcome.response;
    assert.equal(response.files.length, 3);
    assert.deepEqual(response.files.map((file) => file.name), ["runtime.ts", "audit_sql.ts", "queries_sql.ts"]);
    const actual = new TextDecoder().decode(response.files[2].contents);
    const expected = readFileSync(resolve(process.cwd(), "test/generator/goldens/current-output.ts.txt"), "utf8");
    assert.equal(actual, expected);
    assert.match(actual, /params: Object\.freeze\(\[\]\)/);
    assert.doesNotMatch(actual, /OneQuery|OneInsertQuery|ManyQuery|ExecQuery/);
    const runtime = new TextDecoder().decode(response.files[0].contents);
    assert.match(runtime, /export class QueryArgumentError extends SqlcD1Error/);
    assert.match(runtime, /export class QueryUsageError extends SqlcD1Error/);
    assert.match(runtime, /export class QueryResultError extends SqlcD1Error/);
    assert.match(runtime, /export interface SqlcD1ErrorContext/);
    assert.doesNotMatch(runtime, /effectsMayHaveCommitted|mayHaveCommitted|commitState|retrySafe|retryable/i);
    assert.doesNotMatch(runtime, /export interface (?:OneQuery|OneInsertQuery|ManyQuery|ExecQuery)/);
    const runtimeJavaScript = ts.transpileModule(runtime, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const runtimeExports: Record<string, unknown> = {};
    new Function("exports", "module", runtimeJavaScript)(runtimeExports, { exports: runtimeExports });
    const sessionExecutor = runtimeExports.SessionExecutor as abstract new (...args: unknown[]) => unknown;
    assert.throws(
      () => Reflect.construct(sessionExecutor, [{}, Symbol("wrong capability")]),
      { name: "TypeError", message: "SessionExecutor must be created by DB.withSession" },
    );
    for (const compiler of ["typescript-5-2", "typescript"] as const) {
      compileGeneratedResponse(response, {
        compiler,
        additionalFiles: { "consumer.ts": publicApiConsumer },
      });
    }
    for (const unsafePath of ["../consumer.ts", "/consumer.ts", "tsconfig.json", "queries_sql.ts"]) {
      assert.throws(() => compileGeneratedResponse(response, {
        additionalFiles: { [unsafePath]: "" },
      }));
    }
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
    assert.match(sources.get("z_root_sql.ts")!, /import type \{ QueryDescriptor \} from "\.\/runtime"/);
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
    const nestedConsumer = `import { DB, type QueryDescriptor } from "../runtime";
import { createItem, listItems, type CreateItemRow, type ListItemsRow } from "./a_b_sql";
declare const binding: D1Database;
const db = new DB(binding);
const one: Promise<CreateItemRow | null> = db.execute(createItem());
const many: Promise<ListItemsRow[]> = db.execute(listItems());
const descriptor: QueryDescriptor<CreateItemRow | null> = createItem();
void [one, many, descriptor];
`;
    for (const compiler of ["typescript-5-2", "typescript"] as const) {
      compileGeneratedResponse(outcome.response, {
        compiler,
        additionalFiles: { "admin/consumer.ts": nestedConsumer },
      });
    }
  },
};

const typescriptFloor: GeneratorScenario = {
  id: "generator/typescript-floor",
  createInput: () => queryInput(createSafeEmissionRequest()),
  assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.ok(outcome.response);
    compileGeneratedResponse(outcome.response, { compiler: "typescript-5-2" });
    compileGeneratedResponse(outcome.response, { compiler: "typescript" });
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
    assert.ok(outcome.response);
    const consumer = `import { DB, SessionExecutor, type D1Value, QueryResultError } from "./runtime";
declare const binding: D1Database;
const db = new DB(binding);
const session: SessionExecutor = db.withSession();
const value: D1Value = null;
const error: Error = new QueryResultError("bad row", { operation: "execute", queryName: "GetUser", rowIndex: 0 });
void [session, value, error];
`;
    for (const compiler of ["typescript-5-2", "typescript"] as const) {
      compileGeneratedResponse(outcome.response, {
        compiler,
        additionalFiles: { "consumer.ts": consumer },
      });
    }
  },
};

// One column per value kind in both nullabilities, spelled with the case, parameter,
// and whitespace variety the declared-type normalizer has to absorb.
const VALUE_COLUMNS: readonly (readonly [string, string, boolean])[] = [
  ["int_value", "INTEGER", true],
  ["int_null", "UNSIGNED BIG INT", false],
  ["num_value", "DECIMAL(10,2)", true],
  ["num_null", "Real", false],
  ["text_value", "VARCHAR(255)", true],
  ["text_null", "text", false],
  ["bool_value", "BOOLEAN", true],
  ["bool_null", "bool", false],
  ["blob_value", "BLOB", true],
  ["blob_null", "blob", false],
  ["json_value", "JSON", true],
  ["json_null", "JSONB", false],
  ["any_value", "ULID", true],
  ["any_null", "any", false],
];

const valueColumns = () => VALUE_COLUMNS.map(([name, typeName, notNull]) => column(name, typeName, notNull));

export function createCheckedValuesRequest(): GenerateRequest {
  const valueParameters = () => valueColumns().map((value, index) => parameter(index + 1, value));
  return validRequest({
    queries: [
      new Query({ filename: "values.sql", name: "CreateSample", cmd: ":one", text: "INSERT INTO samples VALUES (?) RETURNING *;", params: valueParameters(), columns: valueColumns(), insertIntoTable: new Identifier({ name: "samples" }) }),
      new Query({ filename: "values.sql", name: "GetSample", cmd: ":one", text: "SELECT * FROM samples WHERE int_value = ?;", params: [parameter(1, column("int_value", "INTEGER"))], columns: valueColumns() }),
      new Query({ filename: "values.sql", name: "ListSamples", cmd: ":many", text: "SELECT * FROM samples;", columns: valueColumns() }),
      new Query({ filename: "values.sql", name: "TouchSample", cmd: ":exec", text: "UPDATE samples SET int_value = ?;", params: valueParameters() }),
      new Query({ filename: "plain.sql", name: "ClearSamples", cmd: ":exec", text: "DELETE FROM samples;" }),
    ],
  });
}

const checkedValuesConsumer = `import { DB, type D1NonNullValue, type D1Value, type JsonValue } from "./runtime";
import {
  createSample,
  getSample,
  listSamples,
  touchSample,
  type CreateSampleArgs,
  type CreateSampleRow,
  type GetSampleRow,
  type ListSamplesRow,
} from "./values_sql";
import { clearSamples } from "./plain_sql";

const bytes = new Uint8Array([1, 2, 3]);
const complete: CreateSampleArgs = {
  intValue: 1,
  intNull: null,
  numValue: 1.5,
  numNull: 2.5,
  textValue: "text",
  textNull: null,
  boolValue: true,
  boolNull: null,
  blobValue: bytes,
  blobNull: null,
  jsonValue: { nested: [1, "two", null, true, { deep: 3 }] },
  jsonNull: null,
  anyValue: "opaque",
  anyNull: null,
};
declare const binding: D1Database;
const db = new DB(binding);
const inserted: Promise<CreateSampleRow | null> = db.execute(createSample(complete));
const read: Promise<GetSampleRow | null> = db.execute(getSample({ intValue: 1 }));
const listed: Promise<ListSamplesRow[]> = db.execute(listSamples());
const cleared: Promise<void> = db.execute(clearSamples());
void [inserted, read, listed, cleared, touchSample(complete)];

const nonNullValue: D1NonNullValue = complete.anyValue;
const nullableValue: D1Value = complete.anyNull;
const json: JsonValue = complete.jsonValue;
void [nonNullValue, nullableValue, json];

declare const row: GetSampleRow;
const intField: number = row.intValue;
const intNullField: number | null = row.intNull;
const numField: number = row.numValue;
const textField: string = row.textValue;
const textNullField: string | null = row.textNull;
const boolField: boolean = row.boolValue;
const blobField: Uint8Array = row.blobValue;
const blobNullField: Uint8Array | null = row.blobNull;
const jsonField: unknown = row.jsonValue;
const anyField: unknown = row.anyValue;
void [intField, intNullField, numField, textField, textNullField, boolField, blobField, blobNullField, jsonField, anyField];
// @ts-expect-error JSON result fields are unknown, never any
const jsonAsString: string = row.jsonValue;
// @ts-expect-error unrecognized declared types produce unknown result fields, never any
const anyAsString: string = row.anyValue;
void [jsonAsString, anyAsString];

const { intValue: _omitted, ...missingProperty } = complete;
// @ts-expect-error every argument property is required
createSample(missingProperty);
// @ts-expect-error undefined is not an accepted argument value
createSample({ ...complete, intValue: undefined });
// @ts-expect-error bigint is not an accepted argument value
createSample({ ...complete, intValue: 1n });
// @ts-expect-error Date is not an accepted argument value
createSample({ ...complete, textValue: new Date() });
// @ts-expect-error plain objects are not accepted for scalar arguments
createSample({ ...complete, intValue: {} });
// @ts-expect-error null is rejected for a non-null argument
createSample({ ...complete, intValue: null });
// @ts-expect-error a JSON argument does not accept a Date
createSample({ ...complete, jsonValue: new Date() });
// @ts-expect-error a BLOB argument accepts only Uint8Array
createSample({ ...complete, blobValue: new ArrayBuffer(3) });
// @ts-expect-error a non-null unknown-typed argument rejects null
createSample({ ...complete, anyValue: null });
createSample({ ...complete, anyNull: null });
createSample({ ...complete, jsonValue: null });
`;

const checkedValues: GeneratorScenario = {
  id: "generator/checked-values",
  createInput: () => queryInput(createCheckedValuesRequest()),
  assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.equal(outcome.diagnostics, "");
    assert.ok(outcome.response);
    const response = outcome.response;
    const sources = new Map(response.files.map((file) => [file.name, new TextDecoder().decode(file.contents)]));
    const values = sources.get("values_sql.ts")!;
    const plain = sources.get("plain_sql.ts")!;

    assert.match(values, /^import \{ generatedInternals as d1_values \} from "\.\/runtime";\nimport type \{ QueryDescriptor, D1NonNullValue, D1Value, JsonValue \} from "\.\/runtime";$/m);
    assert.match(values, /^type d1_Context = \{ readonly operation: "execute" \| "batch"; readonly queryName: string; readonly batchIndex\?: number \| undefined; readonly rowIndex\?: number \| undefined \};$/m);
    assert.match(values, /name: "CreateSample"/);
    assert.match(values, /d1_values\.requireArgs\(args, "CreateSample"\);/);

    for (const [kind, nullable] of [["Integer", "int"], ["Number", "num"], ["Text", "text"], ["Boolean", "bool"], ["Blob", "blob"], ["Json", "json"], ["Unknown", "any"]] as const) {
      const publicName = `${nullable}Value`;
      const nullName = `${nullable}Null`;
      assert.match(values, new RegExp(`d1_values\\.arg${kind}\\(args\\["${publicName}"\\], "CreateSample", "${publicName}"\\)`), publicName);
      assert.match(values, new RegExp(`d1_values\\.arg${kind}OrNull\\(args\\["${nullName}"\\], "CreateSample", "${nullName}"\\)`), nullName);
      assert.match(values, new RegExp(`d1_values\\.row${kind}\\(row, "${nullable}_value", "${publicName}", ctx\\)`), publicName);
      assert.match(values, new RegExp(`d1_values\\.row${kind}OrNull\\(row, "${nullable}_null", "${nullName}", ctx\\)`), nullName);
    }

    // Argument-less :exec modules stay free of the codec import and the context alias.
    assert.doesNotMatch(plain, /generatedInternals|d1_values|d1_Context/);
    assert.match(plain, /^import type \{ QueryDescriptor \} from "\.\/runtime";$/m);

    for (const source of [values, plain]) {
      assert.doesNotMatch(source, /\bany\b/);
      assert.doesNotMatch(source, /row\[[^\]]+\] as /);
    }

    for (const compiler of ["typescript-5-2", "typescript"] as const) {
      compileGeneratedResponse(response, { compiler, additionalFiles: { "consumer.ts": checkedValuesConsumer } });
    }
  },
};

interface CheckedError {
  name: string;
  message: string;
  operation: string;
  queryName?: string;
  batchIndex?: number;
  rowIndex?: number;
  path?: string;
  expected?: string;
  received?: string;
  cause?: unknown;
}

const runtimeValues: GeneratorScenario = {
  id: "generator/runtime-values",
  createInput: () => queryInput(createCheckedValuesRequest()),
  async assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.ok(outcome.response);
    const load = loadGeneratedModules(outcome.response);
    const runtime = load("runtime");
    const queries = load("values_sql");
    const DB = runtime.DB as new (executor: unknown) => {
      execute(query: unknown): Promise<unknown>;
      batch(...queries: unknown[]): Promise<unknown[]>;
    };
    const SqlcD1Error = runtime.SqlcD1Error as new (...args: never[]) => Error;
    const QueryArgumentError = runtime.QueryArgumentError as new (...args: never[]) => Error;
    const QueryResultError = runtime.QueryResultError as new (...args: never[]) => Error;
    const QueryUsageError = runtime.QueryUsageError as new (...args: never[]) => Error;
    const createSample = queries.createSample as (args: Record<string, unknown>) => { params: readonly unknown[] };
    const getSample = queries.getSample as (args: Record<string, unknown>) => unknown;
    const listSamples = queries.listSamples as () => unknown;
    const touchSample = queries.touchSample as (args: Record<string, unknown>) => unknown;

    const secret = "s3cr3t-value";
    const validArgs = (): Record<string, unknown> => ({
      intValue: 1,
      intNull: null,
      numValue: 1.5,
      numNull: null,
      textValue: "text",
      textNull: null,
      boolValue: true,
      boolNull: null,
      blobValue: new Uint8Array([1, 2, 3]),
      blobNull: null,
      jsonValue: { nested: [1, "two", null, true] },
      jsonNull: null,
      anyValue: "opaque",
      anyNull: null,
    });

    const rejectsArgument = (
      args: Record<string, unknown>,
      expectations: { path?: string; expected: string; received: string },
    ): CheckedError => {
      const executor = new FakeExecutor();
      let caught: unknown;
      try {
        createSample(args);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof QueryArgumentError, `expected QueryArgumentError for ${expectations.expected}`);
      const checked = caught as unknown as CheckedError;
      assert.equal(checked.name, "QueryArgumentError");
      assert.equal(checked.operation, "construct");
      assert.equal(checked.queryName, "CreateSample");
      if (expectations.path !== undefined) assert.equal(checked.path, expectations.path);
      assert.equal(checked.expected, expectations.expected);
      assert.equal(checked.received, expectations.received);
      assert.equal(executor.bound.length, 0);
      return checked;
    };

    // Accepted arguments are validated and snapshotted before any executor call.
    const bytes = new Uint8Array([1, 2, 3]);
    const settings = { nested: [1, "two", null, true] as unknown[] };
    const descriptor = createSample({ ...validArgs(), blobValue: bytes, jsonValue: settings });
    assert.deepEqual(descriptor.params.slice(0, 8), [1, null, 1.5, null, "text", null, true, null]);
    assert.deepEqual(descriptor.params[8], new Uint8Array([1, 2, 3]));
    assert.notEqual(descriptor.params[8], bytes);
    assert.equal(descriptor.params[10], JSON.stringify({ nested: [1, "two", null, true] }));
    assert.equal(descriptor.params[11], null);
    assert.equal(descriptor.params[12], "opaque");
    bytes[0] = 99;
    settings.nested[0] = 42;
    assert.deepEqual(descriptor.params[8], new Uint8Array([1, 2, 3]));
    assert.equal(descriptor.params[10], JSON.stringify({ nested: [1, "two", null, true] }));

    // Nullability, and the decided nullable-JSON limitation.
    assert.equal(createSample({ ...validArgs(), jsonValue: null }).params[10], "null");
    assert.equal(createSample({ ...validArgs(), jsonNull: { a: 1 } }).params[11], '{"a":1}');
    assert.deepEqual(createSample({ ...validArgs(), anyNull: new Uint8Array([7]) }).params[13], new Uint8Array([7]));
    for (const accepted of [true, false, 1.5, 0, "text", new Uint8Array([1])]) {
      assert.deepEqual(createSample({ ...validArgs(), anyValue: accepted }).params[12], accepted);
    }

    rejectsArgument({ ...validArgs(), intValue: 1.5 }, { path: "intValue", expected: "a safe integer", received: "non-integer number" });
    rejectsArgument({ ...validArgs(), intValue: 2 ** 53 }, { path: "intValue", expected: "a safe integer", received: "unsafe integer" });
    rejectsArgument({ ...validArgs(), intNull: 1.5 }, { path: "intNull", expected: "a safe integer or null", received: "non-integer number" });
    rejectsArgument({ ...validArgs(), numValue: Number.POSITIVE_INFINITY }, { path: "numValue", expected: "a finite number", received: "non-finite number" });
    rejectsArgument({ ...validArgs(), numValue: Number.NaN }, { path: "numValue", expected: "a finite number", received: "non-finite number" });
    rejectsArgument({ ...validArgs(), textValue: 1 }, { path: "textValue", expected: "a string", received: "number" });
    rejectsArgument({ ...validArgs(), boolValue: 1 }, { path: "boolValue", expected: "a boolean", received: "number" });
    rejectsArgument({ ...validArgs(), blobValue: new ArrayBuffer(3) }, { path: "blobValue", expected: "a Uint8Array", received: "object" });
    rejectsArgument({ ...validArgs(), blobValue: [1, 2, 3] }, { path: "blobValue", expected: "a Uint8Array", received: "array" });
    rejectsArgument({ ...validArgs(), anyValue: 10n }, { path: "anyValue", expected: "a boolean, finite number, string, or Uint8Array", received: "bigint" });
    rejectsArgument({ ...validArgs(), anyValue: new Date() }, { path: "anyValue", expected: "a boolean, finite number, string, or Uint8Array", received: "object" });
    rejectsArgument({ ...validArgs(), anyValue: null }, { path: "anyValue", expected: "a boolean, finite number, string, or Uint8Array", received: "null" });
    rejectsArgument({ ...validArgs(), anyValue: Number.POSITIVE_INFINITY }, { path: "anyValue", expected: "a boolean, finite number, string, or Uint8Array", received: "non-finite number" });

    // Recursive JsonValue validation, with paths into the caller's own structure.
    rejectsArgument({ ...validArgs(), jsonValue: new Date() }, { path: "jsonValue", expected: "a plain JSON object", received: "object" });
    rejectsArgument({ ...validArgs(), jsonValue: { a: undefined } }, { path: "jsonValue.a", expected: "a JSON value", received: "undefined" });
    rejectsArgument({ ...validArgs(), jsonValue: { a: [0, Number.POSITIVE_INFINITY] } }, { path: "jsonValue.a[1]", expected: "a finite number", received: "non-finite number" });
    rejectsArgument({ ...validArgs(), jsonValue: { a: () => 1 } }, { path: "jsonValue.a", expected: "a JSON value", received: "function" });
    rejectsArgument({ ...validArgs(), jsonValue: { a: 1n } }, { path: "jsonValue.a", expected: "a JSON value", received: "bigint" });
    rejectsArgument({ ...validArgs(), jsonValue: { [Symbol("k")]: 1 } }, { path: "jsonValue", expected: "a JSON object without symbol keys", received: "object" });
    rejectsArgument({ ...validArgs(), jsonValue: { a: Object.create({ inherited: 1 }) as object } }, { path: "jsonValue.a", expected: "a plain JSON object", received: "object" });
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    rejectsArgument({ ...validArgs(), jsonValue: cyclic }, { path: "jsonValue.self", expected: "an acyclic JSON value", received: "object" });
    const shared = { reused: true };
    assert.equal(createSample({ ...validArgs(), jsonValue: [shared, shared] }).params[10], '[{"reused":true},{"reused":true}]');

    // Every property is required; omission and explicit undefined are both violations.
    for (const [property, expected] of [
      ["intValue", "a safe integer"],
      ["intNull", "a safe integer or null"],
      ["numValue", "a finite number"],
      ["textValue", "a string"],
      ["boolValue", "a boolean"],
      ["blobValue", "a Uint8Array"],
      ["jsonValue", "a JSON value"],
      ["anyValue", "a boolean, finite number, string, or Uint8Array"],
    ] as const) {
      const omitted = validArgs();
      delete omitted[property];
      rejectsArgument(omitted, { path: property, expected, received: "undefined" });
      rejectsArgument({ ...validArgs(), [property]: undefined }, { path: property, expected, received: "undefined" });
    }

    // A non-object argument bag fails with the decided class, not a bare TypeError.
    for (const [bag, received] of [[null, "null"], [undefined, "undefined"], ["text", "string"], [7, "number"]] as const) {
      let caught: unknown;
      try {
        createSample(bag as unknown as Record<string, unknown>);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof QueryArgumentError);
      const checked = caught as unknown as CheckedError;
      assert.equal(checked.operation, "construct");
      assert.equal(checked.queryName, "CreateSample");
      assert.equal(checked.expected, "an arguments object");
      assert.equal(checked.received, received);
      assert.equal(checked.path, undefined);
    }

    // Row mapping.
    const physicalRow = (): Record<string, unknown> => ({
      int_value: 1,
      int_null: null,
      num_value: 1.5,
      num_null: null,
      text_value: "text",
      text_null: null,
      bool_value: 1,
      bool_null: 0,
      blob_value: [1, 2, 3],
      blob_null: null,
      json_value: '{"a":1}',
      json_null: null,
      any_value: "opaque",
      any_null: null,
      unexpected_extra: secret,
    });

    const executeWithRows = async (rows: unknown[], query: unknown): Promise<{ executor: FakeExecutor; result: unknown }> => {
      const executor = new FakeExecutor();
      executor.rows = rows;
      const result = await new DB(executor).execute(query);
      return { executor, result };
    };

    const mapped = (await executeWithRows([physicalRow()], getSample({ intValue: 1 }))).result as Record<string, unknown>;
    assert.deepEqual(Object.keys(mapped), [
      "intValue", "intNull", "numValue", "numNull", "textValue", "textNull",
      "boolValue", "boolNull", "blobValue", "blobNull", "jsonValue", "jsonNull", "anyValue", "anyNull",
    ]);
    assert.equal(mapped.boolValue, true);
    assert.equal(mapped.boolNull, false);
    assert.deepEqual(mapped.blobValue, new Uint8Array([1, 2, 3]));
    assert.equal(mapped.blobValue instanceof Uint8Array, true);
    assert.deepEqual(mapped.jsonValue, { a: 1 });
    assert.equal(mapped.jsonNull, null);
    assert.equal(mapped.anyValue, "opaque");
    assert.equal(mapped.anyNull, null);
    assert.equal(Object.prototype.hasOwnProperty.call(mapped, "unexpected_extra"), false);

    const rejectsRow = async (
      mutate: (row: Record<string, unknown>) => void,
      expectations: { path: string; expected: string; received: string },
    ): Promise<CheckedError> => {
      const row = physicalRow();
      mutate(row);
      let caught: unknown;
      try {
        await executeWithRows([row], getSample({ intValue: 1 }));
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof QueryResultError, `expected QueryResultError for ${expectations.path}`);
      const checked = caught as unknown as CheckedError;
      assert.equal(checked.name, "QueryResultError");
      assert.equal(checked.operation, "execute");
      assert.equal(checked.queryName, "GetSample");
      assert.equal(checked.rowIndex, 0);
      assert.equal(checked.batchIndex, undefined);
      assert.equal(checked.path, expectations.path);
      assert.equal(checked.expected, expectations.expected);
      assert.equal(checked.received, expectations.received);
      return checked;
    };

    await rejectsRow((row) => { delete row.int_value; }, { path: "intValue", expected: "a safe integer", received: "missing field" });
    await rejectsRow((row) => { delete row.any_null; }, { path: "anyNull", expected: "a present value", received: "missing field" });
    await rejectsRow((row) => { row.int_value = null; }, { path: "intValue", expected: "a safe integer", received: "null" });
    await rejectsRow((row) => { row.any_value = null; }, { path: "anyValue", expected: "a non-null value", received: "null" });
    await rejectsRow((row) => { row.int_value = "1"; }, { path: "intValue", expected: "a safe integer", received: "string" });
    await rejectsRow((row) => { row.int_value = 2 ** 53; }, { path: "intValue", expected: "a safe integer", received: "unsafe integer" });
    await rejectsRow((row) => { row.num_value = "x"; }, { path: "numValue", expected: "a finite number", received: "string" });
    await rejectsRow((row) => { row.text_value = 1; }, { path: "textValue", expected: "a string", received: "number" });
    await rejectsRow((row) => { row.bool_value = 2; }, { path: "boolValue", expected: "the integer 0 or 1", received: "number" });
    await rejectsRow((row) => { row.bool_value = "1"; }, { path: "boolValue", expected: "the integer 0 or 1", received: "string" });
    await rejectsRow((row) => { row.bool_value = true; }, { path: "boolValue", expected: "the integer 0 or 1", received: "boolean" });
    await rejectsRow((row) => { row.blob_value = [1, 300]; }, { path: "blobValue", expected: "a byte array", received: "array" });
    await rejectsRow((row) => { row.blob_value = [1, 1.5]; }, { path: "blobValue", expected: "a byte array", received: "array" });
    await rejectsRow((row) => { row.blob_value = "bytes"; }, { path: "blobValue", expected: "a byte array", received: "string" });
    const malformed = await rejectsRow((row) => { row.json_value = "{oops"; }, { path: "jsonValue", expected: "JSON text", received: "malformed JSON string" });
    assert.ok(malformed.cause instanceof SyntaxError);
    await rejectsRow((row) => { row.json_value = 7; }, { path: "jsonValue", expected: "JSON text", received: "number" });

    // Defensive BLOB representations, and freshly constructed public rows.
    const uint8Row = physicalRow();
    uint8Row.blob_value = new Uint8Array([4, 5]);
    const uint8Mapped = (await executeWithRows([uint8Row], getSample({ intValue: 1 }))).result as Record<string, unknown>;
    assert.deepEqual(uint8Mapped.blobValue, new Uint8Array([4, 5]));
    assert.notEqual(uint8Mapped.blobValue, uint8Row.blob_value);
    const bufferRow = physicalRow();
    bufferRow.blob_value = new Uint8Array([6, 7]).buffer;
    const bufferMapped = (await executeWithRows([bufferRow], getSample({ intValue: 1 }))).result as Record<string, unknown>;
    assert.deepEqual(bufferMapped.blobValue, new Uint8Array([6, 7]));

    // rowIndex through :many.
    const manyRows = [physicalRow(), physicalRow(), physicalRow()];
    manyRows[2].bool_value = 9;
    let manyFailure: unknown;
    try {
      await executeWithRows(manyRows, listSamples());
    } catch (error) {
      manyFailure = error;
    }
    assert.ok(manyFailure instanceof QueryResultError);
    assert.equal((manyFailure as unknown as CheckedError).rowIndex, 2);
    assert.equal((manyFailure as unknown as CheckedError).queryName, "ListSamples");

    // operation, batchIndex, and rowIndex through batch.
    const batchExecutor = new FakeExecutor();
    const badRow = physicalRow();
    badRow.text_value = 7;
    batchExecutor.batchRows = [[physicalRow()], [], [physicalRow(), badRow]];
    let batchFailure: unknown;
    try {
      await new DB(batchExecutor).batch(getSample({ intValue: 1 }), touchSample(validArgs()), listSamples());
    } catch (error) {
      batchFailure = error;
    }
    assert.ok(batchFailure instanceof QueryResultError);
    const batchChecked = batchFailure as unknown as CheckedError;
    assert.equal(batchChecked.operation, "batch");
    assert.equal(batchChecked.batchIndex, 2);
    assert.equal(batchChecked.rowIndex, 1);
    assert.equal(batchChecked.queryName, "ListSamples");

    // Native rejections keep their identity, type, message, stack, and D1 fields.
    const nativeFailure = Object.assign(new Error("D1_ERROR: no such table: samples"), { cause: undefined, code: "D1_ERROR" });
    const nativeStack = nativeFailure.stack;
    const nativeExecutor = new FakeExecutor();
    nativeExecutor.failure = nativeFailure;
    let nativeCaught: unknown;
    try {
      await new DB(nativeExecutor).execute(getSample({ intValue: 1 }));
    } catch (error) {
      nativeCaught = error;
    }
    assert.equal(nativeCaught, nativeFailure);
    assert.equal((nativeCaught as Error).message, "D1_ERROR: no such table: samples");
    assert.equal((nativeCaught as Error).stack, nativeStack);
    assert.equal((nativeCaught as { code?: string }).code, "D1_ERROR");
    assert.equal(nativeCaught instanceof SqlcD1Error, false);

    // A forged or malformed descriptor fails closed before any executor call.
    for (const [forged, operation, batchIndex] of [
      [{}, "execute", undefined],
      [{ kind: "one", name: "X", sql: "SELECT 1", params: [] }, "execute", undefined],
      [{ kind: "unknown", name: "X", sql: "SELECT 1", params: [], parse: () => ({}) }, "execute", undefined],
      [null, "execute", undefined],
    ] as const) {
      const executor = new FakeExecutor();
      let caught: unknown;
      try {
        await new DB(executor).execute(forged);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof QueryUsageError, JSON.stringify(forged));
      const checked = caught as unknown as CheckedError;
      assert.equal(checked.name, "QueryUsageError");
      assert.equal(checked.operation, operation);
      assert.equal(checked.batchIndex, batchIndex);
      assert.equal(executor.bound.length, 0);
    }
    const forgedBatchExecutor = new FakeExecutor();
    let forgedBatchCaught: unknown;
    try {
      await new DB(forgedBatchExecutor).batch(getSample({ intValue: 1 }), {});
    } catch (error) {
      forgedBatchCaught = error;
    }
    assert.ok(forgedBatchCaught instanceof QueryUsageError);
    assert.equal((forgedBatchCaught as unknown as CheckedError).operation, "batch");
    assert.equal((forgedBatchCaught as unknown as CheckedError).batchIndex, 1);
    assert.equal(forgedBatchExecutor.bound.length, 0);

    // An unexpected mapper defect stays an ordinary exception.
    const defect = new ReferenceError("mapper defect");
    const defectExecutor = new FakeExecutor();
    defectExecutor.rows = [physicalRow()];
    let defectCaught: unknown;
    try {
      await new DB(defectExecutor).execute({
        kind: "one",
        name: "Defective",
        sql: "SELECT 1",
        params: [],
        parse: () => { throw defect; },
      });
    } catch (error) {
      defectCaught = error;
    }
    assert.equal(defectCaught, defect);
    assert.equal(defectCaught instanceof SqlcD1Error, false);

    // Errors carry no commit-state claim and never leak values, rows, SQL text, or parameters.
    const leakedRow = physicalRow();
    leakedRow.text_value = 7;
    let leakCaught: unknown;
    try {
      await executeWithRows([leakedRow], getSample({ intValue: 1 }));
    } catch (error) {
      leakCaught = error;
    }
    const leaked = leakCaught as Error;
    let argumentLeak: unknown;
    try {
      createSample({ ...validArgs(), intValue: secret });
    } catch (error) {
      argumentLeak = error;
    }
    assert.ok(argumentLeak instanceof QueryArgumentError);
    for (const candidate of [leaked, argumentLeak as Error]) {
      const serialized = `${candidate.message}|${JSON.stringify(candidate, Object.getOwnPropertyNames(candidate))}`;
      assert.equal(serialized.includes(secret), false, serialized);
      assert.equal(serialized.includes("SELECT * FROM samples"), false, serialized);
      assert.equal(serialized.includes("opaque"), false, serialized);
      assert.equal("effectsMayHaveCommitted" in candidate, false);
      for (const property of Object.getOwnPropertyNames(candidate)) {
        assert.doesNotMatch(property, /commit|retry/i);
      }
    }
  },
};

export const generatorScenarios = [
  currentCommands,
  checkedValues,
  runtimeValues,
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
