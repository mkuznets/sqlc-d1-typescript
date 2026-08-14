import assert from "node:assert/strict";
import test from "node:test";
import {
  CatalogIndex,
  EMBED_ALIAS_PREFIX,
  findEmbedExpansions,
  rewriteProjection,
  type ExpansionSpan,
} from "../../src/embeds";
import { Catalog, Column, Identifier, Schema, Table } from "../../src/gen/plugin/codegen_pb";

const identifier = (name: string, schema = "", catalog = "") => new Identifier({ name, schema, catalog });
const catalogColumn = (name: string) => new Column({ name, type: identifier("text"), notNull: true });
const table = (name: string, columnNames: readonly string[], schema = "") =>
  new Table({ rel: identifier(name, schema), columns: columnNames.map(catalogColumn) });

const spans = (text: string, columnNames: readonly string[]): readonly ExpansionSpan[] =>
  findEmbedExpansions(text, columnNames);

const spanTexts = (text: string, columnNames: readonly string[]): string[] =>
  spans(text, columnNames).map((span) => text.slice(span.start, span.end));

test("the expansion scanner locates every shape sqlc emits for sqlc.embed", () => {
  const twoEmbeds =
    "SELECT users.id, users.name, posts.id, posts.user_id, posts.title FROM users JOIN posts ON posts.user_id = users.id";
  assert.deepEqual(spanTexts(twoEmbeds, ["id", "name"]), ["users.id, users.name"]);
  assert.deepEqual(spanTexts(twoEmbeds, ["id", "user_id", "title"]), ["posts.id, posts.user_id, posts.title"]);

  // Ordinary columns before and after an expansion do not disturb it.
  const around =
    "SELECT users.id AS uid, posts.id, posts.user_id, posts.title, posts.title AS t FROM users JOIN posts ON posts.user_id = users.id";
  assert.deepEqual(spanTexts(around, ["id", "user_id", "title"]), ["posts.id, posts.user_id, posts.title"]);

  // A self-join embeds one table twice, so one column list matches two runs.
  const selfJoin = "SELECT a.id, a.name, b.id, b.name FROM users a JOIN users b ON a.id = b.id";
  assert.deepEqual(spanTexts(selfJoin, ["id", "name"]), ["a.id, a.name", "b.id, b.name"]);

  // sqlc double-quotes reserved keywords and lowercases everything else.
  const quoted = 'SELECT quoted."order", quoted."group", quoted.mixedcase, quoted.plain_col FROM quoted';
  assert.deepEqual(spanTexts(quoted, ["order", "group", "mixedcase", "plain_col"]), [
    'quoted."order", quoted."group", quoted.mixedcase, quoted.plain_col',
  ]);

  assert.deepEqual(spanTexts("INSERT INTO users (name) VALUES (?) RETURNING users.id, users.name", ["id", "name"]), [
    "users.id, users.name",
  ]);
  assert.deepEqual(spanTexts("SELECT * FROM (SELECT u.id, u.name FROM users u) WHERE id = ?", ["id", "name"]), [
    "u.id, u.name",
  ]);
  assert.deepEqual(spanTexts("SELECT DISTINCT u.id, u.name FROM users u", ["id", "name"]), ["u.id, u.name"]);
  assert.deepEqual(spanTexts("SELECT ALL u.id, u.name FROM users u", ["id", "name"]), ["u.id, u.name"]);
});

test("the projection guard keeps predicates and clauses out of the expansion", () => {
  // A one-column embed would otherwise match its own join predicate.
  assert.deepEqual(spanTexts("SELECT single.id FROM single JOIN x ON x.k = single.id", ["id"]), ["single.id"]);
  assert.deepEqual(
    spanTexts("SELECT users.id, users.name FROM users WHERE users.id = ? AND users.name = ?", ["id", "name"]),
    ["users.id, users.name"],
  );
  assert.deepEqual(spanTexts("SELECT users.id, users.name FROM users ORDER BY users.id, users.name", ["id", "name"]), [
    "users.id, users.name",
  ]);
  assert.deepEqual(
    spanTexts("SELECT users.id, users.name FROM users GROUP BY users.id, users.name HAVING users.id > 0", [
      "id",
      "name",
    ]),
    ["users.id, users.name"],
  );
  // An expansion that does not start a select-list item is not located at all.
  assert.deepEqual(spans("UPDATE users SET name = users.name", ["name"]), []);
  assert.deepEqual(spans("SELECT xusers.id, xusers.name FROM xusers", ["id", "name"]).length, 1);
  assert.deepEqual(spans("users.id, users.name", ["id", "name"]), []);
});

test("an expansion that occurs twice is located twice, so the caller can refuse to guess", () => {
  // sqlc.embed(users) followed by users.* is textually indistinguishable from itself.
  assert.equal(spans("SELECT users.id, users.name, users.id, users.name FROM users", ["id", "name"]).length, 2);
  // One extra projected column of the same table is not a second expansion.
  assert.equal(spans("SELECT users.id, users.name, users.id FROM users", ["id", "name"]).length, 1);
  // Metadata that disagrees with the text yields no span at all.
  assert.deepEqual(spans("SELECT users.id, users.name FROM users", ["id", "nickname"]), []);
  assert.deepEqual(spans("SELECT users.id FROM users", []), []);
});

test("item spelling, separators, and qualifiers are matched exactly", () => {
  // A quoted qualifier and a doubled inner quote are ordinary identifiers.
  assert.deepEqual(spanTexts('SELECT "my table".id, "my table".name FROM "my table"', ["id", "name"]), [
    '"my table".id, "my table".name',
  ]);
  assert.deepEqual(spanTexts('SELECT t."we""ird", t.ok_col FROM t', ['we"ird', "ok_col"]), ['t."we""ird", t.ok_col']);

  // The separator is exactly one comma and one space.
  assert.deepEqual(spans("SELECT users.id,users.name FROM users", ["id", "name"]), []);
  assert.deepEqual(spans("SELECT users.id ,users.name FROM users", ["id", "name"]), []);
  assert.deepEqual(spans("SELECT users.id,  users.name FROM users", ["id", "name"]), []);

  // The qualifier must be byte-identical across the whole run.
  assert.deepEqual(spans("SELECT a.id, b.name FROM users a JOIN users b", ["id", "name"]), []);
  assert.deepEqual(spans('SELECT a.id, "a".name FROM users a', ["id", "name"]), []);

  // A bare item name is compared to the catalog name without normalization.
  assert.deepEqual(spans("SELECT users.ID, users.NAME FROM users", ["id", "name"]), []);
});

test("the projection rewrite inserts aliases and moves no other byte", () => {
  const text = "SELECT users.id, users.name FROM users WHERE users.id IN (/*SLICE:ids*/?)";
  const located = spans(text, ["id", "name"]);
  assert.equal(located.length, 1);
  const aliased = located[0].items.map((item, index) => ({ item, alias: `${EMBED_ALIAS_PREFIX}0_${index}` }));
  const rewritten = rewriteProjection(text, aliased);
  assert.equal(
    rewritten,
    'SELECT users.id AS "d1_embed_0_0", users.name AS "d1_embed_0_1" FROM users WHERE users.id IN (/*SLICE:ids*/?)',
  );
  // Removing exactly what was inserted restores sqlc's own text.
  assert.equal(rewritten.replace(/ AS "[^"]*"/g, ""), text);
  assert.ok(rewritten.includes("/*SLICE:ids*/?"));
  assert.equal(rewriteProjection(text, []), text);

  // Two embeds are rewritten in one pass, in ascending text order.
  const twoEmbeds =
    "SELECT users.id, users.name, posts.id, posts.title FROM users JOIN posts ON posts.user_id = users.id";
  const first = spans(twoEmbeds, ["id", "name"])[0];
  const second = spans(twoEmbeds, ["id", "title"])[0];
  const both = [
    ...second.items.map((item, index) => ({ item, alias: `${EMBED_ALIAS_PREFIX}1_${index}` })),
    ...first.items.map((item, index) => ({ item, alias: `${EMBED_ALIAS_PREFIX}0_${index}` })),
  ];
  const rewrittenBoth = rewriteProjection(twoEmbeds, both);
  assert.equal(
    rewrittenBoth,
    'SELECT users.id AS "d1_embed_0_0", users.name AS "d1_embed_0_1", posts.id AS "d1_embed_1_0", posts.title AS "d1_embed_1_1" FROM users JOIN posts ON posts.user_id = users.id',
  );
  assert.equal(rewrittenBoth.replace(/ AS "[^"]*"/g, ""), twoEmbeds);
});

test("the catalog index resolves embedded tables by exact identifier", () => {
  const catalog = new Catalog({
    defaultSchema: "main",
    schemas: [
      new Schema({ name: "main", tables: [table("users", ["id", "name"]), table("posts", ["id", "title"])] }),
      new Schema({ name: "other", tables: [table("users", ["other_id"], "other")] }),
    ],
  });
  const index = new CatalogIndex(catalog);
  assert.deepEqual(
    index.resolve(identifier("users"))?.map((column) => column.name),
    ["id", "name"],
  );
  assert.deepEqual(
    index.resolve(identifier("users", "main"))?.map((column) => column.name),
    ["id", "name"],
  );
  assert.deepEqual(
    index.resolve(identifier("users", "other"))?.map((column) => column.name),
    ["other_id"],
  );

  assert.equal(index.resolve(identifier("absent")), undefined);
  assert.equal(index.resolve(identifier("users", "missing")), undefined);
  assert.equal(index.resolve(identifier("users", "", "elsewhere")), undefined);
  assert.equal(new CatalogIndex().resolve(identifier("users")), undefined);
  assert.equal(new CatalogIndex(new Catalog()).resolve(identifier("users")), undefined);
});
