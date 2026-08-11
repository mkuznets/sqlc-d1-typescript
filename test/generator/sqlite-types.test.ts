import assert from "node:assert/strict";
import test from "node:test";
import {
  DECLARED_TYPE_KINDS,
  normalizeDeclaredTypeName,
  valueKindForColumn,
} from "../../src/sqlite-types";
import { Column, Identifier } from "../../src/gen/plugin/codegen_pb";

const declared = (name: string) => new Column({ name: "value", type: new Identifier({ name }), notNull: true });

test("exact lowercase declared names map to their documented value kind", () => {
  for (const name of ["int", "integer", "tinyint", "smallint", "mediumint", "bigint", "unsignedbigint", "int2", "int8"]) {
    assert.equal(valueKindForColumn(declared(name)), "integer", name);
  }
  for (const name of ["real", "double", "doubleprecision", "float", "numeric", "decimal"]) {
    assert.equal(valueKindForColumn(declared(name)), "number", name);
  }
  for (const name of ["text", "clob", "character", "varchar", "varyingcharacter", "nchar", "nativecharacter", "nvarchar", "date", "datetime", "timestamp"]) {
    assert.equal(valueKindForColumn(declared(name)), "text", name);
  }
  for (const name of ["boolean", "bool"]) assert.equal(valueKindForColumn(declared(name)), "boolean", name);
  assert.equal(valueKindForColumn(declared("blob")), "blob");
  for (const name of ["json", "jsonb"]) assert.equal(valueKindForColumn(declared(name)), "json", name);
});

test("uppercase and mixed-case declared names normalize to the same kind", () => {
  assert.equal(normalizeDeclaredTypeName(new Identifier({ name: "INTEGER" })), "integer");
  assert.equal(valueKindForColumn(declared("INTEGER")), "integer");
  assert.equal(valueKindForColumn(declared("Text")), "text");
  assert.equal(valueKindForColumn(declared("Boolean")), "boolean");
  assert.equal(valueKindForColumn(declared("BLOB")), "blob");
  assert.equal(valueKindForColumn(declared("JSONB")), "json");
});

test("parameterized declarations are truncated at the first open parenthesis", () => {
  assert.equal(normalizeDeclaredTypeName(new Identifier({ name: "VARCHAR(255)" })), "varchar");
  assert.equal(valueKindForColumn(declared("VARCHAR(255)")), "text");
  assert.equal(valueKindForColumn(declared("DECIMAL(10,2)")), "number");
  assert.equal(valueKindForColumn(declared("DECIMAL(10, 2)")), "number");
  assert.equal(valueKindForColumn(declared("VARYINGCHARACTER(32)")), "text");
  assert.equal(valueKindForColumn(declared("NUMERIC(10,5)")), "number");
});

test("ASCII whitespace inside a declared name is removed", () => {
  assert.equal(normalizeDeclaredTypeName(new Identifier({ name: "UNSIGNED BIG INT" })), "unsignedbigint");
  assert.equal(valueKindForColumn(declared("UNSIGNED BIG INT")), "integer");
  assert.equal(valueKindForColumn(declared("DOUBLE PRECISION")), "number");
  assert.equal(valueKindForColumn(declared("NATIVE\tCHARACTER(70)")), "text");
  assert.equal(valueKindForColumn(declared("VARYING CHARACTER(32)")), "text");
});

test("sqlc's untyped 'any' placeholder maps to the unknown value kind", () => {
  assert.equal(normalizeDeclaredTypeName(new Identifier({ name: "any" })), "any");
  assert.equal(valueKindForColumn(declared("any")), "unknown");
  assert.equal(valueKindForColumn(declared("ANY")), "unknown");
  assert.equal(DECLARED_TYPE_KINDS.has("any"), false);
});

test("unrecognized declarations map to the unknown value kind", () => {
  for (const name of ["ULID", "DOMAIN_EVENT", "geometry", "point", ""]) {
    assert.equal(valueKindForColumn(declared(name)), "unknown", name);
  }
});

test("an absent column or absent declared type maps to the unknown value kind", () => {
  assert.equal(valueKindForColumn(undefined), "unknown");
  assert.equal(valueKindForColumn(new Column({ name: "value", notNull: true })), "unknown");
  assert.equal(normalizeDeclaredTypeName(undefined), "");
});

test("schema-qualified identifiers are not bare SQLite declared types", () => {
  assert.equal(normalizeDeclaredTypeName(new Identifier({ schema: "main", name: "INTEGER" })), "");
  assert.equal(normalizeDeclaredTypeName(new Identifier({ catalog: "db", name: "INTEGER" })), "");
  assert.equal(valueKindForColumn(new Column({ name: "value", type: new Identifier({ schema: "main", name: "INTEGER" }), notNull: true })), "unknown");
});

test("lowering is ASCII only so normalization is engine independent", () => {
  assert.equal(normalizeDeclaredTypeName(new Identifier({ name: "İNTEGER" })), "İnteger");
  assert.equal(valueKindForColumn(declared("İNTEGER")), "unknown");
  assert.equal(normalizeDeclaredTypeName(new Identifier({ name: "TEXTÉ" })), "textÉ");
  assert.equal(valueKindForColumn(declared("TEXTÉ")), "unknown");
});

test("the allow-list contains only normalized lowercase ASCII names", () => {
  for (const name of DECLARED_TYPE_KINDS.keys()) {
    assert.match(name, /^[a-z0-9]+$/, name);
    assert.equal(normalizeDeclaredTypeName(new Identifier({ name })), name);
  }
});
