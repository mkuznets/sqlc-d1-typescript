import assert from "node:assert/strict";
import test from "node:test";
import { GenerationDiagnosticError } from "../../src/diagnostics.ts";
import {
  FIELD_NAME_PATTERN,
  PhysicalKeyNamespace,
  QUERY_NAME_PATTERN,
  RESULT_CONTEXT_ALIAS,
  RUNTIME_VALUE_ALIAS,
  SLICE_LOCAL_PREFIX,
  allocatePublicNames,
  planEmission,
  planOutputPath,
  quoteTypeScriptString,
  runtimeImportSpecifier,
  toPublicFieldCamelCase,
  toQueryFactoryCamelCase,
} from "../../src/emission-plan.ts";
import {
  Catalog,
  Column,
  GenerateRequest,
  Identifier,
  Parameter,
  Query,
  Schema,
  Settings,
  Table,
} from "../../src/gen/plugin/codegen_pb.ts";
import { validateGenerateRequest } from "../../src/validation.ts";

const identifier = (name: string) => new Identifier({ name });
const column = (name: string) => new Column({ name, type: identifier("text"), notNull: true });
const typedColumn = (name: string, typeName: string, notNull = true) =>
  new Column({ name, type: identifier(typeName), notNull });
const request = (queries: Query[]) =>
  new GenerateRequest({ settings: new Settings({ engine: "sqlite" }), sqlcVersion: "v1.31.1", queries });

const embedColumn = (tableName: string) => new Column({ name: tableName, embedTable: identifier(tableName) });
const catalogTable = (name: string, columns: Column[]) => new Table({ rel: identifier(name), columns });

// Embed planning happens after validation, so these requests are planned directly.
const planEmbedded = (catalog: Catalog, queries: Query[]) =>
  planEmission({
    request: new GenerateRequest({
      settings: new Settings({ engine: "sqlite" }),
      sqlcVersion: "v1.31.1",
      catalog,
      queries,
    }),
    options: { interface: "workers" },
    warnings: [],
  });

const embedCatalog = new Catalog({
  defaultSchema: "main",
  schemas: [
    new Schema({
      name: "main",
      tables: [
        catalogTable("users", [typedColumn("id", "INTEGER"), typedColumn("name", "TEXT")]),
        catalogTable("posts", [
          typedColumn("id", "INTEGER"),
          typedColumn("user_id", "INTEGER"),
          typedColumn("title", "TEXT", false),
        ]),
        catalogTable("odd", [typedColumn("foo_bar", "TEXT"), typedColumn("fooBar", "TEXT")]),
      ],
    }),
  ],
});

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
  for (const value of ["GetUser", "URLValue", "GetURL", "OAuthToken", "Query2"])
    assert.match(value, QUERY_NAME_PATTERN);
  for (const value of ["foo", "Get_User", "Get-User", "1Query", "İtem", "😀"])
    assert.doesNotMatch(value, QUERY_NAME_PATTERN);
  for (const value of ["user_id", "USER_ID", "userID", "user_ID", "URLValue", "created_at_2"])
    assert.match(value, FIELD_NAME_PATTERN);
  for (const value of ["_id", "id_", "foo__bar", "1id", "café", "foo-bar"])
    assert.doesNotMatch(value, FIELD_NAME_PATTERN);
  assert.deepEqual(
    ["user_id", "USER_ID", "userID", "user_ID", "URLValue", "created_at_2"].map(toPublicFieldCamelCase),
    ["userId", "userId", "userId", "userId", "urlValue", "createdAt2"],
  );
  assert.deepEqual(["URLValue", "GetURL", "OAuthToken"].map(toQueryFactoryCamelCase), [
    "urlValue",
    "getURL",
    "oAuthToken",
  ]);
  assert.deepEqual(
    allocatePublicNames(["foo_bar", "fooBar", "FOO_BAR", "created_at", "createdAt", "created_at_2", "", "column7"]),
    ["fooBar", "fooBar_2", "fooBar_3", "createdAt", "createdAt_2", "createdAt2", "column7", "column7_2"],
  );
});

test("portable output paths and runtime imports are host independent", () => {
  assert.deepEqual(["users.sql", "admin/users.sql", "a.b.sql"].map(planOutputPath), [
    "users_sql.ts",
    "admin/users_sql.ts",
    "a_b_sql.ts",
  ]);
  for (const value of [
    "/a.sql",
    "C:/a.sql",
    "\\\\server\\a.sql",
    "a\\b.sql",
    "a/../b.sql",
    "a//b.sql",
    "a b.sql",
    "café.sql",
    "CON.sql",
    "dir/Lpt9.txt",
    "a.",
  ])
    assert.equal(planOutputPath(value), undefined, value);
  assert.deepEqual(["users_sql.ts", "admin/users_sql.ts", "a/b/users_sql.ts"].map(runtimeImportSpecifier), [
    "./runtime",
    "../runtime",
    "../../runtime",
  ]);
  const namespace = new PhysicalKeyNamespace(["alias", "alias_2"]);
  assert.equal(namespace.allocatePrivatePhysicalAlias("alias"), "alias_3");
  assert.equal(namespace.allocatePrivatePhysicalAlias("alias"), "alias_4");
});

test("complete planning aggregates naming, declaration, and path errors", () => {
  const queries = [
    new Query({ filename: "a.b", name: "Class", cmd: ":exec", text: "DELETE" }),
    new Query({ filename: "a_b", name: "URLValue", cmd: ":exec", text: "DELETE" }),
    new Query({ filename: "a_b", name: "UrlValue", cmd: ":exec", text: "DELETE" }),
    new Query({
      filename: "bad/../name.sql",
      name: "Bad-Name",
      cmd: ":many",
      text: "SELECT",
      columns: [column("bad-name")],
    }),
  ];
  assert.throws(
    () => planEmission(validateGenerateRequest(request(queries))),
    (error) => {
      assert.ok(error instanceof GenerationDiagnosticError);
      const reasons = error.diagnostics.map((diagnostic) => diagnostic.reason);
      for (const reason of [
        "OUTPUT_PATH_COLLISION",
        "RESERVED_DECLARATION",
        "DECLARATION_COLLISION",
        "INVALID_OUTPUT_PATH",
        "INVALID_QUERY_NAME",
        "INVALID_FIELD_NAME",
      ])
        assert.ok(reasons.includes(reason), reason);
      return true;
    },
  );
});

test("all six ordinary commands plan one opaque descriptor import and complete result types", () => {
  const id = column("id");
  const plan = planEmission(
    validateGenerateRequest(
      request([
        new Query({ filename: "queries.sql", name: "GetOne", cmd: ":one", text: "SELECT", columns: [id] }),
        new Query({
          filename: "queries.sql",
          name: "InsertOne",
          cmd: ":one",
          text: "INSERT RETURNING",
          columns: [id],
          insertIntoTable: identifier("items"),
        }),
        new Query({ filename: "queries.sql", name: "ListMany", cmd: ":many", text: "SELECT", columns: [id] }),
        new Query({ filename: "queries.sql", name: "RunExec", cmd: ":exec", text: "DELETE" }),
        new Query({
          filename: "queries.sql",
          name: "CountExec",
          cmd: ":execrows",
          text: "DELETE RETURNING",
          columns: [id],
        }),
        // An INSERT target is not command semantics: only ":one" splits on it.
        new Query({
          filename: "queries.sql",
          name: "InsertId",
          cmd: ":execlastid",
          text: "INSERT",
          insertIntoTable: identifier("items"),
        }),
        new Query({
          filename: "queries.sql",
          name: "NativeResult",
          cmd: ":execresult",
          text: "DELETE RETURNING",
          columns: [id, id],
        }),
      ]),
    ),
  );
  const module = plan.queryModules[0];
  assert.deepEqual(module.runtimeTypeImports, ["QueryDescriptor"]);
  assert.deepEqual(
    module.queries.map((query) => query.kindLiteral),
    ['"one"', '"one-insert"', '"many"', '"exec"', '"exec-rows"', '"exec-lastid"', '"exec-result"'],
  );
  assert.deepEqual(
    module.queries.map((query) => query.factoryReturnType),
    [
      "QueryDescriptor<GetOneRow | null>",
      "QueryDescriptor<InsertOneRow | null>",
      "QueryDescriptor<ListManyRow[]>",
      "QueryDescriptor<void>",
      "QueryDescriptor<number>",
      "QueryDescriptor<number>",
      "QueryDescriptor<D1Result<Record<string, unknown>>>",
    ],
  );

  // Result columns are planned only for row commands; the exec family emits no dead artifacts.
  for (const query of module.queries.slice(3)) {
    assert.deepEqual(query.rowFields, [], query.queryNameLiteral);
    assert.equal(query.rowTypeName, undefined, query.queryNameLiteral);
    assert.equal(query.parserName, undefined, query.queryNameLiteral);
  }
  assert.equal(module.emitsResultContext, true);
});

test("an exec-family module derives no row artifacts, codec import, or result-context alias", () => {
  const plan = planEmission(
    validateGenerateRequest(
      request([
        new Query({
          filename: "exec.sql",
          name: "CountExec",
          cmd: ":execrows",
          text: "DELETE RETURNING",
          columns: [column("id")],
        }),
        new Query({
          filename: "exec.sql",
          name: "NativeResult",
          cmd: ":execresult",
          text: "DELETE RETURNING",
          columns: [column("id")],
        }),
      ]),
    ),
  );
  const module = plan.queryModules[0];
  assert.deepEqual(module.runtimeValueImports, []);
  assert.equal(module.emitsResultContext, false);
});

test("arguments and result columns plan a value kind and executable nullability", () => {
  const plan = planEmission(
    validateGenerateRequest(
      request([
        new Query({
          filename: "queries.sql",
          name: "Mixed",
          cmd: ":one",
          text: "SELECT",
          params: [
            new Parameter({ number: 1, column: typedColumn("count", "INTEGER") }),
            new Parameter({ number: 2, column: typedColumn("ratio", "DECIMAL(10,2)", false) }),
            new Parameter({ number: 3, column: typedColumn("label", "VARCHAR(255)") }),
            new Parameter({ number: 4, column: typedColumn("active", "BOOLEAN", false) }),
            new Parameter({ number: 5, column: typedColumn("payload", "BLOB") }),
            new Parameter({ number: 6, column: typedColumn("settings", "JSON") }),
            new Parameter({ number: 7, column: typedColumn("token", "ULID") }),
          ],
          columns: [typedColumn("id", "INTEGER"), typedColumn("meta", "JSONB", false), typedColumn("opaque", "any")],
        }),
      ]),
    ),
  );
  const query = plan.queryModules[0].queries[0];
  assert.equal(query.queryNameLiteral, '"Mixed"');
  assert.deepEqual(
    query.argumentFields.map((field) => [field.publicName, field.valueKind, field.nullable]),
    [
      ["count", "integer", false],
      ["ratio", "number", true],
      ["label", "text", false],
      ["active", "boolean", true],
      ["payload", "blob", false],
      ["settings", "json", false],
      ["token", "unknown", false],
    ],
  );
  assert.deepEqual(
    query.rowFields.map((field) => [
      field.publicName,
      field.kind === "scalar" ? field.valueKind : "embed",
      field.kind === "scalar" && field.nullable,
    ]),
    [
      ["id", "integer", false],
      ["meta", "json", true],
      ["opaque", "unknown", false],
    ],
  );

  // An ordinary result column maps one physical key to one public property, and names
  // itself in runtime failures.
  for (const field of query.rowFields) {
    assert.equal(field.kind, "scalar");
    if (field.kind !== "scalar") continue;
    assert.equal(field.pathLiteral, field.publicNameLiteral);
    assert.equal(field.physicalKey, field.column.name);
  }
  assert.deepEqual(plan.queryModules[0].runtimeTypeImports, ["QueryDescriptor", "D1NonNullValue", "JsonValue"]);
});

test("a repeated bind number plans one property and one bind slot", () => {
  const repeated = typedColumn("id", "INTEGER");
  const plan = planEmission(
    validateGenerateRequest(
      request([
        new Query({
          filename: "queries.sql",
          name: "Repeated",
          cmd: ":exec",
          text: "DELETE FROM users WHERE id = ?1 AND owner_id = ?1 AND name = ?2",
          params: [
            new Parameter({ number: 1, column: repeated }),
            new Parameter({ number: 1, column: repeated }),
            new Parameter({ number: 2, column: typedColumn("name", "TEXT") }),
          ],
        }),
      ]),
    ),
  );
  const query = plan.queryModules[0].queries[0];
  assert.deepEqual(
    query.argumentFields.map((field) => [field.publicName, field.bindNumber, field.firstParameterIndex]),
    [
      ["id", 1, 0],
      ["name", 2, 2],
    ],
  );
});

test("slice parameters plan a marker literal and a collision-proof local binding", () => {
  const slice = (name: string, typeName: string, notNull = true) =>
    new Column({ name, type: identifier(typeName), notNull, isNamedParam: true, isSqlcSlice: true });
  const plan = planEmission(
    validateGenerateRequest(
      request([
        new Query({
          filename: "queries.sql",
          name: "Search",
          cmd: ":exec",
          text: "DELETE FROM feeds WHERE user_id = ? AND id IN (/*SLICE:ids*/?) AND tag IN (/*SLICE:tags*/?)",
          params: [
            new Parameter({ number: 1, column: typedColumn("user_id", "TEXT") }),
            new Parameter({ number: 2, column: slice("ids", "INTEGER") }),
            new Parameter({ number: 3, column: slice("tags", "JSON", false) }),
          ],
        }),
      ]),
    ),
  );
  const query = plan.queryModules[0].queries[0];
  assert.deepEqual(
    query.argumentFields.map((field) => [field.publicName, field.slice?.markerLiteral, field.slice?.localName]),
    [
      ["userId", undefined, undefined],
      ["ids", '"/*SLICE:ids*/?"', "d1_slice_ids"],
      ["tags", '"/*SLICE:tags*/?"', "d1_slice_tags"],
    ],
  );
  for (const field of query.argumentFields) {
    if (field.slice) assert.equal(field.slice.localName, `${SLICE_LOCAL_PREFIX}${field.publicName}`);
  }
  // A slice element type needs the same runtime import a scalar of that kind would.
  assert.deepEqual(plan.queryModules[0].runtimeTypeImports, ["QueryDescriptor", "JsonValue"]);
});

test("modules select the runtime value import and the result-context alias only when used", () => {
  const plan = planEmission(
    validateGenerateRequest(
      request([
        new Query({ filename: "plain.sql", name: "ClearOne", cmd: ":exec", text: "DELETE FROM one;" }),
        new Query({ filename: "plain.sql", name: "ClearTwo", cmd: ":exec", text: "DELETE FROM two;" }),
        new Query({
          filename: "args.sql",
          name: "Touch",
          cmd: ":exec",
          text: "UPDATE one SET a = ?;",
          params: [new Parameter({ number: 1, column: typedColumn("a", "TEXT") })],
        }),
        new Query({
          filename: "rows.sql",
          name: "GetOne",
          cmd: ":one",
          text: "SELECT",
          columns: [typedColumn("id", "INTEGER")],
        }),
      ]),
    ),
  );
  const byPath = new Map(plan.queryModules.map((module) => [module.outputPath, module]));
  assert.deepEqual(byPath.get("plain_sql.ts")!.runtimeValueImports, []);
  assert.equal(byPath.get("plain_sql.ts")!.emitsResultContext, false);
  assert.deepEqual(byPath.get("args_sql.ts")!.runtimeValueImports, ["generatedInternals"]);
  assert.equal(byPath.get("args_sql.ts")!.emitsResultContext, false);
  assert.deepEqual(byPath.get("rows_sql.ts")!.runtimeValueImports, ["generatedInternals"]);
  assert.equal(byPath.get("rows_sql.ts")!.emitsResultContext, true);
});

test("emitted helper bindings are collision-proof against every query-derived symbol", () => {
  // The helper bindings are registered with the collision checker as defense in depth,
  // but they are underscore-bearing while every query-derived binding is alphanumeric.
  for (const identifier of [RUNTIME_VALUE_ALIAS, RESULT_CONTEXT_ALIAS, SLICE_LOCAL_PREFIX]) {
    assert.match(identifier, /_/, identifier);
  }

  const plan = planEmission(
    validateGenerateRequest(
      request([
        new Query({
          filename: "queries.sql",
          name: "GetURL2",
          cmd: ":one",
          text: "SELECT",
          params: [new Parameter({ number: 1, column: typedColumn("id", "INTEGER") })],
          columns: [typedColumn("id", "INTEGER")],
        }),
      ]),
    ),
  );
  const query = plan.queryModules[0].queries[0];
  for (const identifier of [
    query.factoryName,
    query.sqlConstantName,
    query.argsTypeName!,
    query.rowTypeName!,
    query.parserName!,
  ]) {
    assert.match(identifier, /^[A-Za-z0-9]+$/, identifier);
  }
});

test("runtime type imports contain exactly the names the module uses", () => {
  const planFor = (params: Parameter[]) =>
    planEmission(
      validateGenerateRequest(
        request([new Query({ filename: "queries.sql", name: "Run", cmd: ":exec", text: "DELETE", params })]),
      ),
    ).queryModules[0].runtimeTypeImports;
  assert.deepEqual(planFor([]), ["QueryDescriptor"]);
  assert.deepEqual(planFor([new Parameter({ number: 1, column: typedColumn("id", "INTEGER") })]), ["QueryDescriptor"]);
  assert.deepEqual(planFor([new Parameter({ number: 1, column: typedColumn("token", "ULID", false) })]), [
    "QueryDescriptor",
    "D1Value",
  ]);
  assert.deepEqual(
    planFor([
      new Parameter({ number: 1, column: typedColumn("token", "ULID") }),
      new Parameter({ number: 2, column: typedColumn("other", "ULID", false) }),
      new Parameter({ number: 3, column: typedColumn("settings", "JSON") }),
    ]),
    ["QueryDescriptor", "D1NonNullValue", "D1Value", "JsonValue"],
  );
});

test("embeds plan nested fields, private aliases, and a rewritten projection", () => {
  const text =
    "SELECT users.id, users.name, posts.id, posts.user_id, posts.title FROM users JOIN posts ON posts.user_id = users.id";
  const plan = planEmbedded(embedCatalog, [
    new Query({
      filename: "queries.sql",
      name: "UserAndPost",
      cmd: ":one",
      text,
      columns: [embedColumn("users"), embedColumn("posts")],
    }),
  ]);
  const query = plan.queryModules[0].queries[0];

  // One embed is one row field, so a module of embeds still needs the codec import.
  assert.equal(query.rowFields.length, 2);
  assert.deepEqual(
    query.rowFields.map((field) => [field.kind, field.publicName]),
    [
      ["embed", "users"],
      ["embed", "posts"],
    ],
  );
  assert.equal(plan.queryModules[0].emitsResultContext, true);
  assert.deepEqual(plan.queryModules[0].runtimeValueImports, ["generatedInternals"]);

  const [users, posts] = query.rowFields;
  assert.equal(users.kind, "embed");
  assert.equal(posts.kind, "embed");
  if (users.kind !== "embed" || posts.kind !== "embed") return;
  assert.deepEqual(
    users.fields.map((field) => [
      field.publicName,
      field.physicalKey,
      field.pathLiteral,
      field.valueKind,
      field.nullable,
    ]),
    [
      ["id", "d1_embed_0_0", '"users.id"', "integer", false],
      ["name", "d1_embed_0_1", '"users.name"', "text", false],
    ],
  );
  assert.deepEqual(
    posts.fields.map((field) => [
      field.publicName,
      field.physicalKey,
      field.pathLiteral,
      field.valueKind,
      field.nullable,
    ]),
    [
      ["id", "d1_embed_1_0", '"posts.id"', "integer", false],
      ["userId", "d1_embed_1_1", '"posts.userId"', "integer", false],
      // Embedded fields take their nullability from the catalog, exactly like ordinary ones.
      ["title", "d1_embed_1_2", '"posts.title"', "text", true],
    ],
  );

  // The descriptor's SQL is sqlc's own text plus one alias per embedded column.
  const sql = JSON.parse(query.sqlLiteral) as string;
  assert.equal(
    sql,
    'SELECT users.id AS "d1_embed_0_0", users.name AS "d1_embed_0_1", posts.id AS "d1_embed_1_0", posts.user_id AS "d1_embed_1_1", posts.title AS "d1_embed_1_2" FROM users JOIN posts ON posts.user_id = users.id',
  );
  assert.equal(sql.replace(/ AS "[^"]*"/g, ""), text);
});

test("nested public names share the row allocator and allocate their own fields", () => {
  const plan = planEmbedded(embedCatalog, [
    // An ordinary column named "users" and an embed of "users" are two properties.
    new Query({
      filename: "queries.sql",
      name: "Collide",
      cmd: ":one",
      text: "SELECT users.name AS users, users.id, users.name FROM users",
      columns: [column("users"), embedColumn("users")],
    }),
    // Two catalog columns that normalize to one public name are suffixed inside the embed.
    new Query({
      filename: "queries.sql",
      name: "Nested",
      cmd: ":one",
      text: "SELECT odd.foo_bar, odd.fooBar FROM odd",
      columns: [embedColumn("odd")],
    }),
    // A projected column literally named like an alias pushes allocation one step on.
    new Query({
      filename: "queries.sql",
      name: "AliasCollision",
      cmd: ":one",
      text: "SELECT x.d1_embed_0_0, users.id, users.name FROM x JOIN users ON x.id = users.id",
      columns: [column("d1_embed_0_0"), embedColumn("users")],
    }),
  ]);
  const [collide, nested, aliasCollision] = plan.queryModules[0].queries;
  assert.deepEqual(
    collide.rowFields.map((field) => field.publicName),
    ["users", "users_2"],
  );
  const embedFields = (query: typeof collide, index: number) => {
    const field = query.rowFields[index];
    assert.equal(field.kind, "embed");
    return field.kind === "embed" ? field.fields : [];
  };
  assert.deepEqual(
    embedFields(nested, 0).map((field) => [field.publicName, field.physicalKey]),
    [
      ["fooBar", "d1_embed_0_0"],
      ["fooBar_2", "d1_embed_0_1"],
    ],
  );
  assert.deepEqual(
    embedFields(aliasCollision, 1).map((field) => field.physicalKey),
    ["d1_embed_0_0_2", "d1_embed_0_1"],
  );
  assert.equal(
    JSON.parse(aliasCollision.sqlLiteral),
    'SELECT x.d1_embed_0_0, users.id AS "d1_embed_0_0_2", users.name AS "d1_embed_0_1" FROM x JOIN users ON x.id = users.id',
  );
});

test("two embeds of one table are counted together however each spelled its schema", () => {
  // Resolution applies the catalog's default schema, so grouping the located expansions
  // must apply it too, or one table's two expansions look like two tables' one each.
  const plan = planEmbedded(embedCatalog, [
    new Query({
      filename: "queries.sql",
      name: "SelfJoin",
      cmd: ":many",
      text: "SELECT a.id, a.name, b.id, b.name FROM users a JOIN users b ON b.id = a.id",
      columns: [
        new Column({ name: "users", embedTable: identifier("users") }),
        new Column({ name: "users", embedTable: new Identifier({ name: "users", schema: "main" }) }),
      ],
    }),
  ]);
  const query = plan.queryModules[0].queries[0];
  assert.deepEqual(
    query.rowFields.map((field) => field.publicName),
    ["users", "users_2"],
  );
  assert.equal(
    JSON.parse(query.sqlLiteral),
    'SELECT a.id AS "d1_embed_0_0", a.name AS "d1_embed_0_1", b.id AS "d1_embed_1_0", b.name AS "d1_embed_1_1" FROM users a JOIN users b ON b.id = a.id',
  );
});

test("embed metadata that cannot be planned fails generation instead of guessing", () => {
  const fails = (query: Query, catalog = embedCatalog): string[] => {
    try {
      planEmbedded(catalog, [query]);
      return [];
    } catch (error) {
      assert.ok(error instanceof GenerationDiagnosticError);
      return error.diagnostics.map(({ reason }) => reason);
    }
  };
  const embedQuery = (data: Partial<Query>) =>
    new Query({
      filename: "queries.sql",
      name: "Embedded",
      cmd: ":one",
      text: "SELECT users.id, users.name FROM users",
      columns: [embedColumn("users")],
      ...data,
    });

  assert.deepEqual(fails(embedQuery({ columns: [embedColumn("absent")] })), ["UNKNOWN_EMBED_TABLE"]);
  assert.deepEqual(fails(embedQuery({}), new Catalog()), ["UNKNOWN_EMBED_TABLE"]);

  // A request that ships no catalog at all resolves nothing, and says so once.
  assert.throws(
    () =>
      planEmission({
        request: new GenerateRequest({
          settings: new Settings({ engine: "sqlite" }),
          sqlcVersion: "v1.31.1",
          queries: [embedQuery({})],
        }),
        options: { interface: "workers" },
        warnings: [],
      }),
    (error) => {
      assert.ok(error instanceof GenerationDiagnosticError);
      assert.deepEqual(
        error.diagnostics.map(({ reason }) => reason),
        ["UNKNOWN_EMBED_TABLE"],
      );
      return true;
    },
  );
  assert.deepEqual(
    fails(
      embedQuery({}),
      new Catalog({
        defaultSchema: "main",
        schemas: [new Schema({ name: "main", tables: [catalogTable("users", [])] })],
      }),
    ),
    ["EMPTY_EMBED_TABLE"],
  );

  assert.deepEqual(
    fails(
      embedQuery({}),
      new Catalog({
        defaultSchema: "main",
        schemas: [new Schema({ name: "main", tables: [catalogTable("users", [column("id"), column("id")])] })],
      }),
    ),
    ["DUPLICATE_EMBED_COLUMN"],
  );

  assert.deepEqual(
    fails(
      embedQuery({}),
      new Catalog({
        defaultSchema: "main",
        schemas: [new Schema({ name: "main", tables: [catalogTable("users", [column("my col")])] })],
      }),
    ),
    ["INVALID_FIELD_NAME"],
  );

  // The same expansion twice cannot be told apart, so it is refused rather than aliased.
  assert.deepEqual(fails(embedQuery({ text: "SELECT users.id, users.name, users.id, users.name FROM users" })), [
    "AMBIGUOUS_EMBED_PROJECTION",
  ]);
  // Text that does not contain the expansion at all is the same kind of disagreement.
  assert.deepEqual(fails(embedQuery({ text: "SELECT * FROM users" })), ["AMBIGUOUS_EMBED_PROJECTION"]);
  // A metadata failure suppresses the location attempt that depends on it.
  assert.deepEqual(fails(embedQuery({ text: "SELECT * FROM absent", columns: [embedColumn("absent")] })), [
    "UNKNOWN_EMBED_TABLE",
  ]);
  // An embed whose own name cannot become a public property fails the same way: the table
  // name is not something a SQL alias can fix, and the projection is not located either.
  const unsafeEmbed = new Column({ name: "my table", embedTable: identifier("users") });
  assert.deepEqual(fails(embedQuery({ text: "SELECT * FROM users", columns: [unsafeEmbed] })), ["INVALID_FIELD_NAME"]);
  assert.deepEqual(fails(embedQuery({ columns: [unsafeEmbed] })), ["INVALID_FIELD_NAME"]);
});

test("valid planning preserves request order within sorted modules and exact SQL", () => {
  const sql = "SELECT '` ${x}'\n\u2028";
  const plan = planEmission(
    validateGenerateRequest(
      request([
        new Query({ filename: "z.sql", name: "GetURL", cmd: ":one", text: sql, columns: [column("USER_ID")] }),
        new Query({ filename: "a/users.sql", name: "DeleteAll", cmd: ":exec", text: "DELETE" }),
      ]),
    ),
  );
  assert.deepEqual(
    plan.queryModules.map((module) => module.outputPath),
    ["a/users_sql.ts", "z_sql.ts"],
  );
  assert.equal(JSON.parse(plan.queryModules[1].queries[0].sqlLiteral), sql);
  assert.deepEqual(plan.queryModules[1].runtimeTypeImports, ["QueryDescriptor"]);
  assert.equal(plan.queryModules[1].queries[0].factoryReturnType, "QueryDescriptor<GetURLRow | null>");
  assert.equal(plan.queryModules[0].queries[0].factoryReturnType, "QueryDescriptor<void>");
  assert.equal(plan.queryModules[0].runtimeSpecifierLiteral, '"../runtime"');
});
