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
    ...["null", "[]", '"workers"', "1", "true"].map((json) => [encoder.encode(json), "OPTIONS/NON_OBJECT"] as [Uint8Array, string]),
    [encoder.encode('{"interfaces":"workers"}'), "OPTIONS/UNKNOWN_OPTION"],
    ...['"http"', "null", "false", "1", "[]", "{}"].map((json) => [encoder.encode(`{"interface":${json}}`), "OPTIONS/UNSUPPORTED_INTERFACE"] as [Uint8Array, string]),
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
  for (const sqlcVersion of ["1.18", "1.018.0", "1.18.0-", "1.18.0-01", "1.18.0+bad..build"]) {
    assert.deepEqual(reasons(request({ sqlcVersion })), ["COMPATIBILITY/MALFORMED_SQLC_VERSION"]);
  }
  for (const sqlcVersion of ["v1.17.9", "v1.18.0-rc.1"]) {
    assert.deepEqual(reasons(request({ sqlcVersion })), ["COMPATIBILITY/UNSUPPORTED_SQLC_VERSION"]);
  }
  for (const sqlcVersion of ["v1.31.2", "v1.32.0-rc.1", "999999999999999999999.0.0"]) {
    assert.deepEqual(validateGenerateRequest(request({ sqlcVersion })).warnings.map(({ reason }) => reason), ["UNTESTED_SQLC_VERSION"]);
  }
});

test("query validation aggregates independent boundary findings", () => {
  const query = validQuery({
    filename: "",
    name: "",
    cmd: "",
    text: "",
    params: [new Parameter({ number: 0 })],
    columns: [],
  });
  assert.deepEqual(reasons(request({ queries: [query] })), [
    "QUERY/MISSING_FILENAME",
    "QUERY/MISSING_NAME",
    "QUERY/MISSING_COMMAND",
    "QUERY/MISSING_SQL",
    "QUERY/MISSING_PARAMETER_COLUMN",
    "QUERY/INVALID_BIND_NUMBER",
  ]);
});

test("repeated bind numbers compare every semantic column field but ignore comments", () => {
  const baseData = { name: "id", notNull: true, type: identifier("integer") };
  const changedColumns = [
    new Column({ ...baseData, name: "other" }),
    new Column({ ...baseData, notNull: false }),
    new Column({ ...baseData, isArray: true }),
    new Column({ ...baseData, length: 1 }),
    new Column({ ...baseData, isNamedParam: true }),
    new Column({ ...baseData, isFuncCall: true }),
    new Column({ ...baseData, scope: "scope" }),
    new Column({ ...baseData, table: identifier("table") }),
    new Column({ ...baseData, tableAlias: "alias" }),
    new Column({ ...baseData, type: identifier("text") }),
    new Column({ ...baseData, isSqlcSlice: true }),
    new Column({ ...baseData, embedTable: identifier("users") }),
    new Column({ ...baseData, originalName: "original" }),
    new Column({ ...baseData, unsigned: true }),
    new Column({ ...baseData, arrayDims: 1 }),
  ];
  for (const changed of changedColumns) {
    const query = validQuery({
      cmd: ":exec",
      columns: [],
      text: changed.isSqlcSlice ? "DELETE /*SLICE:id*/?" : "DELETE",
      params: [new Parameter({ number: 1, column: new Column(baseData) }), new Parameter({ number: 1, column: changed })],
    });
    assert.ok(reasons(request({ queries: [query] })).includes("QUERY/CONFLICTING_BIND_NUMBER"));
  }
  const commentsOnly = validQuery({
    cmd: ":exec",
    columns: [],
    params: [
      new Parameter({ number: 1, column: new Column({ ...baseData, comment: "first" }) }),
      new Parameter({ number: 1, column: new Column({ ...baseData, comment: "second" }) }),
    ],
  });
  assert.deepEqual(reasons(request({ queries: [commentsOnly] })), []);
});

test("slice validation suppresses SQL-dependent cascades and identifies duplicate marker locations", () => {
  const slice = new Column({ name: "ids", type: identifier("integer"), isSqlcSlice: true });
  const missingSql = validQuery({ cmd: ":exec", columns: [], text: "", params: [new Parameter({ number: 1, column: slice })] });
  assert.deepEqual(reasons(request({ queries: [missingSql] })), ["QUERY/MISSING_SQL"]);

  const duplicateMarkers = validQuery({
    cmd: ":exec",
    columns: [],
    text: "DELETE /*SLICE:ids*/? OR /*SLICE:ids*/?",
    params: [new Parameter({ number: 1, column: slice })],
  });
  assert.equal(reasons(request({ queries: [duplicateMarkers] })).filter((reason) => reason === "QUERY/SLICE_METADATA_MISMATCH").length, 2);
});

test("emission readiness is suppressed only by its own invalid metadata", () => {
  const validSlice = new Column({ name: "ids", type: identifier("integer"), isSqlcSlice: true });
  assert.deepEqual(
    reasons(request({ queries: [validQuery({ filename: "", cmd: ":exec", columns: [], text: "DELETE WHERE id IN (/*SLICE:ids*/?)", params: [new Parameter({ number: 1, column: validSlice })] })] })),
    ["QUERY/MISSING_FILENAME"],
  );

  const validEmbed = new Column({ name: "user", embedTable: identifier("users") });
  assert.deepEqual(
    reasons(request({ queries: [validQuery({ filename: "", columns: [validEmbed] })] })),
    ["QUERY/MISSING_FILENAME", "EMISSION/UNIMPLEMENTED_EMBED"],
  );
});

test("query metadata validates repeated binds, slices, embeds, result columns, and emission readiness", () => {
  assert.deepEqual(reasons(request({ queries: [validQuery({ cmd: ":copyfrom", columns: [] })] })), ["QUERY/UNSUPPORTED_COMMAND"]);
  const id = column();
  const conflicting = column("other");
  assert.ok(reasons(request({ queries: [validQuery({ cmd: ":exec", columns: [], params: [new Parameter({ number: 1, column: id }), new Parameter({ number: 1, column: conflicting })] })] })).includes("QUERY/CONFLICTING_BIND_NUMBER"));

  const slice = new Column({ name: "ids", type: identifier("integer"), isSqlcSlice: true });
  assert.deepEqual(reasons(request({ queries: [validQuery({ cmd: ":exec", columns: [], params: [new Parameter({ number: 1, column: slice })], text: "DELETE WHERE id IN (/*SLICE:ids*/?)" })] })), []);
  assert.ok(reasons(request({ queries: [validQuery({ params: [new Parameter({ number: 1, column: slice })] })] })).includes("QUERY/SLICE_METADATA_MISMATCH"));

  const embed = new Column({ name: "user", embedTable: identifier("users") });
  assert.deepEqual(reasons(request({ queries: [validQuery({ columns: [embed] })] })), ["EMISSION/UNIMPLEMENTED_EMBED"]);
  assert.ok(reasons(request({ queries: [validQuery({ columns: [new Column({ embedTable: identifier("") })] })] })).includes("QUERY/INVALID_EMBED_METADATA"));

  assert.deepEqual(reasons(request({ queries: [validQuery({ columns: [] })] })), ["QUERY/MISSING_RESULT_COLUMNS"]);
  for (const cmd of [":execrows", ":execlastid", ":execresult"]) {
    assert.deepEqual(reasons(request({ queries: [validQuery({ cmd, columns: [] })] })), []);
  }
});

test("bind shapes that cannot be reproduced as a SQLite binding are rejected", () => {
  const named = (name: string) => new Column({ name, type: identifier("integer"), notNull: true, isNamedParam: true });
  const slice = new Column({ name: "ids", type: identifier("integer"), isSqlcSlice: true, isNamedParam: true });

  // A gap means the metadata does not describe a bindable statement.
  const gap = validQuery({
    cmd: ":exec",
    columns: [],
    text: "DELETE FROM users WHERE id = ?1 AND owner_id = ?3",
    params: [new Parameter({ number: 1, column: named("id") }), new Parameter({ number: 3, column: named("owner_id") })],
  });
  assert.deepEqual(reasons(request({ queries: [gap] })), ["QUERY/BIND_NUMBER_GAP"]);

  // params is text order, so a descending step means a named placeholder precedes a bare one.
  const descending = validQuery({
    cmd: ":exec",
    columns: [],
    text: "DELETE FROM users WHERE name = ?2 AND age = ?",
    params: [new Parameter({ number: 2, column: named("nm") }), new Parameter({ number: 1, column: column("age") })],
  });
  assert.deepEqual(reasons(request({ queries: [descending] })), ["QUERY/UNSUPPORTED_BIND_ORDER"]);

  // The reported position is the parameter's own, not its position among distinct
  // bind numbers; the two differ once an earlier bind number repeats.
  const repeatedThenDescending = validQuery({
    cmd: ":exec",
    columns: [],
    text: "DELETE FROM users WHERE id = ?1 AND owner_id = ?1 AND name = ?3 AND age = ?",
    params: [
      new Parameter({ number: 1, column: named("id") }),
      new Parameter({ number: 1, column: named("id") }),
      new Parameter({ number: 3, column: named("nm") }),
      new Parameter({ number: 2, column: column("age") }),
    ],
  });
  assert.throws(() => validateGenerateRequest(request({ queries: [repeatedThenDescending] })), (error) => {
    assert.ok(error instanceof GenerationDiagnosticError);
    assert.deepEqual(error.diagnostics.map(({ reason, fieldPath, fieldIndex }) => ({ reason, fieldPath, fieldIndex })), [
      { reason: "UNSUPPORTED_BIND_ORDER", fieldPath: "params[2]", fieldIndex: 2 },
    ]);
    return true;
  });

  // Ascending numbers in text order are reproducible, whatever their spelling.
  const ascending = validQuery({
    cmd: ":exec",
    columns: [],
    text: "DELETE FROM users WHERE age = ? AND name = ?2",
    params: [new Parameter({ number: 1, column: column("age") }), new Parameter({ number: 2, column: named("nm") })],
  });
  assert.deepEqual(reasons(request({ queries: [ascending] })), []);

  // Expanding a slice would move every later placeholder, so a numbered one cannot coexist.
  const mixture = validQuery({
    cmd: ":exec",
    columns: [],
    text: "DELETE FROM users WHERE name IN (/*SLICE:ids*/?) AND nickname = ?2",
    params: [new Parameter({ number: 1, column: slice }), new Parameter({ number: 2, column: named("nickname") })],
  });
  assert.deepEqual(reasons(request({ queries: [mixture] })), ["QUERY/SLICE_BIND_MIXTURE"]);

  // A slice query whose placeholders are all bare binds in text order.
  const sliceOnly = validQuery({
    cmd: ":exec",
    columns: [],
    text: "DELETE FROM users WHERE id IN (/*SLICE:ids*/?) LIMIT ?",
    params: [new Parameter({ number: 2, column: slice }), new Parameter({ number: 1, column: column("limit") })],
  });
  assert.deepEqual(reasons(request({ queries: [sliceOnly] })), []);
});

test("bind-shape validation is suppressed by an earlier diagnostic for the same query", () => {
  // A conflicting bind number makes the slot list meaningless; only the cause is reported.
  const conflicting = validQuery({
    cmd: ":exec",
    columns: [],
    text: "DELETE FROM users WHERE id = ?2 AND owner = ?2",
    params: [
      new Parameter({ number: 2, column: column("id") }),
      new Parameter({ number: 2, column: column("owner") }),
    ],
  });
  assert.deepEqual(reasons(request({ queries: [conflicting] })), ["QUERY/CONFLICTING_BIND_NUMBER"]);

  // Invalid slice metadata suppresses the mixture check that depends on it.
  const badSlice = new Column({ name: "", type: identifier("integer"), isSqlcSlice: true });
  const orphan = validQuery({
    cmd: ":exec",
    columns: [],
    text: "DELETE FROM users WHERE id IN (?) AND nickname = ?2",
    params: [new Parameter({ number: 1, column: badSlice }), new Parameter({ number: 2, column: column("nickname") })],
  });
  assert.deepEqual(reasons(request({ queries: [orphan] })), ["QUERY/SLICE_METADATA_MISMATCH"]);
});

test("duplicate physical result keys are rejected only where rows are mapped", () => {
  const repeated = [column(), column()];
  for (const cmd of [":one", ":many"]) {
    assert.deepEqual(reasons(request({ queries: [validQuery({ cmd, columns: repeated })] })), ["QUERY/DUPLICATE_PHYSICAL_COLUMN"]);
  }
  // The exec family never reads a result column, so colliding physical keys are not its problem.
  for (const cmd of [":exec", ":execrows", ":execlastid", ":execresult"]) {
    assert.deepEqual(reasons(request({ queries: [validQuery({ cmd, columns: repeated })] })), []);
  }
});
