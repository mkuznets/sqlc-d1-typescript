import assert from "node:assert/strict";
import test from "node:test";
import { GenerationDiagnosticError } from "../../src/diagnostics";
import { Column, GenerateRequest, Identifier, Parameter, Query, Settings } from "../../src/gen/plugin/codegen_pb";
import { validateGenerateRequest } from "../../src/validation";

const encoder = new TextEncoder();
const identifier = (name: string) => new Identifier({ name });
const column = (name = "id") => new Column({ name, type: identifier("integer"), notNull: true });

function request(data: Partial<GenerateRequest> = {}): GenerateRequest {
  return new GenerateRequest({ settings: new Settings({ engine: "sqlite" }), sqlcVersion: "v1.31.1", ...data });
}

function validQuery(data: Partial<Query> = {}): Query {
  return new Query({ filename: "queries.sql", name: "Get", cmd: ":one", text: "SELECT id", columns: [column()], ...data });
}

function reasons(input: GenerateRequest): string[] {
  try {
    validateGenerateRequest(input);
    return [];
  } catch (error) {
    assert.ok(error instanceof GenerationDiagnosticError);
    return error.diagnostics.map(({ category, reason }) => `${category}/${reason}`);
  }
}

test("plugin options default to the Workers binding and are strict", () => {
  for (const pluginOptions of [new Uint8Array(), encoder.encode("{}"), encoder.encode('{"interface":"workers"}')]) {
    assert.deepEqual(validateGenerateRequest(request({ pluginOptions })).options, { interface: "workers" });
  }
  const cases: Array<[Uint8Array, string]> = [
    [new Uint8Array([0xff]), "OPTIONS/INVALID_UTF8"],
    [encoder.encode("{"), "OPTIONS/MALFORMED_JSON"],
    [encoder.encode("null"), "OPTIONS/NON_OBJECT"],
    [encoder.encode('{"interfaces":"workers"}'), "OPTIONS/UNKNOWN_OPTION"],
    [encoder.encode('{"interface":"http"}'), "OPTIONS/UNSUPPORTED_INTERFACE"],
  ];
  for (const [pluginOptions, expected] of cases) {
    assert.deepEqual(reasons(request({ pluginOptions: Uint8Array.from(pluginOptions) })), [expected]);
  }
});

test("compatibility validation implements the sqlc semantic-version floor and warning ceiling", () => {
  assert.deepEqual(reasons(new GenerateRequest()), ["PROTOCOL/MISSING_SETTINGS", "COMPATIBILITY/MISSING_SQLC_VERSION"]);
  assert.deepEqual(reasons(request({ settings: new Settings({ engine: "postgresql" }) })), ["COMPATIBILITY/UNSUPPORTED_ENGINE"]);
  for (const sqlcVersion of ["v1.18.0", "1.18.0", "v1.31.1", "v1.31.1+build.7"]) {
    assert.equal(validateGenerateRequest(request({ sqlcVersion })).warnings.length, 0);
  }
  for (const sqlcVersion of ["1.18", "1.018.0", "1.18.0-"]) {
    assert.deepEqual(reasons(request({ sqlcVersion })), ["COMPATIBILITY/MALFORMED_SQLC_VERSION"]);
  }
  for (const sqlcVersion of ["v1.17.9", "v1.18.0-rc.1"]) {
    assert.deepEqual(reasons(request({ sqlcVersion })), ["COMPATIBILITY/UNSUPPORTED_SQLC_VERSION"]);
  }
  assert.deepEqual(validateGenerateRequest(request({ sqlcVersion: "999999999999999999999.0.0" })).warnings.map(({ reason }) => reason), ["UNTESTED_SQLC_VERSION"]);
});

test("query validation aggregates independent boundary findings", () => {
  const query = validQuery({
    filename: "",
    name: "",
    cmd: ":copyfrom",
    text: "",
    params: [new Parameter({ number: 0 })],
    columns: [],
  });
  assert.deepEqual(reasons(request({ queries: [query] })), [
    "QUERY/MISSING_FILENAME",
    "QUERY/MISSING_NAME",
    "QUERY/MISSING_SQL",
    "QUERY/UNSUPPORTED_COMMAND",
    "QUERY/MISSING_PARAMETER_COLUMN",
    "QUERY/INVALID_BIND_NUMBER",
  ]);
});

test("query metadata validates repeated binds, slices, embeds, result columns, and emission readiness", () => {
  const id = column();
  const conflicting = column("other");
  assert.ok(reasons(request({ queries: [validQuery({ cmd: ":exec", columns: [], params: [new Parameter({ number: 1, column: id }), new Parameter({ number: 1, column: conflicting })] })] })).includes("QUERY/CONFLICTING_BIND_NUMBER"));

  const slice = new Column({ name: "ids", type: identifier("integer"), isSqlcSlice: true });
  assert.deepEqual(reasons(request({ queries: [validQuery({ cmd: ":exec", columns: [], params: [new Parameter({ number: 1, column: slice })], text: "DELETE WHERE id IN (/*SLICE:ids*/?)" })] })), ["EMISSION/UNIMPLEMENTED_SLICE"]);
  assert.ok(reasons(request({ queries: [validQuery({ params: [new Parameter({ number: 1, column: slice })] })] })).includes("QUERY/SLICE_METADATA_MISMATCH"));

  const embed = new Column({ name: "user", embedTable: identifier("users") });
  assert.deepEqual(reasons(request({ queries: [validQuery({ columns: [embed] })] })), ["EMISSION/UNIMPLEMENTED_EMBED"]);
  assert.ok(reasons(request({ queries: [validQuery({ columns: [new Column({ embedTable: identifier("") })] })] })).includes("QUERY/INVALID_EMBED_METADATA"));

  assert.deepEqual(reasons(request({ queries: [validQuery({ columns: [] })] })), ["QUERY/MISSING_RESULT_COLUMNS"]);
  assert.deepEqual(reasons(request({ queries: [validQuery({ columns: [id, column()] })] })), ["QUERY/DUPLICATE_PHYSICAL_COLUMN"]);
  for (const cmd of [":execrows", ":execlastid", ":execresult"]) {
    assert.deepEqual(reasons(request({ queries: [validQuery({ cmd, columns: [] })] })), ["EMISSION/UNIMPLEMENTED_COMMAND"]);
  }
});
