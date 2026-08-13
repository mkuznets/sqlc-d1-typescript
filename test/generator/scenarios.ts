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
import { DEFAULT_FAKE_META, FakeExecutor, loadGeneratedModules } from "./evaluate";

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
    // Row validation is unconditional: no toggle, no opt-out, no fast path.
    assert.doesNotMatch(runtime, /skipValidation|disableValidation|validateRows|unchecked|fastPath|process\.env/i);
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

// All six ordinary commands in one module. The exec-family queries deliberately carry
// arguments and result columns, including a repeated physical key, because none of that
// may reach the emitted module.
export function createCommandsRequest(): GenerateRequest {
  const id = column("id", "integer");
  const title = column("title", "text");
  const userId = column("user_id", "text");
  const feeds = new Identifier({ name: "feeds" });
  return validRequest({
    queries: [
      new Query({ filename: "queries.sql", name: "GetFeed", cmd: ":one", text: "SELECT id, title FROM feeds WHERE id = ?;", params: [parameter(1, id)], columns: [id, title] }),
      new Query({ filename: "queries.sql", name: "CreateFeed", cmd: ":one", text: "INSERT INTO feeds (title) VALUES (?) RETURNING id, title;", params: [parameter(1, title)], columns: [id, title], insertIntoTable: feeds }),
      new Query({ filename: "queries.sql", name: "ListFeeds", cmd: ":many", text: "SELECT id, title FROM feeds;", columns: [id, title] }),
      new Query({ filename: "queries.sql", name: "TouchFeed", cmd: ":exec", text: "UPDATE feeds SET title = ? WHERE id = ?;", params: [parameter(1, title), parameter(2, id)] }),
      new Query({ filename: "queries.sql", name: "DeleteFeedsByUser", cmd: ":execrows", text: "DELETE FROM feeds WHERE user_id = ? RETURNING id, id;", params: [parameter(1, userId)], columns: [id, id] }),
      // An INSERT target never turns a metadata command into a row command.
      new Query({ filename: "queries.sql", name: "InsertFeedId", cmd: ":execlastid", text: "INSERT INTO feeds (title) VALUES (?);", params: [parameter(1, title)], insertIntoTable: feeds }),
      new Query({ filename: "queries.sql", name: "PurgeFeeds", cmd: ":execresult", text: "DELETE FROM feeds WHERE user_id = ? RETURNING *;", params: [parameter(1, userId)], columns: [id, id, title] }),
      new Query({ filename: "bare.sql", name: "PurgeAll", cmd: ":execresult", text: "DELETE FROM feeds;", columns: [id] }),
      new Query({ filename: "bare.sql", name: "CountAll", cmd: ":execrows", text: "DELETE FROM audit;" }),
    ],
  });
}

const commandsConsumer = `import { DB } from "./runtime";
import {
  getFeed,
  createFeed,
  listFeeds,
  touchFeed,
  deleteFeedsByUser,
  insertFeedId,
  purgeFeeds,
  type GetFeedRow,
  type CreateFeedRow,
  type ListFeedsRow,
} from "./queries_sql";
import { purgeAll, countAll } from "./bare_sql";
// @ts-expect-error the exec family maps no rows, so it declares no row type
import type { DeleteFeedsByUserRow } from "./queries_sql";
// @ts-expect-error the exec family maps no rows, so it declares no row type
import type { PurgeFeedsRow } from "./queries_sql";

declare const binding: D1Database;
const db = new DB(binding);
const one: Promise<GetFeedRow | null> = db.execute(getFeed({ id: 1 }));
const inserted: Promise<CreateFeedRow | null> = db.execute(createFeed({ title: "Feed" }));
const many: Promise<ListFeedsRow[]> = db.execute(listFeeds());
const nothing: Promise<void> = db.execute(touchFeed({ title: "Feed", id: 1 }));
const changed: Promise<number> = db.execute(deleteFeedsByUser({ userId: "user_1" }));
const lastId: Promise<number> = db.execute(insertFeedId({ title: "Feed" }));
const native: Promise<D1Result<Record<string, unknown>>> = db.execute(purgeFeeds({ userId: "user_1" }));
const bareNative: Promise<D1Result<Record<string, unknown>>> = db.execute(purgeAll());
const bareChanged: Promise<number> = db.execute(countAll());
void [one, inserted, many, nothing, changed, lastId, native, bareNative, bareChanged];

const tuple: Promise<[
  GetFeedRow | null,
  CreateFeedRow | null,
  ListFeedsRow[],
  void,
  number,
  number,
  D1Result<Record<string, unknown>>,
]> = db.batch(
  getFeed({ id: 1 }),
  createFeed({ title: "Feed" }),
  listFeeds(),
  touchFeed({ title: "Feed", id: 1 }),
  deleteFeedsByUser({ userId: "user_1" }),
  insertFeedId({ title: "Feed" }),
  purgeFeeds({ userId: "user_1" }),
);
void tuple;

async function readsNativeResult(): Promise<void> {
  const result = await db.execute(purgeFeeds({ userId: "user_1" }));
  const rows: Record<string, unknown>[] = result.results;
  const success: boolean = result.success;
  const changes: number = result.meta.changes;
  const lastRowId: number = result.meta.last_row_id;
  void [rows, success, changes, lastRowId];
  // @ts-expect-error the native result is not a row count
  const asNumber: number = await db.execute(purgeFeeds({ userId: "user_1" }));
  // @ts-expect-error a row count is not the native result
  const asResult: D1Result<Record<string, unknown>> = await db.execute(deleteFeedsByUser({ userId: "user_1" }));
  void [asNumber, asResult];
}
void readsNativeResult;
`;

const commandSemantics: GeneratorScenario = {
  id: "generator/command-semantics",
  createInput: () => queryInput(createCommandsRequest()),
  assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.equal(outcome.diagnostics, "");
    assert.ok(outcome.response);
    const response = outcome.response;
    assert.deepEqual(response.files.map((file) => file.name), ["runtime.ts", "bare_sql.ts", "queries_sql.ts"]);
    const sources = new Map(response.files.map((file) => [file.name, new TextDecoder().decode(file.contents)]));
    const queries = sources.get("queries_sql.ts")!;
    const bare = sources.get("bare_sql.ts")!;

    const expected = readFileSync(resolve(process.cwd(), "test/generator/goldens/commands-output.ts.txt"), "utf8");
    assert.equal(queries, expected);

    for (const [factory, kind, result] of [
      ["deleteFeedsByUser", "exec-rows", "number"],
      ["insertFeedId", "exec-lastid", "number"],
      ["purgeFeeds", "exec-result", "D1Result<Record<string, unknown>>"],
    ] as const) {
      assert.match(queries, new RegExp(`export function ${factory}\\(args: \\w+\\): QueryDescriptor<${escapeRegExp(result)}> \\{`), factory);
      assert.match(queries, new RegExp(`kind: "${kind}"`), kind);
    }
    // No dead row artifacts survive for the exec family, even though it carries columns.
    for (const name of ["DeleteFeedsByUser", "InsertFeedId", "PurgeFeeds", "TouchFeed", "PurgeAll", "CountAll"]) {
      for (const source of [queries, bare]) {
        assert.doesNotMatch(source, new RegExp(`interface ${name}Row\\b`), name);
        assert.doesNotMatch(source, new RegExp(`parse${name}Row\\b`), name);
      }
    }
    // Only row commands attach a parser to their descriptor.
    assert.equal((queries.match(/parse: parse\w+Row/g) ?? []).length, 3);

    // The row commands in this module still need the codec import and the context alias;
    // an exec-family-only module needs neither.
    assert.match(queries, /^import \{ generatedInternals as d1_values \} from "\.\/runtime";$/m);
    assert.match(queries, /^type d1_Context = /m);
    assert.doesNotMatch(bare, /generatedInternals|d1_values|d1_Context/);
    assert.match(bare, /^import type \{ QueryDescriptor \} from "\.\/runtime";$/m);

    for (const compiler of ["typescript-5-2", "typescript"] as const) {
      compileGeneratedResponse(response, { compiler, additionalFiles: { "consumer.ts": commandsConsumer } });
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

// The one feature that is still unimplemented must keep failing closed, loudly and
// without being mistaken for an unsupported command.
const emissionReadiness: GeneratorScenario = {
  id: "generator/emission-readiness",
  createInput: () => queryInput(validRequest({ queries: [
    new Query({
      filename: "queries.sql",
      name: "GetUserWithProfile",
      cmd: ":one",
      text: "SELECT users.*, profiles.* FROM users JOIN profiles ON profiles.user_id = users.id",
      columns: [new Column({ name: "profile", embedTable: new Identifier({ name: "profiles" }) })],
    }),
  ] })),
  assert(outcome) {
    assertFailure(outcome);
    assert.match(outcome.diagnostics, /\[EMISSION\/UNIMPLEMENTED_EMBED\]/);
    assert.doesNotMatch(outcome.diagnostics, /UNIMPLEMENTED_SLICE/);
    assert.doesNotMatch(outcome.diagnostics, /\[QUERY\/UNSUPPORTED_COMMAND\]/);
    assert.doesNotMatch(outcome.diagnostics, /UNIMPLEMENTED_COMMAND/);
    assert.doesNotMatch(outcome.diagnostics, /SELECT users/);
  },
};

const namedColumn = (name: string, typeName = "integer", notNull = true) =>
  new Column({ name, type: type(typeName), notNull, isNamedParam: true });
const sliceColumn = (name: string, typeName = "integer", notNull = true) =>
  new Column({ name, type: type(typeName), notNull, isNamedParam: true, isSqlcSlice: true });

// The whole argument model in one module: named, repeated, nullable, and slice arguments
// across every command, with the metadata shapes real sqlc emits for each macro.
export function createArgumentsRequest(): GenerateRequest {
  const id = column("id", "integer");
  const title = column("title", "text");
  const tagged = new Identifier({ name: "tagged" });
  return validRequest({
    queries: [
      // One Parameter for two occurrences of ?1: one property, one bind slot.
      new Query({
        filename: "queries.sql", name: "GetUserByName", cmd: ":one",
        text: "SELECT id, name FROM users WHERE name = ?1 AND nickname = ?1;",
        params: [parameter(1, namedColumn("name", "text"))],
        columns: [id, column("name", "text")],
      }),
      // sqlc.narg differs from sqlc.arg only by not_null.
      new Query({
        filename: "queries.sql", name: "SearchByNickname", cmd: ":many",
        text: "SELECT id, name FROM users WHERE nickname = ?1;",
        params: [parameter(1, namedColumn("nick", "text", false))],
        columns: [id, column("name", "text")],
      }),
      new Query({
        filename: "queries.sql", name: "DeleteUsersByIds", cmd: ":execrows",
        text: "DELETE FROM users WHERE id IN (/*SLICE:ids*/?);",
        params: [parameter(1, sliceColumn("ids", "integer"))],
      }),
      // params is text order; the bind numbers a slice query carries are not that order.
      new Query({
        filename: "queries.sql", name: "SearchFeeds", cmd: ":many",
        text: "SELECT id, title FROM feeds WHERE user_id = ? AND id IN (/*SLICE:ids*/?) LIMIT ?;",
        params: [
          parameter(1, column("user_id", "text")),
          parameter(3, sliceColumn("ids", "text")),
          parameter(2, column("limit", "integer")),
        ],
        columns: [id, title],
      }),
      new Query({
        filename: "queries.sql", name: "PurgeByTags", cmd: ":execresult",
        text: "DELETE FROM feeds WHERE tag IN (/*SLICE:tags*/?) OR label IN (/*SLICE:labels*/?) RETURNING *;",
        params: [parameter(1, sliceColumn("tags", "text")), parameter(2, sliceColumn("labels", "text"))],
      }),
      new Query({
        filename: "queries.sql", name: "TouchAll", cmd: ":exec",
        text: "UPDATE feeds SET title = ? WHERE id IN (/*SLICE:ids*/?);",
        params: [parameter(1, column("title", "text")), parameter(2, sliceColumn("ids", "integer"))],
      }),
      new Query({
        filename: "queries.sql", name: "InsertTagged", cmd: ":execlastid",
        text: "INSERT INTO tagged (tag) SELECT tag FROM tags WHERE tag IN (/*SLICE:tags*/?);",
        params: [parameter(1, sliceColumn("tags", "text"))],
        insertIntoTable: tagged,
      }),
      new Query({
        filename: "queries.sql", name: "CreateTagged", cmd: ":one",
        text: "INSERT INTO tagged (tag) SELECT tag FROM tags WHERE tag IN (/*SLICE:tags*/?) RETURNING id, title;",
        params: [parameter(1, sliceColumn("tags", "text"))],
        columns: [id, title],
        insertIntoTable: tagged,
      }),
      // Distinct normalized names stay independently expressible.
      new Query({
        filename: "queries.sql", name: "MixedNames", cmd: ":one",
        text: "SELECT id FROM users WHERE user_id = ?1 AND owner = ?2;",
        params: [parameter(1, namedColumn("user_id", "text")), parameter(2, namedColumn("userID", "text"))],
        columns: [id],
      }),
      // One slice per non-scalar value kind, plus a nullable element type.
      new Query({
        filename: "queries.sql", name: "MatchValues", cmd: ":many",
        text: "SELECT id FROM samples WHERE payload IN (/*SLICE:payloads*/?) AND settings IN (/*SLICE:settings*/?) AND token IN (/*SLICE:tokens*/?) AND label IN (/*SLICE:labels*/?);",
        params: [
          parameter(1, sliceColumn("payloads", "BLOB")),
          parameter(2, sliceColumn("settings", "JSON")),
          parameter(3, sliceColumn("tokens", "ULID")),
          parameter(4, sliceColumn("labels", "TEXT", false)),
        ],
        columns: [id],
      }),
    ],
  });
}

const argumentsConsumer = `import { DB, type D1NonNullValue, type JsonValue } from "./runtime";
import {
  getUserByName,
  searchByNickname,
  deleteUsersByIds,
  searchFeeds,
  purgeByTags,
  touchAll,
  insertTagged,
  createTagged,
  mixedNames,
  matchValues,
  type GetUserByNameArgs,
  type GetUserByNameRow,
  type SearchByNicknameArgs,
  type SearchFeedsArgs,
  type SearchFeedsRow,
  type MatchValuesArgs,
  type MixedNamesArgs,
} from "./queries_sql";

declare const binding: D1Database;
const db = new DB(binding);

// One property for two occurrences of ?1, and a required nullable property for a narg.
const named: GetUserByNameArgs = { name: "Ada" };
const nullable: SearchByNicknameArgs = { nick: null };
const withNickname: SearchByNicknameArgs = { nick: "ada" };
void [named, nullable, withNickname];

// Distinct normalized names stay two independent properties.
const mixed: MixedNamesArgs = { userId: "u1", userId_2: "u2" };
void mixed;

// A slice accepts a mutable array and a readonly one alike.
const mutableIds: number[] = [1, 2, 3];
const readonlyIds: readonly number[] = [1, 2, 3];
void db.execute(deleteUsersByIds({ ids: mutableIds }));
void db.execute(deleteUsersByIds({ ids: readonlyIds }));

const page: SearchFeedsArgs = { userId: "u1", ids: ["a", "b"], limit: 10 };
const rows: Promise<SearchFeedsRow[]> = db.execute(searchFeeds(page));
const one: Promise<GetUserByNameRow | null> = db.execute(getUserByName(named));
const removed: Promise<number> = db.execute(deleteUsersByIds({ ids: [1] }));
const nothing: Promise<void> = db.execute(touchAll({ title: "t", ids: [1] }));
const lastId: Promise<number> = db.execute(insertTagged({ tags: ["a"] }));
const native: Promise<D1Result<Record<string, unknown>>> = db.execute(purgeByTags({ tags: ["a"], labels: ["b"] }));
void [rows, one, removed, nothing, lastId, native, db.execute(createTagged({ tags: ["a"] })), db.execute(searchByNickname(nullable))];

// Element types are the scalar spellings of the same value kind and nullability.
const values: MatchValuesArgs = {
  payloads: [new Uint8Array([1])],
  settings: [{ nested: [1, "two", null] }],
  tokens: ["opaque", 1, true, new Uint8Array([2])],
  labels: ["label", null],
};
const json: ReadonlyArray<JsonValue> = values.settings;
const opaque: ReadonlyArray<D1NonNullValue> = values.tokens;
const labels: ReadonlyArray<string | null> = values.labels;
void [db.execute(matchValues(values)), json, opaque, labels];

// A narg property is a value that may be null, never an optional property.
// @ts-expect-error a nullable argument does not widen to its base type
const asString: string = nullable.nick;
void asString;
// @ts-expect-error every property is required, and undefined is never a SQL NULL
searchByNickname({});
// @ts-expect-error undefined is not an accepted argument value
searchByNickname({ nick: undefined });
// @ts-expect-error a slice property is required like any other
deleteUsersByIds({});
// @ts-expect-error a slice argument is not a scalar
deleteUsersByIds({ ids: 1 });
// @ts-expect-error slice elements are checked against the element type
deleteUsersByIds({ ids: ["1"] });
// @ts-expect-error a non-null slice rejects a null element
deleteUsersByIds({ ids: [1, null] });
// @ts-expect-error a slice property is not nullable itself
deleteUsersByIds({ ids: null });
// @ts-expect-error the slice snapshot is not a mutable output array
values.labels.push("more");
`;

const argumentModel: GeneratorScenario = {
  id: "generator/argument-model",
  createInput: () => queryInput(createArgumentsRequest()),
  assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.equal(outcome.diagnostics, "");
    assert.ok(outcome.response);
    const response = outcome.response;
    assert.deepEqual(response.files.map((file) => file.name), ["runtime.ts", "queries_sql.ts"]);
    const source = new TextDecoder().decode(response.files[1].contents);

    const expected = readFileSync(resolve(process.cwd(), "test/generator/goldens/arguments-output.ts.txt"), "utf8");
    assert.equal(source, expected);

    // Slice properties are the scalar spelling of their value kind, wrapped once.
    for (const [property, spelling] of [
      ["ids", "ReadonlyArray<number>"],
      ["payloads", "ReadonlyArray<Uint8Array>"],
      ["settings", "ReadonlyArray<JsonValue>"],
      ["tokens", "ReadonlyArray<D1NonNullValue>"],
      ["labels", "ReadonlyArray<string | null>"],
    ] as const) {
      assert.match(source, new RegExp(`^    "${property}": ${escapeRegExp(spelling)};$`, "m"), property);
    }
    assert.match(source, /^import type \{ QueryDescriptor, D1NonNullValue, JsonValue \} from "\.\/runtime";$/m);
    // A nullable argument is a required property whose value may be null.
    assert.match(source, /^    "nick": string \| null;$/m);
    assert.doesNotMatch(source, /^\s+"[A-Za-z0-9_]+"\?: /m);

    // The repeated named argument is one property and one bind expression.
    const getUserByName = /export function getUserByName[\s\S]*?\n\}/.exec(source)![0];
    assert.equal((getUserByName.match(/args\["name"\]/g) ?? []).length, 1);
    assert.match(getUserByName, /params: Object\.freeze\(\[d1_values\.argText\(args\["name"\], "GetUserByName", "name"\)\]\)/);
    assert.match(source, /^export interface GetUserByNameArgs \{\n    "name": string;\n\}$/m);
    assert.match(source, /^    "userId": string;\n    "userId_2": string;$/m);

    // Every slice is snapshotted before the descriptor, and spread at its bind position.
    for (const [factory, marker, local] of [
      ["deleteUsersByIds", "/*SLICE:ids*/?", "d1_slice_ids"],
      ["searchFeeds", "/*SLICE:ids*/?", "d1_slice_ids"],
      ["touchAll", "/*SLICE:ids*/?", "d1_slice_ids"],
    ] as const) {
      const body = new RegExp(`export function ${factory}\\([\\s\\S]*?\\n\\}`).exec(source)![0];
      assert.equal((body.match(new RegExp(`const ${local} = d1_values\\.argSlice\\(`, "g")) ?? []).length, 1, factory);
      assert.ok(body.indexOf(`const ${local} =`) < body.indexOf("return Object.freeze("), factory);
      assert.equal((body.match(new RegExp(escapeRegExp(`...${local}`), "g")) ?? []).length, 1, factory);
      assert.equal((body.match(/d1_values\.expandSlices\(/g) ?? []).length, 1, factory);
      assert.ok(body.includes(marker), factory);
    }
    assert.match(source, /const d1_slice_ids = d1_values\.argSlice\(args\["ids"\], d1_values\.argInteger, "DeleteUsersByIds", "ids"\);/);
    assert.match(source, /params: Object\.freeze\(\[d1_values\.argText\(args\["userId"\], "SearchFeeds", "userId"\), \.\.\.d1_slice_ids, d1_values\.argInteger\(args\["limit"\], "SearchFeeds", "limit"\)\]\)/);
    // Two slices in one query expand together, in text order.
    assert.match(source, /sql: d1_values\.expandSlices\(purgeByTagsQuery, "PurgeByTags", \[\["\/\*SLICE:tags\*\/\?", d1_slice_tags\.length\], \["\/\*SLICE:labels\*\/\?", d1_slice_labels\.length\]\]\)/);
    // Non-slice queries neither expand nor snapshot anything.
    for (const factory of ["getUserByName", "searchByNickname", "mixedNames"]) {
      const body = new RegExp(`export function ${factory}\\([\\s\\S]*?\\n\\}`).exec(source)![0];
      assert.doesNotMatch(body, /expandSlices|argSlice/, factory);
    }
    assert.equal((source.match(/d1_values\.expandSlices\(/g) ?? []).length, 7);
    assert.equal((source.match(/d1_values\.argSlice\(/g) ?? []).length, 11);

    // The SQL constants still hold sqlc's exact text, markers included.
    for (const query of createArgumentsRequest().queries) {
      const factory = query.name.charAt(0).toLowerCase() + query.name.slice(1);
      const literal = new RegExp(`^const ${factory}Query = (.*);$`, "m").exec(source)![1];
      assert.equal(JSON.parse(literal), query.text, query.name);
    }

    for (const compiler of ["typescript-5-2", "typescript"] as const) {
      compileGeneratedResponse(response, { compiler, additionalFiles: { "consumer.ts": argumentsConsumer } });
    }
  },
};

const argumentValues: GeneratorScenario = {
  id: "generator/argument-values",
  createInput: () => queryInput(createArgumentsRequest()),
  async assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.ok(outcome.response);
    const load = loadGeneratedModules(outcome.response);
    const runtime = load("runtime");
    const queries = load("queries_sql");
    const DB = runtime.DB as new (executor: unknown) => {
      execute(query: unknown): Promise<unknown>;
      batch(...queries: unknown[]): Promise<unknown[]>;
    };
    const QueryArgumentError = runtime.QueryArgumentError as new (...args: never[]) => Error;
    type Descriptor = { sql: string; params: readonly unknown[] };
    const factory = (name: string) => queries[name] as (args: Record<string, unknown>) => Descriptor;
    const deleteUsersByIds = factory("deleteUsersByIds");
    const searchFeeds = factory("searchFeeds");
    const purgeByTags = factory("purgeByTags");
    const touchAll = factory("touchAll");
    const insertTagged = factory("insertTagged");
    const createTagged = factory("createTagged");
    const matchValues = factory("matchValues");
    const getUserByName = factory("getUserByName");
    const searchByNickname = factory("searchByNickname");

    // Expansion produces exactly as many placeholders as elements, and touches
    // nothing else in sqlc's text.
    const sqlConstant = "DELETE FROM users WHERE id IN (/*SLICE:ids*/?);";
    for (const count of [1, 3, 25]) {
      const ids = Array.from({ length: count }, (_, index) => index + 1);
      const descriptor = deleteUsersByIds({ ids });
      const placeholders = Array.from({ length: count }, () => "?").join(",");
      assert.equal(descriptor.sql, sqlConstant.replace("/*SLICE:ids*/?", placeholders));
      assert.deepEqual(descriptor.params, ids);
      assert.equal((descriptor.sql.match(/\?/g) ?? []).length, count);
    }

    // Bind values land in text order, with the slice flattened in place.
    const page = searchFeeds({ userId: "user_1", ids: ["a", "b"], limit: 10 });
    assert.deepEqual(page.params, ["user_1", "a", "b", 10]);
    assert.equal(page.sql, "SELECT id, title FROM feeds WHERE user_id = ? AND id IN (?,?) LIMIT ?;");
    const purged = purgeByTags({ tags: ["t1", "t2"], labels: ["l1"] });
    assert.deepEqual(purged.params, ["t1", "t2", "l1"]);
    assert.equal(purged.sql, "DELETE FROM feeds WHERE tag IN (?,?) OR label IN (?) RETURNING *;");

    // A repeated logical argument binds once, matching SQLite's ?N reuse.
    assert.deepEqual(getUserByName({ name: "Ada" }).params, ["Ada"]);
    assert.deepEqual(searchByNickname({ nick: null }).params, [null]);
    assert.deepEqual(searchByNickname({ nick: "ada" }).params, ["ada"]);

    // Construction snapshots the array and every element.
    const ids = [1, 2, 3];
    const snapshot = deleteUsersByIds({ ids });
    ids.push(4);
    ids[0] = 99;
    ids.splice(1, 1);
    assert.deepEqual(snapshot.params, [1, 2, 3]);
    const payload = new Uint8Array([1, 2, 3]);
    const settings = { nested: [1, "two"] as unknown[] };
    const values = matchValues({ payloads: [payload], settings: [settings], tokens: ["opaque"], labels: [null] });
    payload[0] = 99;
    settings.nested[0] = 42;
    assert.deepEqual(values.params[0], new Uint8Array([1, 2, 3]));
    assert.notEqual(values.params[0], payload);
    // Elements convert exactly as the scalar codec of their value kind would.
    assert.equal(values.params[1], JSON.stringify({ nested: [1, "two"] }));
    assert.equal(values.params[2], "opaque");
    assert.equal(values.params[3], null);
    assert.deepEqual(
      matchValues({ payloads: [new Uint8Array([7])], settings: [null, [1], "s"], tokens: [true, 1.5, "t"], labels: ["l", null] }).params.slice(1),
      ["null", "[1]", '"s"', true, 1.5, "t", "l", null],
    );

    const rejects = (
      construct: () => unknown,
      expectations: { path: string; expected: string; received: string },
    ): void => {
      const executor = new FakeExecutor();
      let caught: unknown;
      try {
        void new DB(executor).execute(construct());
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof QueryArgumentError, `${expectations.path} ${expectations.received}`);
      const checked = caught as unknown as CheckedError;
      assert.equal(checked.name, "QueryArgumentError");
      assert.equal(checked.operation, "construct");
      assert.equal(checked.path, expectations.path);
      assert.equal(checked.expected, expectations.expected);
      assert.equal(checked.received, expectations.received);
      // The factory threw while its result was still being evaluated as an argument.
      assert.equal(executor.bound.length, 0);
    };

    // An empty slice is rejected synchronously: no NULL substitution, no D1 call.
    rejects(() => deleteUsersByIds({ ids: [] }), { path: "ids", expected: "a non-empty array", received: "an empty array" });
    rejects(() => searchFeeds({ userId: "u", ids: [], limit: 1 }), { path: "ids", expected: "a non-empty array", received: "an empty array" });
    const batchExecutor = new FakeExecutor();
    let batchCaught: unknown;
    try {
      void new DB(batchExecutor).batch(touchAll({ title: "t", ids: [1] }), deleteUsersByIds({ ids: [] }), insertTagged({ tags: ["a"] }));
    } catch (error) {
      batchCaught = error;
    }
    assert.ok(batchCaught instanceof QueryArgumentError);
    assert.equal((batchCaught as unknown as CheckedError).operation, "construct");
    assert.equal(batchExecutor.bound.length, 0);

    for (const [value, received] of [
      [null, "null"], [undefined, "undefined"], ["abc", "string"], [7, "number"],
      [new Uint8Array([1]), "Uint8Array"], [{ length: 2 }, "object"],
    ] as const) {
      rejects(() => deleteUsersByIds({ ids: value }), { path: "ids", expected: "a non-empty array", received });
    }
    rejects(() => deleteUsersByIds({ ids: [1, 2, "three"] }), { path: "ids[2]", expected: "a safe integer", received: "string" });
    rejects(() => matchValues({ payloads: [new Uint8Array()], settings: [1], tokens: ["t"], labels: [1] }), {
      path: "labels[0]", expected: "a string or null", received: "number",
    });

    // Every command executes a slice descriptor and resolves its decided result.
    const executeWith = async (query: unknown, rows: unknown[] = []): Promise<{ executor: FakeExecutor; result: unknown }> => {
      const executor = new FakeExecutor();
      executor.rows = rows;
      executor.meta = { changes: 3, last_row_id: 77 };
      return { executor, result: await new DB(executor).execute(query) };
    };
    const feedRow = (id: number): Record<string, unknown> => ({ id, title: `Feed ${id}` });

    assert.equal((await executeWith(deleteUsersByIds({ ids: [1, 2] }))).result, 3);
    assert.deepEqual((await executeWith(searchFeeds({ userId: "u", ids: ["a"], limit: 5 }), [feedRow(1)])).result, [feedRow(1)]);
    assert.equal((await executeWith(touchAll({ title: "t", ids: [1] }))).result, undefined);
    assert.equal((await executeWith(insertTagged({ tags: ["a"] }))).result, 77);
    assert.deepEqual((await executeWith(createTagged({ tags: ["a"] }), [feedRow(2)])).result, feedRow(2));
    const nativeRun = await executeWith(purgeByTags({ tags: ["a"], labels: ["b"] }), [feedRow(3)]);
    assert.equal(nativeRun.result, nativeRun.executor.produced[0]);
    // Each statement was prepared with its own expanded SQL.
    const executed = await executeWith(searchFeeds({ userId: "u", ids: ["a", "b", "c"], limit: 5 }));
    assert.equal(executed.executor.bound[0].sql, "SELECT id, title FROM feeds WHERE user_id = ? AND id IN (?,?,?) LIMIT ?;");
    assert.deepEqual(executed.executor.bound[0].params, ["u", "a", "b", "c", 5]);

    // One heterogeneous batch: two slice descriptors of different lengths, three without.
    const mixedExecutor = new FakeExecutor();
    mixedExecutor.batchRows = [[feedRow(1)], [], [], [], []];
    mixedExecutor.batchMetas = [
      DEFAULT_FAKE_META, { changes: 2, last_row_id: 0 }, DEFAULT_FAKE_META, { changes: 1, last_row_id: 9 }, DEFAULT_FAKE_META,
    ];
    const mixed = await new DB(mixedExecutor).batch(
      searchFeeds({ userId: "u", ids: ["a", "b"], limit: 5 }),
      deleteUsersByIds({ ids: [1, 2, 3] }),
      searchByNickname({ nick: null }),
      insertTagged({ tags: ["x"] }),
      getUserByName({ name: "Ada" }),
    );
    assert.deepEqual(mixed.slice(0, 4), [[feedRow(1)], 2, [], 9]);
    assert.deepEqual(mixedExecutor.bound.map((statement) => statement.params), [
      ["u", "a", "b", 5], [1, 2, 3], [null], ["x"], ["Ada"],
    ]);
    assert.equal(mixedExecutor.bound[0].sql, "SELECT id, title FROM feeds WHERE user_id = ? AND id IN (?,?) LIMIT ?;");
    assert.equal(mixedExecutor.bound[1].sql, "DELETE FROM users WHERE id IN (?,?,?);");
    assert.equal(mixedExecutor.bound[4].sql, "SELECT id, name FROM users WHERE name = ?1 AND nickname = ?1;");

    // Failures leak no element value, SQL text, or parameter.
    const secret = "s3cr3t-value";
    for (const construct of [
      () => deleteUsersByIds({ ids: [1, secret] }),
      () => deleteUsersByIds({ ids: [] }),
      () => matchValues({ payloads: [new Uint8Array()], settings: [1], tokens: ["t"], labels: [secret, 7] }),
    ]) {
      let caught: unknown;
      try {
        construct();
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof QueryArgumentError);
      const candidate = caught as Error;
      const serialized = `${candidate.message}|${JSON.stringify(candidate, Object.getOwnPropertyNames(candidate))}`;
      assert.equal(serialized.includes(secret), false, serialized);
      assert.equal(serialized.includes("SLICE:"), false, serialized);
      assert.equal(serialized.includes("DELETE FROM"), false, serialized);
    }
  },
};

// Bind metadata sqlc can produce but SQLite cannot reproduce. Each query violates exactly
// one rule, in its own file, so the diagnostics cannot mask one another.
export function createArgumentBoundaryRequest(): GenerateRequest {
  return validRequest({
    queries: [
      new Query({
        filename: "gap.sql", name: "NumberGap", cmd: ":exec",
        text: "DELETE FROM users WHERE id = ?1 AND owner_id = ?3",
        params: [parameter(1, namedColumn("id")), parameter(3, namedColumn("owner_id"))],
      }),
      new Query({
        filename: "order.sql", name: "NamedThenPositional", cmd: ":exec",
        text: "DELETE FROM users WHERE name = ?2 AND age = ?",
        params: [parameter(2, namedColumn("nm", "text")), parameter(1, column("age", "integer"))],
      }),
      new Query({
        filename: "mixture.sql", name: "SliceWithNumbered", cmd: ":exec",
        text: "DELETE FROM users WHERE name IN (/*SLICE:names*/?) AND nickname = ?2",
        params: [parameter(1, sliceColumn("names", "text")), parameter(2, namedColumn("nickname", "text"))],
      }),
      new Query({
        filename: "metadata.sql", name: "SliceMetadata", cmd: ":exec",
        text: "DELETE FROM users WHERE id IN (?) AND tag IN (/*SLICE:tags*/?)",
        params: [parameter(1, sliceColumn("ids")), parameter(2, column("tag", "text"))],
      }),
      // A reproducible slice query in the same request contributes no diagnostic.
      new Query({
        filename: "valid.sql", name: "DeleteByIds", cmd: ":exec",
        text: "DELETE FROM users WHERE id IN (/*SLICE:ids*/?) LIMIT ?",
        params: [parameter(2, sliceColumn("ids")), parameter(1, column("limit", "integer"))],
      }),
    ],
  });
}

const argumentBoundary: GeneratorScenario = {
  id: "generator/argument-boundary",
  createInput: () => queryInput(createArgumentBoundaryRequest()),
  assert(outcome) {
    assertFailure(outcome);
    for (const expected of [
      /\[QUERY\/BIND_NUMBER_GAP\] file "gap\.sql", query "NumberGap", field "params":\n/,
      /\[QUERY\/UNSUPPORTED_BIND_ORDER\] file "order\.sql", query "NamedThenPositional", field "params\[0\]", position 1:\n/,
      /\[QUERY\/SLICE_BIND_MIXTURE\] file "mixture\.sql", query "SliceWithNumbered", field "params":\n/,
      /\[QUERY\/SLICE_METADATA_MISMATCH\] file "metadata\.sql", query "SliceMetadata"/,
    ]) {
      assert.match(outcome.diagnostics, expected, expected.source);
    }
    for (const reason of ["BIND_NUMBER_GAP", "UNSUPPORTED_BIND_ORDER", "SLICE_BIND_MIXTURE"]) {
      assert.equal((outcome.diagnostics.match(new RegExp(`\\[QUERY/${reason}\\]`, "g")) ?? []).length, 1, reason);
    }
    // A slice parameter without a marker and a marker without a parameter are both mismatches.
    assert.equal((outcome.diagnostics.match(/\[QUERY\/SLICE_METADATA_MISMATCH\]/g) ?? []).length, 2);
    assert.match(outcome.diagnostics, /generation failed with 5 errors\n/);
    assert.doesNotMatch(outcome.diagnostics, /valid\.sql|DeleteByIds/);
    assert.doesNotMatch(outcome.diagnostics, /DELETE FROM users|SLICE:|\?\d/);
    assertNoStack(outcome.diagnostics);
  },
};

// The allow-list is exhaustive: the four other sqlc commands and anything a future sqlc
// invents must fail with actionable context rather than be approximated.
const UNSUPPORTED_COMMAND_CASES: readonly (readonly [string, string, string])[] = [
  ["copyfrom.sql", "ImportUsers", ":copyfrom"],
  ["batchexec.sql", "BulkTouch", ":batchexec"],
  ["batchmany.sql", "BulkList", ":batchmany"],
  ["batchone.sql", "BulkGet", ":batchone"],
  ["future.sql", "FutureThing", ":bulkexec"],
];

const unsupportedCommands: GeneratorScenario = {
  id: "generator/unsupported-commands",
  createInput: () => queryInput(validRequest({
    queries: UNSUPPORTED_COMMAND_CASES.map(([filename, name, cmd]) =>
      new Query({ filename, name, cmd, text: `SELECT secret_${name} FROM classified;` })),
  })),
  assert(outcome) {
    assertFailure(outcome);
    assert.match(outcome.diagnostics, /generation failed with 5 errors\n/);
    assert.equal((outcome.diagnostics.match(/\[QUERY\/UNSUPPORTED_COMMAND\]/g) ?? []).length, 5);
    for (const [filename, name, cmd] of UNSUPPORTED_COMMAND_CASES) {
      assert.match(
        outcome.diagnostics,
        new RegExp(`\\[QUERY/UNSUPPORTED_COMMAND\\] file "${filename}", query "${name}", field "cmd":\\ncommand "${cmd}" is unsupported; supported commands: ${escapeRegExp('":one", ":many", ":exec", ":execrows", ":execlastid", ":execresult"')}\\n`),
        cmd,
      );
    }
    assert.doesNotMatch(outcome.diagnostics, /secret_|classified/);
    assertNoStack(outcome.diagnostics);
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
    // The repeated bind number binds once: one slot per distinct SQLite parameter index.
    assert.match(
      sources.get("z_root_sql.ts")!,
      /params: Object\.freeze\(\[d1_values\.argText\(args\["default"\], "GetURL", "default"\), d1_values\.argText\(args\["column3"\], "GetURL", "column3"\)\]\)/,
    );
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
  ["text_null", "DATETIME", false],
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

    // Drives the full execute path so the assertion that D1 was never reached has teeth:
    // the factory has to throw while its result is still being evaluated as an argument.
    const rejectsArgument = (
      args: Record<string, unknown>,
      expectations: { path?: string; expected: string; received: string },
    ): CheckedError => {
      const executor = new FakeExecutor();
      const db = new DB(executor);
      let caught: unknown;
      try {
        void db.execute(createSample(args));
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

    // The slice helpers the generated factories build on, driven directly.
    const internals = runtime.generatedInternals as {
      argSlice: (value: unknown, convert: unknown, queryName: string, path: string) => unknown[];
      expandSlices: (sql: string, queryName: string, slices: readonly (readonly [string, number])[]) => string;
      argInteger: (value: unknown, queryName: string, path: string) => number;
      argBlob: (value: unknown, queryName: string, path: string) => Uint8Array;
    };
    const marker = "/*SLICE:ids*/?";

    for (const count of [1, 3, 25]) {
      const values = Array.from({ length: count }, (_, index) => index + 1);
      const converted = internals.argSlice(values, internals.argInteger, "Sliced", "ids");
      assert.deepEqual(converted, values);
      assert.notEqual(converted, values);
      const placeholders = Array.from({ length: count }, () => "?").join(",");
      assert.equal(
        internals.expandSlices(`SELECT 1 WHERE id IN (${marker}) LIMIT ?`, "Sliced", [[marker, count]]),
        `SELECT 1 WHERE id IN (${placeholders}) LIMIT ?`,
      );
    }

    // Elements are snapshotted through the same codec a scalar argument would use.
    const sliceBytes = new Uint8Array([1, 2, 3]);
    const blobs = internals.argSlice([sliceBytes], internals.argBlob, "Sliced", "payloads") as Uint8Array[];
    sliceBytes[0] = 99;
    assert.deepEqual(blobs[0], new Uint8Array([1, 2, 3]));
    const source = [1, 2];
    const snapshot = internals.argSlice(source, internals.argInteger, "Sliced", "ids");
    source.push(3);
    source[0] = 42;
    assert.deepEqual(snapshot, [1, 2]);

    // Two markers expand independently, and a repeated one is replaced left to right.
    assert.equal(
      internals.expandSlices(`SELECT 1 WHERE a IN (${marker}) OR b IN (/*SLICE:tags*/?)`, "Sliced", [[marker, 2], ["/*SLICE:tags*/?", 1]]),
      "SELECT 1 WHERE a IN (?,?) OR b IN (?)",
    );

    const rejectsSlice = (
      value: unknown,
      expectations: { path: string; expected: string; received: string },
    ): void => {
      let caught: unknown;
      try {
        internals.argSlice(value, internals.argInteger, "Sliced", "ids");
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof QueryArgumentError, JSON.stringify(expectations));
      const checked = caught as unknown as CheckedError;
      assert.equal(checked.operation, "construct");
      assert.equal(checked.queryName, "Sliced");
      assert.equal(checked.path, expectations.path);
      assert.equal(checked.expected, expectations.expected);
      assert.equal(checked.received, expectations.received);
    };

    rejectsSlice([], { path: "ids", expected: "a non-empty array", received: "an empty array" });
    for (const [value, received] of [
      [null, "null"], [undefined, "undefined"], ["abc", "string"], [7, "number"],
      [new Uint8Array([1]), "Uint8Array"], [{ length: 2 }, "object"],
    ] as const) {
      rejectsSlice(value, { path: "ids", expected: "a non-empty array", received });
    }
    // A bad element is reported at its own index, by the element codec.
    rejectsSlice([1, 2, "three"], { path: "ids[2]", expected: "a safe integer", received: "string" });

    // A module that lost its marker fails closed rather than sending malformed SQL to D1.
    let missingMarker: unknown;
    try {
      internals.expandSlices("SELECT 1 WHERE id IN (?)", "Sliced", [[marker, 2]]);
    } catch (error) {
      missingMarker = error;
    }
    assert.ok(missingMarker instanceof QueryUsageError);
    assert.equal((missingMarker as unknown as CheckedError).operation, "construct");
    assert.equal((missingMarker as unknown as CheckedError).expected, "a generated slice placeholder");
    assert.equal((missingMarker as unknown as CheckedError).received, "missing placeholder");

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
    const backingBuffer = new Uint8Array([6, 7]).buffer;
    const bufferRow = physicalRow();
    bufferRow.blob_value = backingBuffer;
    const bufferMapped = (await executeWithRows([bufferRow], getSample({ intValue: 1 }))).result as Record<string, unknown>;
    assert.deepEqual(bufferMapped.blobValue, new Uint8Array([6, 7]));
    // A view over the source buffer would not survive this.
    new Uint8Array(backingBuffer)[0] = 99;
    assert.deepEqual(bufferMapped.blobValue, new Uint8Array([6, 7]));
    const sourceArray = [8, 9];
    const arrayRow = physicalRow();
    arrayRow.blob_value = sourceArray;
    const arrayMapped = (await executeWithRows([arrayRow], getSample({ intValue: 1 }))).result as Record<string, unknown>;
    sourceArray[0] = 99;
    assert.deepEqual(arrayMapped.blobValue, new Uint8Array([8, 9]));

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

// Descriptors are opaque to consumers, so exercising a runtime kind before any factory
// can produce it means hand-building the private descriptor shape.
function handBuiltDescriptor(kind: string, name: string, extra: Record<string, unknown> = {}): unknown {
  return Object.freeze({ kind, name, sql: `SELECT 1 -- ${name}`, params: Object.freeze([]), ...extra });
}

// `meta` itself is unusable: the failure names the whole object.
const META_OBJECT_FAILURES: readonly (readonly [unknown, string])[] = [
  [undefined, "undefined"],
  [null, "null"],
  ["meta", "string"],
  [7, "number"],
];

// `meta` is an object but the field the command promises is not a safe integer.
const META_FIELD_FAILURES: readonly (readonly [(key: string) => Record<string, unknown>, string])[] = [
  [() => ({}), "missing field"],
  [(key) => ({ [key]: null }), "null"],
  [(key) => ({ [key]: "7" }), "string"],
  [(key) => ({ [key]: 1.5 }), "non-integer number"],
  [(key) => ({ [key]: 2 ** 53 }), "unsafe integer"],
  [(key) => ({ [key]: Number.NaN }), "non-finite number"],
];

const METADATA_COMMANDS: readonly (readonly [string, string])[] = [
  ["exec-rows", "changes"],
  ["exec-lastid", "last_row_id"],
];

const commandResults: GeneratorScenario = {
  id: "generator/command-results",
  createInput: () => queryInput(createCommandsRequest()),
  async assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.ok(outcome.response);
    const load = loadGeneratedModules(outcome.response);
    const runtime = load("runtime");
    const queries = load("queries_sql");
    const DB = runtime.DB as new (executor: unknown) => {
      execute(query: unknown): Promise<unknown>;
      batch(...queries: unknown[]): Promise<unknown[]>;
    };
    const QueryResultError = runtime.QueryResultError as new (...args: never[]) => Error;
    const QueryUsageError = runtime.QueryUsageError as new (...args: never[]) => Error;

    const executeWithMeta = async (meta: unknown, query: unknown): Promise<{ executor: FakeExecutor; result: unknown }> => {
      const executor = new FakeExecutor();
      executor.meta = meta;
      const result = await new DB(executor).execute(query);
      return { executor, result };
    };

    // Metadata commands resolve the validated field D1 reports, zero included.
    for (const [changes, lastRowId] of [[3, 42], [0, 0]] as const) {
      const meta = { changes, last_row_id: lastRowId, duration: 0.5, served_by: "miniflare.db" };
      assert.equal((await executeWithMeta(meta, handBuiltDescriptor("exec-rows", "Changed"))).result, changes);
      assert.equal((await executeWithMeta(meta, handBuiltDescriptor("exec-lastid", "Inserted"))).result, lastRowId);
    }

    // :execresult hands back D1's own object: same identity, unfrozen, uncopied.
    const passthrough = await executeWithMeta({ changes: 1, last_row_id: 9 }, handBuiltDescriptor("exec-result", "Native"));
    assert.equal(passthrough.result, passthrough.executor.produced[0]);
    assert.equal(Object.isFrozen(passthrough.result), false);
    const native = passthrough.result as { results: unknown[]; success: boolean; meta: Record<string, unknown> };
    assert.deepEqual(native.results, []);
    assert.equal(native.success, true);
    assert.equal(native.meta.changes, 1);
    assert.equal(native.meta.last_row_id, 9);

    // :exec still discards everything D1 reported.
    assert.equal((await executeWithMeta({ changes: 5, last_row_id: 5 }, handBuiltDescriptor("exec", "Touch"))).result, undefined);

    const rejectsMeta = async (
      kind: string,
      meta: unknown,
      expectations: { path: string; expected: string; received: string },
    ): Promise<void> => {
      const label = `${kind} with ${expectations.path} ${expectations.received}`;
      let caught: unknown;
      try {
        await executeWithMeta(meta, handBuiltDescriptor(kind, "Metadata"));
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof QueryResultError, label);
      const checked = caught as unknown as CheckedError;
      assert.equal(checked.name, "QueryResultError", label);
      assert.equal(checked.operation, "execute", label);
      assert.equal(checked.queryName, "Metadata", label);
      assert.equal(checked.batchIndex, undefined, label);
      assert.equal(checked.rowIndex, undefined, label);
      assert.equal(checked.path, expectations.path, label);
      assert.equal(checked.expected, expectations.expected, label);
      assert.equal(checked.received, expectations.received, label);
    };

    for (const [kind, key] of METADATA_COMMANDS) {
      for (const [meta, received] of META_OBJECT_FAILURES) {
        await rejectsMeta(kind, meta, { path: "meta", expected: "an execution metadata object", received });
      }
      for (const [buildMeta, received] of META_FIELD_FAILURES) {
        await rejectsMeta(kind, buildMeta(key), { path: `meta.${key}`, expected: "a safe integer", received });
      }
    }

    // A heterogeneous batch resolves every kind positionally from its own element.
    const batchExecutor = new FakeExecutor();
    batchExecutor.batchRows = [[{ id: 1 }], [{ id: 2 }, { id: 3 }], [], [], [], []];
    batchExecutor.batchMetas = [
      { changes: 0, last_row_id: 0 },
      { changes: 0, last_row_id: 0 },
      { changes: 1, last_row_id: 0 },
      { changes: 4, last_row_id: 0 },
      { changes: 1, last_row_id: 77 },
      { changes: 2, last_row_id: 78 },
    ];
    const identity = (row: Record<string, unknown>): unknown => row;
    const batched = await new DB(batchExecutor).batch(
      handBuiltDescriptor("one", "One", { parse: identity }),
      handBuiltDescriptor("many", "Many", { parse: identity }),
      handBuiltDescriptor("exec", "Exec"),
      handBuiltDescriptor("exec-rows", "Rows"),
      handBuiltDescriptor("exec-lastid", "LastId"),
      handBuiltDescriptor("exec-result", "Result"),
    );
    assert.deepEqual(batched.slice(0, 5), [{ id: 1 }, [{ id: 2 }, { id: 3 }], undefined, 4, 77]);
    assert.equal(batched[5], batchExecutor.produced[5]);

    // An empty result set is an empty array, never null or undefined.
    const emptyExecutor = new FakeExecutor();
    emptyExecutor.batchRows = [[]];
    assert.deepEqual(await new DB(emptyExecutor).batch(handBuiltDescriptor("many", "Many", { parse: identity })), [[]]);

    // Metadata failures inside a batch carry the operation and the failing index.
    for (const [batchIndex, kind, key] of [[1, "exec-rows", "changes"], [2, "exec-lastid", "last_row_id"]] as const) {
      const executor = new FakeExecutor();
      executor.batchMetas = [{ changes: 1, last_row_id: 1 }, { changes: 1, last_row_id: 1 }, { changes: 1, last_row_id: 1 }];
      executor.batchMetas[batchIndex] = { [key]: "not a number" };
      let caught: unknown;
      try {
        await new DB(executor).batch(
          handBuiltDescriptor("exec", "First"),
          handBuiltDescriptor("exec-rows", "Second"),
          handBuiltDescriptor("exec-lastid", "Third"),
        );
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof QueryResultError, kind);
      const checked = caught as unknown as CheckedError;
      assert.equal(checked.operation, "batch");
      assert.equal(checked.batchIndex, batchIndex);
      assert.equal(checked.rowIndex, undefined);
      assert.equal(checked.path, `meta.${key}`);
      assert.equal(checked.received, "string");
    }

    // Value-result descriptors need no parser; row descriptors still do, and an
    // unknown kind stays a usage failure before any statement is prepared.
    for (const kind of ["exec", "exec-rows", "exec-lastid", "exec-result"]) {
      const executor = new FakeExecutor();
      await new DB(executor).execute(handBuiltDescriptor(kind, "NoParser"));
      assert.equal(executor.bound.length, 1);
    }
    for (const forged of [
      handBuiltDescriptor("exec-changes", "Unknown"),
      handBuiltDescriptor("many", "NoParser"),
      handBuiltDescriptor("execrows", "Unhyphenated"),
    ]) {
      const executor = new FakeExecutor();
      let caught: unknown;
      try {
        await new DB(executor).execute(forged);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof QueryUsageError, JSON.stringify(forged));
      assert.equal(executor.bound.length, 0);
    }

    // The same semantics through the real generated factories.
    const getFeed = queries.getFeed as (args: Record<string, unknown>) => unknown;
    const createFeed = queries.createFeed as (args: Record<string, unknown>) => unknown;
    const listFeeds = queries.listFeeds as () => unknown;
    const touchFeed = queries.touchFeed as (args: Record<string, unknown>) => unknown;
    const deleteFeedsByUser = queries.deleteFeedsByUser as (args: Record<string, unknown>) => unknown;
    const insertFeedId = queries.insertFeedId as (args: Record<string, unknown>) => unknown;
    const purgeFeeds = queries.purgeFeeds as (args: Record<string, unknown>) => unknown;
    const feedRow = (id: number): Record<string, unknown> => ({ id, title: `Feed ${id}` });

    const executeWithRows = async (rows: unknown[], query: unknown): Promise<unknown> => {
      const executor = new FakeExecutor();
      executor.rows = rows;
      executor.meta = { changes: 6, last_row_id: 91 };
      return new DB(executor).execute(query);
    };

    // :one takes the first row of a multi-row result and never issues a second query.
    assert.deepEqual(await executeWithRows([feedRow(1), feedRow(2)], getFeed({ id: 1 })), feedRow(1));
    assert.equal(await executeWithRows([], getFeed({ id: 1 })), null);
    assert.deepEqual(await executeWithRows([feedRow(3), feedRow(4)], createFeed({ title: "Feed 3" })), feedRow(3));
    assert.equal(await executeWithRows([], createFeed({ title: "Feed 3" })), null);
    assert.deepEqual(await executeWithRows([feedRow(1), feedRow(2)], listFeeds()), [feedRow(1), feedRow(2)]);
    assert.deepEqual(await executeWithRows([], listFeeds()), []);
    assert.equal(await executeWithRows([], touchFeed({ title: "Feed", id: 1 })), undefined);
    assert.equal(await executeWithRows([], deleteFeedsByUser({ userId: "user_1" })), 6);
    assert.equal(await executeWithRows([], insertFeedId({ title: "Feed" })), 91);

    const generatedNative = new FakeExecutor();
    generatedNative.rows = [feedRow(1)];
    const nativeResult = await new DB(generatedNative).execute(purgeFeeds({ userId: "user_1" }));
    assert.equal(nativeResult, generatedNative.produced[0]);
    assert.deepEqual((nativeResult as { results: unknown[] }).results, [feedRow(1)]);

    // One heterogeneous batch of generated descriptors, resolved positionally.
    const generatedBatch = new FakeExecutor();
    generatedBatch.batchRows = [[feedRow(1)], [feedRow(2)], [feedRow(3), feedRow(4)], [], [], [], [feedRow(5)]];
    generatedBatch.batchMetas = [
      DEFAULT_FAKE_META, DEFAULT_FAKE_META, DEFAULT_FAKE_META, { changes: 1, last_row_id: 0 },
      { changes: 2, last_row_id: 0 }, { changes: 1, last_row_id: 55 }, { changes: 3, last_row_id: 56 },
    ];
    const generatedResults = await new DB(generatedBatch).batch(
      getFeed({ id: 1 }),
      createFeed({ title: "Feed 2" }),
      listFeeds(),
      touchFeed({ title: "Feed", id: 1 }),
      deleteFeedsByUser({ userId: "user_1" }),
      insertFeedId({ title: "Feed" }),
      purgeFeeds({ userId: "user_1" }),
    );
    assert.deepEqual(generatedResults.slice(0, 6), [
      feedRow(1), feedRow(2), [feedRow(3), feedRow(4)], undefined, 2, 55,
    ]);
    assert.equal(generatedResults[6], generatedBatch.produced[6]);
    assert.equal(generatedBatch.bound.length, 7);

    // A generated metadata failure carries the same context as a hand-built one.
    const generatedFailure = new FakeExecutor();
    generatedFailure.meta = { changes: 1.5, last_row_id: 1 };
    let generatedCaught: unknown;
    try {
      await new DB(generatedFailure).execute(deleteFeedsByUser({ userId: "user_1" }));
    } catch (error) {
      generatedCaught = error;
    }
    assert.ok(generatedCaught instanceof QueryResultError);
    assert.deepEqual(
      (({ operation, queryName, path, expected, received, rowIndex }: CheckedError) =>
        ({ operation, queryName, path, expected, received, rowIndex }))(generatedCaught as unknown as CheckedError),
      {
        operation: "execute",
        queryName: "DeleteFeedsByUser",
        path: "meta.changes",
        expected: "a safe integer",
        received: "non-integer number",
        rowIndex: undefined,
      },
    );

    // A native D1 rejection on a metadata command is still D1's own error.
    const nativeFailure = Object.assign(new Error("D1_ERROR: no such table: feeds"), { code: "D1_ERROR" });
    const nativeStack = nativeFailure.stack;
    const nativeExecutor = new FakeExecutor();
    nativeExecutor.failure = nativeFailure;
    let nativeCaught: unknown;
    try {
      await new DB(nativeExecutor).execute(deleteFeedsByUser({ userId: "user_1" }));
    } catch (error) {
      nativeCaught = error;
    }
    assert.equal(nativeCaught, nativeFailure);
    assert.equal((nativeCaught as Error).message, "D1_ERROR: no such table: feeds");
    assert.equal((nativeCaught as Error).stack, nativeStack);
    assert.equal((nativeCaught as { code?: string }).code, "D1_ERROR");
    assert.equal(nativeCaught instanceof (runtime.SqlcD1Error as new (...args: never[]) => Error), false);

    // Metadata failures leak no value, SQL text, or parameter.
    let leaked: unknown;
    try {
      await executeWithMeta({ changes: "s3cr3t-value" }, handBuiltDescriptor("exec-rows", "Leaky"));
    } catch (error) {
      leaked = error;
    }
    const candidate = leaked as Error;
    const serialized = `${candidate.message}|${JSON.stringify(candidate, Object.getOwnPropertyNames(candidate))}`;
    assert.equal(serialized.includes("s3cr3t-value"), false, serialized);
    assert.equal(serialized.includes("SELECT 1"), false, serialized);
  },
};

export const generatorScenarios = [
  currentCommands,
  commandSemantics,
  checkedValues,
  runtimeValues,
  commandResults,
  fileGrouping,
  optionsBoundary,
  protocolBoundary,
  unknownProtobufField,
  compatibility,
  queryBoundary,
  unsupportedCommands,
  emissionReadiness,
  argumentModel,
  argumentValues,
  argumentBoundary,
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertNoStack(diagnostics: string): void {
  assert.doesNotMatch(diagnostics, /function\.mjs|\sat\s|Error:|stack/);
}
