import type { Column, Identifier } from "./gen/plugin/codegen_pb";

export type ValueKind = "integer" | "number" | "text" | "boolean" | "blob" | "json" | "unknown";

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
