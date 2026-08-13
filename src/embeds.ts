import type { Catalog, Column, Identifier } from "./gen/plugin/codegen_pb";

/** Private physical aliases are generator-owned and never part of the compatibility surface. */
export const EMBED_ALIAS_PREFIX = "d1_embed_";

/** One `<qualifier>.<column>` item of an embed expansion, as offsets into `Query.text`. */
export interface ExpansionItem {
  readonly start: number;
  readonly end: number;
}

/** The contiguous run sqlc wrote in place of one `sqlc.embed(...)` macro. */
export interface ExpansionSpan {
  readonly start: number;
  readonly end: number;
  readonly items: readonly ExpansionItem[];
}

export interface AliasedItem {
  readonly item: ExpansionItem;
  readonly alias: string;
}

function catalogKey(catalog: string, schema: string, name: string): string {
  // A NUL separator, so identifiers that contain spaces cannot fold onto one key.
  return `${catalog}\u0000${schema}\u0000${name}`;
}

/**
 * The request catalog, indexed for exact identifier lookup. It is the only source of
 * embedded-field metadata: an embed column itself carries no type and no column list.
 */
export class CatalogIndex {
  private readonly tables = new Map<string, readonly Column[]>();
  private readonly defaultSchema: string;

  constructor(catalog?: Catalog) {
    this.defaultSchema = catalog?.defaultSchema ?? "";
    for (const schema of catalog?.schemas ?? []) {
      for (const table of schema.tables) {
        if (!table.rel) continue;
        const key = catalogKey(table.rel.catalog, table.rel.schema || schema.name, table.rel.name);
        // A duplicate key is impossible for SQLite; first-wins keeps resolution deterministic.
        if (!this.tables.has(key)) this.tables.set(key, table.columns);
      }
    }
  }

  /** Exact identifier match; an empty schema falls back to the catalog's default schema. */
  resolve(embedTable: Identifier): readonly Column[] | undefined {
    return this.tables.get(catalogKey(embedTable.catalog, embedTable.schema || this.defaultSchema, embedTable.name));
  }
}

// Characters that can never occur inside a bare SQL identifier sqlc wrote into a projection.
const IDENTIFIER_STOPS = new Set([
  ",", ".", "(", ")", '"', "'", ";", "*", "+", "-", "/", "=", "<", ">", "!", "|", "&", "%", "?",
]);

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r"
    || character === "\f" || character === "\v";
}

function isAsciiLetter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function asciiLower(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    output += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character;
  }
  return output;
}

interface ReadIdentifier {
  readonly end: number;
  readonly value: string;
}

/** A double-quoted run (`""` escapes an inner quote) or a maximal bare identifier run. */
function readIdentifier(text: string, start: number): ReadIdentifier | undefined {
  if (start >= text.length) return undefined;
  if (text[start] === '"') {
    let value = "";
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 2;
          continue;
        }
        return { end: index + 1, value };
      }
      value += text[index];
      index++;
    }
    return undefined;
  }
  let index = start;
  while (index < text.length && !isWhitespace(text[index]) && !IDENTIFIER_STOPS.has(text[index])) index++;
  return index === start ? undefined : { end: index, value: text.slice(start, index) };
}

// The word immediately before an expansion decides whether it opens a select-list item.
const PROJECTION_KEYWORDS = new Set(["select", "distinct", "all", "returning"]);

function startsProjectionItem(text: string, start: number): boolean {
  let index = start - 1;
  while (index >= 0 && isWhitespace(text[index])) index--;
  if (index < 0) return false;
  if (text[index] === ",") return true;
  let wordEnd = index + 1;
  while (index >= 0 && isAsciiLetter(text[index])) index--;
  const word = text.slice(index + 1, wordEnd);
  return word.length > 0 && PROJECTION_KEYWORDS.has(asciiLower(word));
}

function endsProjectionItem(text: string, end: number): boolean {
  if (end >= text.length) return true;
  const character = text[end];
  return character === "," || character === ")" || isWhitespace(character);
}

function matchRun(text: string, start: number, columnNames: readonly string[]): ExpansionSpan | undefined {
  const items: ExpansionItem[] = [];
  let index = start;
  let qualifier: string | undefined;
  for (let position = 0; position < columnNames.length; position++) {
    if (position > 0) {
      if (text[index] !== "," || text[index + 1] !== " ") return undefined;
      index += 2;
    }
    const itemStart = index;
    const scope = readIdentifier(text, index);
    if (!scope) return undefined;
    const scopeText = text.slice(index, scope.end);
    if (position === 0) qualifier = scopeText;
    else if (scopeText !== qualifier) return undefined;
    index = scope.end;
    if (text[index] !== ".") return undefined;
    index++;
    const name = readIdentifier(text, index);
    if (!name || name.value !== columnNames[position]) return undefined;
    index = name.end;
    items.push({ start: itemStart, end: index });
  }
  return { start, end: index, items };
}

/**
 * Every place sqlc's expansion of one embedded table's column list occurs, left to right
 * and non-overlapping. Locating is exact: an inconclusive result is the caller's signal to
 * fail generation rather than alias the wrong columns.
 */
export function findEmbedExpansions(text: string, columnNames: readonly string[]): readonly ExpansionSpan[] {
  const spans: ExpansionSpan[] = [];
  if (columnNames.length === 0) return spans;
  let index = 0;
  while (index < text.length) {
    if (startsProjectionItem(text, index)) {
      const span = matchRun(text, index, columnNames);
      if (span && endsProjectionItem(text, span.end)) {
        spans.push(span);
        index = span.end;
        continue;
      }
    }
    index++;
  }
  return spans;
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.split('"').join('""')}"`;
}

/**
 * The only edit the Plugin makes to `Query.text`: ` AS "<alias>"` after each located item.
 * Every other byte, slice markers included, survives untouched.
 */
export function rewriteProjection(text: string, aliased: readonly AliasedItem[]): string {
  if (aliased.length === 0) return text;
  const ordered = [...aliased].sort((left, right) => left.item.end - right.item.end);
  let output = "";
  let cursor = 0;
  for (const { item, alias } of ordered) {
    output += text.slice(cursor, item.end) + ` AS ${quoteSqlIdentifier(alias)}`;
    cursor = item.end;
  }
  return output + text.slice(cursor);
}
