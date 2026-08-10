import assert from "node:assert/strict";
import test from "node:test";
import { GenerationDiagnosticError } from "../../src/diagnostics";
import {
  FIELD_NAME_PATTERN,
  PhysicalKeyNamespace,
  QUERY_NAME_PATTERN,
  allocatePublicNames,
  planEmission,
  planOutputPath,
  quoteTypeScriptString,
  runtimeImportSpecifier,
  toPublicFieldCamelCase,
  toQueryFactoryCamelCase,
} from "../../src/emission-plan";
import { Column, GenerateRequest, Identifier, Query, Settings } from "../../src/gen/plugin/codegen_pb";
import { validateGenerateRequest } from "../../src/validation";

const identifier = (name: string) => new Identifier({ name });
const column = (name: string) => new Column({ name, type: identifier("text"), notNull: true });
const request = (queries: Query[]) => new GenerateRequest({ settings: new Settings({ engine: "sqlite" }), sqlcVersion: "v1.31.1", queries });

test("ordinary TypeScript literals round-trip hostile UTF-16 text", () => {
  const values = ['"\\` ${injection}\n\r\t\0\u2028\u2029 café', "\ud800"];
  for (const value of values) {
    const literal = quoteTypeScriptString(value);
    assert.equal(JSON.parse(literal), value);
    assert.ok(literal.startsWith('"') && literal.endsWith('"'));
    assert.equal(literal.includes(String.fromCharCode(0x2028)), false);
    assert.equal(literal.includes(String.fromCharCode(0x2029)), false);
  }
});

test("ASCII name policies implement the decided word-aware forms", () => {
  for (const value of ["GetUser", "URLValue", "GetURL", "OAuthToken", "Query2"]) assert.match(value, QUERY_NAME_PATTERN);
  for (const value of ["foo", "Get_User", "Get-User", "1Query", "İtem", "😀"]) assert.doesNotMatch(value, QUERY_NAME_PATTERN);
  for (const value of ["user_id", "USER_ID", "userID", "user_ID", "URLValue", "created_at_2"]) assert.match(value, FIELD_NAME_PATTERN);
  for (const value of ["_id", "id_", "foo__bar", "1id", "café", "foo-bar"]) assert.doesNotMatch(value, FIELD_NAME_PATTERN);
  assert.deepEqual(["user_id", "USER_ID", "userID", "user_ID", "URLValue", "created_at_2"].map(toPublicFieldCamelCase), ["userId", "userId", "userId", "userId", "urlValue", "createdAt2"]);
  assert.deepEqual(["URLValue", "GetURL", "OAuthToken"].map(toQueryFactoryCamelCase), ["urlValue", "getURL", "oAuthToken"]);
  assert.deepEqual(allocatePublicNames(["foo_bar", "fooBar", "FOO_BAR", "created_at", "createdAt", "created_at_2", "", "column7"]), ["fooBar", "fooBar_2", "fooBar_3", "createdAt", "createdAt_2", "createdAt2", "column7", "column7_2"]);
});

test("portable output paths and runtime imports are host independent", () => {
  assert.deepEqual(["users.sql", "admin/users.sql", "a.b.sql"].map(planOutputPath), ["users_sql.ts", "admin/users_sql.ts", "a_b_sql.ts"]);
  for (const value of ["/a.sql", "C:/a.sql", "\\\\server\\a.sql", "a\\b.sql", "a/../b.sql", "a//b.sql", "a b.sql", "café.sql", "CON.sql", "dir/Lpt9.txt", "a."]) assert.equal(planOutputPath(value), undefined, value);
  assert.deepEqual(["users_sql.ts", "admin/users_sql.ts", "a/b/users_sql.ts"].map(runtimeImportSpecifier), ["./runtime", "../runtime", "../../runtime"]);
  const namespace = new PhysicalKeyNamespace(["alias", "alias_2"]);
  assert.equal(namespace.allocatePrivatePhysicalAlias("alias"), "alias_3");
  assert.equal(namespace.allocatePrivatePhysicalAlias("alias"), "alias_4");
});

test("complete planning aggregates naming, declaration, and path errors", () => {
  const queries = [
    new Query({ filename: "a.b", name: "Class", cmd: ":exec", text: "DELETE" }),
    new Query({ filename: "a_b", name: "URLValue", cmd: ":exec", text: "DELETE" }),
    new Query({ filename: "a_b", name: "UrlValue", cmd: ":exec", text: "DELETE" }),
    new Query({ filename: "bad/../name.sql", name: "Bad-Name", cmd: ":many", text: "SELECT", columns: [column("bad-name")] }),
  ];
  assert.throws(() => planEmission(validateGenerateRequest(request(queries))), (error) => {
    assert.ok(error instanceof GenerationDiagnosticError);
    const reasons = error.diagnostics.map((diagnostic) => diagnostic.reason);
    for (const reason of ["OUTPUT_PATH_COLLISION", "RESERVED_DECLARATION", "DECLARATION_COLLISION", "INVALID_OUTPUT_PATH", "INVALID_QUERY_NAME", "INVALID_FIELD_NAME"]) assert.ok(reasons.includes(reason), reason);
    return true;
  });
});

test("all current commands plan one opaque descriptor import and complete result types", () => {
  const id = column("id");
  const plan = planEmission(validateGenerateRequest(request([
    new Query({ filename: "queries.sql", name: "GetOne", cmd: ":one", text: "SELECT", columns: [id] }),
    new Query({ filename: "queries.sql", name: "InsertOne", cmd: ":one", text: "INSERT RETURNING", columns: [id], insertIntoTable: identifier("items") }),
    new Query({ filename: "queries.sql", name: "ListMany", cmd: ":many", text: "SELECT", columns: [id] }),
    new Query({ filename: "queries.sql", name: "RunExec", cmd: ":exec", text: "DELETE" }),
  ])));
  const module = plan.queryModules[0];
  assert.deepEqual(module.runtimeTypeImports, ["QueryDescriptor"]);
  assert.deepEqual(module.queries.map((query) => query.factoryReturnType), [
    "QueryDescriptor<GetOneRow | null>",
    "QueryDescriptor<InsertOneRow | null>",
    "QueryDescriptor<ListManyRow[]>",
    "QueryDescriptor<void>",
  ]);
});

test("valid planning preserves request order within sorted modules and exact SQL", () => {
  const sql = "SELECT '` ${x}'\n\u2028";
  const plan = planEmission(validateGenerateRequest(request([
    new Query({ filename: "z.sql", name: "GetURL", cmd: ":one", text: sql, columns: [column("USER_ID")] }),
    new Query({ filename: "a/users.sql", name: "DeleteAll", cmd: ":exec", text: "DELETE" }),
  ])));
  assert.deepEqual(plan.queryModules.map((module) => module.outputPath), ["a/users_sql.ts", "z_sql.ts"]);
  assert.equal(JSON.parse(plan.queryModules[1].queries[0].sqlLiteral), sql);
  assert.deepEqual(plan.queryModules[1].runtimeTypeImports, ["QueryDescriptor"]);
  assert.equal(plan.queryModules[1].queries[0].factoryReturnType, "QueryDescriptor<GetURLRow | null>");
  assert.equal(plan.queryModules[0].queries[0].factoryReturnType, "QueryDescriptor<void>");
  assert.equal(plan.queryModules[0].runtimeSpecifierLiteral, '"../runtime"');
});
