import type { Column, Identifier } from "./gen/plugin/codegen_pb.ts";

export type ValueKind = "integer" | "number" | "text" | "boolean" | "blob" | "json" | "unknown";

export type RuntimeTypeImport = "QueryDescriptor" | "D1NonNullValue" | "D1Value" | "JsonValue";
export const RUNTIME_TYPE_IMPORT_ORDER: readonly RuntimeTypeImport[] = [
  "QueryDescriptor",
  "D1NonNullValue",
  "D1Value",
  "JsonValue",
];

export interface ValueFieldPlan {
  readonly valueKind: ValueKind;
  readonly nullable: boolean;
}

/** Every TypeScript spelling and runtime name one value kind owns. */
export interface ValueKindSpelling {
  readonly codecSuffix: string;
  readonly argumentType: string;
  readonly nullableArgumentType: string;
  readonly rowType: string;
  readonly nullableRowType: string;
  readonly argumentImport?: RuntimeTypeImport;
  readonly nullableArgumentImport?: RuntimeTypeImport;
}

// The single dispatch site: adding a value kind is a compile error here, and in the
// two codecs the emitted runtime declares for it.
export const VALUE_KINDS: Readonly<Record<ValueKind, ValueKindSpelling>> = {
  integer: {
    codecSuffix: "Integer",
    argumentType: "number",
    nullableArgumentType: "number | null",
    rowType: "number",
    nullableRowType: "number | null",
  },

  number: {
    codecSuffix: "Number",
    argumentType: "number",
    nullableArgumentType: "number | null",
    rowType: "number",
    nullableRowType: "number | null",
  },

  text: {
    codecSuffix: "Text",
    argumentType: "string",
    nullableArgumentType: "string | null",
    rowType: "string",
    nullableRowType: "string | null",
  },

  boolean: {
    codecSuffix: "Boolean",
    argumentType: "boolean",
    nullableArgumentType: "boolean | null",
    rowType: "boolean",
    nullableRowType: "boolean | null",
  },

  blob: {
    codecSuffix: "Blob",
    argumentType: "Uint8Array",
    nullableArgumentType: "Uint8Array | null",
    rowType: "Uint8Array",
    nullableRowType: "Uint8Array | null",
  },

  json: {
    codecSuffix: "Json",
    argumentType: "JsonValue",
    nullableArgumentType: "JsonValue | null",
    rowType: "unknown",
    nullableRowType: "unknown",
    argumentImport: "JsonValue",
    nullableArgumentImport: "JsonValue",
  },

  unknown: {
    codecSuffix: "Unknown",
    argumentType: "D1NonNullValue",
    nullableArgumentType: "D1Value",
    rowType: "unknown",
    nullableRowType: "unknown",
    argumentImport: "D1NonNullValue",
    nullableArgumentImport: "D1Value",
  },
};

// Deterministic across JavaScript engines, unlike locale-aware toLowerCase().
function asciiLower(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    output += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character;
  }
  return output;
}

export const DECLARED_TYPE_KINDS: ReadonlyMap<string, ValueKind> = new Map<string, ValueKind>([
  ["int", "integer"],
  ["integer", "integer"],
  ["tinyint", "integer"],
  ["smallint", "integer"],
  ["mediumint", "integer"],
  ["bigint", "integer"],
  ["unsignedbigint", "integer"],
  ["int2", "integer"],
  ["int8", "integer"],
  ["real", "number"],
  ["double", "number"],
  ["doubleprecision", "number"],
  ["float", "number"],
  ["numeric", "number"],
  ["decimal", "number"],
  ["text", "text"],
  ["clob", "text"],
  ["character", "text"],
  ["varchar", "text"],
  ["varyingcharacter", "text"],
  ["nchar", "text"],
  ["nativecharacter", "text"],
  ["nvarchar", "text"],
  ["date", "text"],
  ["datetime", "text"],
  ["timestamp", "text"],
  ["boolean", "boolean"],
  ["bool", "boolean"],
  ["blob", "blob"],
  ["json", "json"],
  ["jsonb", "json"],
]);

export function normalizeDeclaredTypeName(type?: Identifier): string {
  if (type === undefined || type.catalog !== "" || type.schema !== "") return "";
  const parameterStart = type.name.indexOf("(");
  const bare = parameterStart === -1 ? type.name : type.name.slice(0, parameterStart);
  let stripped = "";
  for (const character of bare) {
    const code = character.charCodeAt(0);
    if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) continue;
    stripped += character;
  }
  return asciiLower(stripped);
}

export function valueKindForColumn(column?: Column): ValueKind {
  if (column === undefined) return "unknown";
  return DECLARED_TYPE_KINDS.get(normalizeDeclaredTypeName(column.type)) ?? "unknown";
}
