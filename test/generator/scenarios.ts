import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Column,
  GenerateRequest,
  Identifier,
  Parameter,
  Query,
} from "../../src/gen/plugin/codegen_pb";
import { GeneratorHarness, GeneratorOutcome } from "./harness";

export interface GeneratorScenario {
  id: string;
  createRequest(): GenerateRequest;
  assert(outcome: GeneratorOutcome): void;
}

const options = new TextEncoder().encode('{"interface":"workers"}');
const type = (name: string) => new Identifier({ name });
const column = (name: string, typeName: string, notNull = true) =>
  new Column({ name, type: type(typeName), notNull });
const parameter = (number: number, value: Column) => new Parameter({ number, column: value });

export function createCurrentCommandsRequest(): GenerateRequest {
  const name = column("name", "text");
  const id = column("id", "integer");
  return new GenerateRequest({
    pluginOptions: options,
    queries: [
      new Query({
        filename: "queries.sql",
        name: "UpdateName",
        cmd: ":exec",
        text: "UPDATE users SET name = ? WHERE id = ?;",
        params: [parameter(1, name), parameter(2, id)],
      }),
      new Query({
        filename: "queries.sql",
        name: "GetUser",
        cmd: ":one",
        text: "SELECT id, nickname FROM users LIMIT 1;",
        columns: [id, column("nickname", "text", false)],
      }),
      new Query({
        filename: "queries.sql",
        name: "CreateUser",
        cmd: ":one",
        text: "INSERT INTO users (name) VALUES (?) RETURNING id;",
        params: [parameter(1, name)],
        columns: [id],
        insertIntoTable: new Identifier({ name: "users" }),
      }),
      new Query({
        filename: "queries.sql",
        name: "ListUsers",
        cmd: ":many",
        text: "SELECT id, name FROM users;",
        columns: [id, name],
      }),
      new Query({
        filename: "audit.sql",
        name: "ClearAuditLog",
        cmd: ":exec",
        text: "DELETE FROM audit_log;",
      }),
    ],
  });
}

const currentCommands: GeneratorScenario = {
  id: "generator/current-commands",
  createRequest: createCurrentCommandsRequest,
  assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.equal(outcome.diagnostics, "");
    assert.ok(outcome.response);
    assert.equal(outcome.response.files.length, 2);
    assert.deepEqual(outcome.response.files.map((file) => file.name), ["queries_sql.ts", "audit_sql.ts"]);
    const actual = new TextDecoder().decode(outcome.response.files[0].contents);
    const expected = readFileSync(
      resolve(process.cwd(), "test/generator/goldens/current-output.ts.txt"),
      "utf8",
    );
    assert.equal(actual, expected);
    const audit = new TextDecoder().decode(outcome.response.files[1].contents);
    assert.match(audit, /export function clearAuditLog\(\): ExecQuery/);
  },
};

const fileGrouping: GeneratorScenario = {
  id: "generator/file-grouping",
  createRequest() {
    return new GenerateRequest({
      pluginOptions: options,
      queries: [
        new Query({ filename: "one.sql", name: "First", cmd: ":exec", text: "DELETE FROM one;" }),
        new Query({ filename: "one.sql", name: "Second", cmd: ":exec", text: "DELETE FROM two;" }),
        new Query({ filename: "two.sql", name: "Third", cmd: ":exec", text: "DELETE FROM three;" }),
      ],
    });
  },
  assert(outcome) {
    assert.equal(outcome.exitCode, 0, outcome.diagnostics);
    assert.deepEqual(outcome.response?.files.map((file) => file.name), ["one_sql.ts", "two_sql.ts"]);
    const first = new TextDecoder().decode(outcome.response?.files[0].contents);
    assert.match(first, /export function first/);
    assert.match(first, /export function second/);
  },
};

const duplicateResultColumn: GeneratorScenario = {
  id: "generator/duplicate-result-column",
  createRequest() {
    return new GenerateRequest({
      pluginOptions: options,
      queries: [new Query({
        filename: "queries.sql",
        name: "Duplicate",
        cmd: ":many",
        text: "SELECT a.id, b.id FROM a JOIN b;",
        columns: [column("id", "integer"), column("id", "integer")],
      })],
    });
  },
  assert(outcome) {
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.response, undefined);
    assert.match(outcome.diagnostics, /query Duplicate returns duplicate column id/);
  },
};

export const generatorScenarios = [currentCommands, fileGrouping, duplicateResultColumn];

export async function runScenario(harness: GeneratorHarness, scenario: GeneratorScenario): Promise<void> {
  scenario.assert(await harness.run(scenario.createRequest()));
}
