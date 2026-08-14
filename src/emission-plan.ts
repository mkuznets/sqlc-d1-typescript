import { Column, Identifier, Query } from "./gen/plugin/codegen_pb";
import { GenerationDiagnosticError, quoteDiagnosticValue, type Diagnostic } from "./diagnostics";
import {
  CatalogIndex,
  EMBED_ALIAS_PREFIX,
  findEmbedExpansions,
  rewriteProjection,
  type AliasedItem,
  type ExpansionSpan,
} from "./embeds";
import {
  RUNTIME_TYPE_IMPORT_ORDER,
  VALUE_KINDS,
  valueKindForColumn,
  type RuntimeTypeImport,
  type ValueFieldPlan,
  type ValueKind,
} from "./sqlite-types";
import { ROW_COMMANDS, type SupportedCommand, type ValidatedGeneration } from "./validation";

export type { RuntimeTypeImport, ValueFieldPlan, ValueKind };
export { RUNTIME_TYPE_IMPORT_ORDER };

// Descriptor kind per command. ":one" splits further on an INSERT target; see planQuery.
const COMMAND_KINDS: Readonly<Record<SupportedCommand, string>> = {
  ":one": "one",
  ":many": "many",
  ":exec": "exec",
  ":execrows": "exec-rows",
  ":execlastid": "exec-lastid",
  ":execresult": "exec-result",
};

// Public result type per command. Row commands derive theirs from the planned row type instead.
const COMMAND_RESULTS: Readonly<Record<Exclude<SupportedCommand, ":one" | ":many">, string>> = {
  ":exec": "void",
  ":execrows": "number",
  ":execlastid": "number",
  ":execresult": "D1Result<Record<string, unknown>>",
};

export const QUERY_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
export const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;

export interface PlannedPropertyAccess {
  readonly publicName: string;
  readonly publicNameLiteral: string;
}

export interface SlicePlan {
  readonly markerLiteral: string;
  readonly localName: string;
}

export interface ArgumentFieldPlan extends PlannedPropertyAccess, ValueFieldPlan {
  readonly firstParameterIndex: number;
  readonly bindNumber: number;
  readonly sourceName: string;
  readonly column: Column;
  readonly slice?: SlicePlan;
}

/** One mapped value: an ordinary result column, or one leaf field of an embed object. */
export interface RowValueFieldPlan extends PlannedPropertyAccess, ValueFieldPlan {
  readonly sourceName: string;
  readonly physicalKey: string;
  readonly physicalKeyLiteral: string;
  // The public path runtime failures name: "id" for a scalar, "users.id" inside an embed.
  readonly pathLiteral: string;
  readonly column: Column;
}

export interface RowScalarFieldPlan extends RowValueFieldPlan {
  readonly kind: "scalar";
  readonly columnIndex: number;
}

export interface RowEmbedFieldPlan extends PlannedPropertyAccess {
  readonly kind: "embed";
  readonly columnIndex: number;
  readonly sourceName: string;
  readonly fields: readonly RowValueFieldPlan[];
}

export type RowFieldPlan = RowScalarFieldPlan | RowEmbedFieldPlan;

export interface QueryPlan {
  readonly queryIndex: number;
  readonly command: SupportedCommand;
  readonly insert: boolean;
  readonly kindLiteral: string;
  readonly queryNameLiteral: string;
  readonly factoryReturnType: string;
  readonly sqlLiteral: string;
  readonly factoryName: string;
  readonly sqlConstantName: string;
  readonly argsTypeName?: string;
  readonly rowTypeName?: string;
  readonly parserName?: string;
  // Simultaneously the argument-property list and the bind-slot list, in bind order.
  readonly argumentFields: readonly ArgumentFieldPlan[];
  readonly rowFields: readonly RowFieldPlan[];
  readonly physicalKeyNamespace: PhysicalKeyNamespace;
}

export type RuntimeValueImport = "generatedInternals";
export const RUNTIME_VALUE_ALIAS = "d1_values";
export const RESULT_CONTEXT_ALIAS = "d1_Context";
// Underscore-bearing, like every helper binding, while query-derived bindings are alphanumeric.
export const SLICE_LOCAL_PREFIX = "d1_slice_";

export interface QueryModulePlan {
  readonly sourceFilename: string;
  readonly outputPath: string;
  readonly runtimeSpecifierLiteral: string;
  readonly runtimeTypeImports: readonly RuntimeTypeImport[];
  readonly runtimeValueImports: readonly RuntimeValueImport[];
  readonly emitsResultContext: boolean;
  readonly queries: readonly QueryPlan[];
}

export interface EmissionPlan {
  readonly runtime: { readonly outputPath: "runtime.ts" };
  readonly queryModules: readonly QueryModulePlan[];
}

export function quoteTypeScriptString(value: string): string {
  return JSON.stringify(value)
    .split(String.fromCharCode(0x2028))
    .join("\\u2028")
    .split(String.fromCharCode(0x2029))
    .join("\\u2029");
}

type Word = { text: string; acronym: boolean };

function asciiLower(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    output += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character;
  }
  return output;
}

function asciiUpperFirst(value: string): string {
  if (value.length === 0) return value;
  const code = value.charCodeAt(0);
  return code >= 97 && code <= 122 ? String.fromCharCode(code - 32) + value.slice(1) : value;
}

function tokenizeAsciiName(value: string): Word[] {
  const tokens: Word[] = [];
  for (const segment of value.split("_")) {
    let start = 0;
    for (let index = 1; index < segment.length; index++) {
      const previous = segment.charCodeAt(index - 1);
      const current = segment.charCodeAt(index);
      const next = index + 1 < segment.length ? segment.charCodeAt(index + 1) : -1;
      const previousLowerOrDigit = (previous >= 97 && previous <= 122) || (previous >= 48 && previous <= 57);
      const currentUpper = current >= 65 && current <= 90;
      const previousUpper = previous >= 65 && previous <= 90;
      const nextLower = next >= 97 && next <= 122;
      if ((previousLowerOrDigit && currentUpper) || (previousUpper && currentUpper && nextLower)) {
        const text = segment.slice(start, index);
        tokens.push({ text, acronym: /^[A-Z0-9]+$/.test(text) && /[A-Z]/.test(text) });
        start = index;
      }
    }
    const text = segment.slice(start);
    if (text) tokens.push({ text, acronym: /^[A-Z0-9]+$/.test(text) && /[A-Z]/.test(text) });
  }
  return tokens;
}

export function toQueryFactoryCamelCase(value: string): string {
  return tokenizeAsciiName(value)
    .map((word, index) => {
      if (index === 0) return asciiLower(word.text);
      if (word.acronym) return word.text;
      return asciiUpperFirst(asciiLower(word.text));
    })
    .join("");
}

export function toPublicFieldCamelCase(value: string): string {
  return tokenizeAsciiName(value)
    .map((word, index) => {
      const lowered = asciiLower(word.text);
      return index === 0 ? lowered : asciiUpperFirst(lowered);
    })
    .join("");
}

// Reserved words and context-sensitive binding restrictions across supported TS targets.
const RESERVED_BINDINGS = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

export function isReservedBinding(value: string): boolean {
  return RESERVED_BINDINGS.has(value);
}

function allocatePublicName(sourceName: string, sourceIndex: number, counts: Map<string, number>): string {
  const base = toPublicFieldCamelCase(sourceName || `column${sourceIndex + 1}`);
  const count = (counts.get(base) ?? 0) + 1;
  counts.set(base, count);
  return count === 1 ? base : `${base}_${count}`;
}

export function allocatePublicNames(sourceNames: readonly string[]): readonly string[] {
  const counts = new Map<string, number>();
  return sourceNames.map((sourceName, index) => allocatePublicName(sourceName, index, counts));
}

export function planOutputPath(sourceFilename: string): string | undefined {
  if (
    !sourceFilename ||
    sourceFilename.startsWith("/") ||
    /^[A-Za-z]:/.test(sourceFilename) ||
    sourceFilename.startsWith("\\\\") ||
    sourceFilename.includes("\\")
  )
    return undefined;
  const segments = sourceFilename.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._-]+$/.test(segment) ||
        segment.endsWith(".") ||
        isWindowsDevice(segment),
    )
  )
    return undefined;
  const basename = segments.pop()!;
  return [...segments, `${basename.replace(/\./g, "_")}.ts`].join("/");
}

function isWindowsDevice(segment: string): boolean {
  const stem = asciiLower(segment.split(".")[0]);
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(stem);
}

export function runtimeImportSpecifier(outputPath: string): string {
  const depth = outputPath.split("/").length - 1;
  return depth === 0 ? "./runtime" : `${"../".repeat(depth)}runtime`;
}

export class PhysicalKeyNamespace {
  private readonly allocated: Set<string>;

  constructor(keys: readonly string[]) {
    this.allocated = new Set(keys);
  }

  allocatePrivatePhysicalAlias(preferred: string): string {
    let candidate = preferred;
    let suffix = 2;
    while (this.allocated.has(candidate)) candidate = `${preferred}_${suffix++}`;
    this.allocated.add(candidate);
    return candidate;
  }
}

interface SymbolOwner {
  identifier: string;
  role: string;
  queryName?: string;
  queryIndex?: number;
}

export function planEmission(validated: ValidatedGeneration): EmissionPlan {
  const diagnostics: Diagnostic[] = [];
  // The only source of embedded-field metadata, built once per request.
  const catalog = new CatalogIndex(validated.request.catalog);
  const groups = new Map<string, Array<{ query: Query; index: number }>>();
  validated.request.queries.forEach((query, index) => {
    const group = groups.get(query.filename) ?? [];
    group.push({ query, index });
    groups.set(query.filename, group);
  });

  const pathOwners = new Map<string, string>();
  const foldedPathOwners = new Map<string, { path: string; source: string }>();
  pathOwners.set("runtime.ts", "generated runtime");
  foldedPathOwners.set("runtime.ts", { path: "runtime.ts", source: "generated runtime" });
  const modules: QueryModulePlan[] = [];

  const groupedEntries = [...groups.entries()].sort(([left], [right]) => compareText(left, right));
  for (const [sourceFilename, queryEntries] of groupedEntries) {
    const outputPath = planOutputPath(sourceFilename);
    if (!outputPath) {
      diagnostics.push(
        emissionError(
          "INVALID_OUTPUT_PATH",
          `source filename ${quoteDiagnosticValue(sourceFilename)} is not a safe portable relative path`,
          { filename: sourceFilename, fieldPath: "filename" },
        ),
      );
    } else {
      const exactOwner = pathOwners.get(outputPath);
      if (exactOwner !== undefined) {
        diagnostics.push(
          emissionError(
            "OUTPUT_PATH_COLLISION",
            `source files ${quoteDiagnosticValue(exactOwner)} and ${quoteDiagnosticValue(sourceFilename)} both derive output path ${quoteDiagnosticValue(outputPath)}`,
            { filename: sourceFilename, fieldPath: "filename" },
          ),
        );
      } else {
        const folded = asciiLower(outputPath);
        const portableOwner = foldedPathOwners.get(folded);
        if (portableOwner !== undefined) {
          diagnostics.push(
            emissionError(
              "PORTABLE_OUTPUT_PATH_COLLISION",
              `source files ${quoteDiagnosticValue(portableOwner.source)} and ${quoteDiagnosticValue(sourceFilename)} derive paths ${quoteDiagnosticValue(portableOwner.path)} and ${quoteDiagnosticValue(outputPath)}, which collide on case-insensitive filesystems`,
              { filename: sourceFilename, fieldPath: "filename" },
            ),
          );
        }
        pathOwners.set(outputPath, sourceFilename);
        if (!portableOwner) foldedPathOwners.set(folded, { path: outputPath, source: sourceFilename });
      }
    }

    const plannedQueries: QueryPlan[] = [];
    const importSet = new Set<RuntimeTypeImport>();
    for (const { query, index } of queryEntries) {
      const plannedQuery = planQuery(query, index, catalog, diagnostics);
      importSet.add("QueryDescriptor");
      for (const field of plannedQuery.argumentFields) {
        const required = argumentTypeImport(field);
        if (required) importSet.add(required);
      }
      plannedQueries.push(plannedQuery);
    }

    const imports = RUNTIME_TYPE_IMPORT_ORDER.filter((name) => importSet.has(name));
    const usesCodecs = plannedQueries.some((query) => query.argumentFields.length > 0 || query.rowFields.length > 0);
    const valueImports: readonly RuntimeValueImport[] = usesCodecs ? ["generatedInternals"] : [];
    const emitsResultContext = plannedQueries.some((query) => query.rowFields.length > 0);
    const helperBindings = [
      ...(usesCodecs ? [RUNTIME_VALUE_ALIAS] : []),
      ...(emitsResultContext ? [RESULT_CONTEXT_ALIAS] : []),
    ];
    validateModuleSymbols(sourceFilename, queryEntries, plannedQueries, imports, helperBindings, diagnostics);
    if (outputPath)
      modules.push({
        sourceFilename,
        outputPath,
        runtimeSpecifierLiteral: quoteTypeScriptString(runtimeImportSpecifier(outputPath)),
        runtimeTypeImports: imports,
        runtimeValueImports: valueImports,
        emitsResultContext,
        queries: plannedQueries,
      });
  }

  if (diagnostics.length > 0) throw new GenerationDiagnosticError([...validated.warnings, ...diagnostics]);
  modules.sort((left, right) => compareText(left.outputPath, right.outputPath));
  return { runtime: { outputPath: "runtime.ts" }, queryModules: modules };
}

function argumentTypeImport(field: ValueFieldPlan): RuntimeTypeImport | undefined {
  const spelling = VALUE_KINDS[field.valueKind];
  return field.nullable ? spelling.nullableArgumentImport : spelling.argumentImport;
}

function planQuery(query: Query, queryIndex: number, catalog: CatalogIndex, diagnostics: Diagnostic[]): QueryPlan {
  const context = (extra: Partial<Diagnostic> = {}): Partial<Diagnostic> => ({
    filename: query.filename,
    queryName: query.name,
    queryIndex,
    ...extra,
  });

  if (!QUERY_NAME_PATTERN.test(query.name)) {
    diagnostics.push(
      emissionError(
        "INVALID_QUERY_NAME",
        `query name ${quoteDiagnosticValue(query.name)} must match ${quoteDiagnosticValue(QUERY_NAME_PATTERN.source)}`,
        context({ fieldPath: "name" }),
      ),
    );
  }

  const factoryName = toQueryFactoryCamelCase(query.name);
  const argumentFields: ArgumentFieldPlan[] = [];
  const byBind = new Map<number, ArgumentFieldPlan>();
  const argumentCounts = new Map<string, number>();
  query.params.forEach((parameter, parameterIndex) => {
    // One logical argument is one property and one bind slot, matching SQLite's ?N reuse.
    if (byBind.has(parameter.number)) return;
    const column = parameter.column!;
    const sourceName = column.name;
    if (sourceName && !FIELD_NAME_PATTERN.test(sourceName)) {
      diagnostics.push(
        emissionError(
          "INVALID_FIELD_NAME",
          `argument name ${quoteDiagnosticValue(sourceName)} must match ${quoteDiagnosticValue(FIELD_NAME_PATTERN.source)}`,
          context({ fieldPath: `params[${parameterIndex}].column.name`, fieldIndex: parameterIndex }),
        ),
      );
    }
    const publicName = allocatePublicName(sourceName, parameterIndex, argumentCounts);
    const field: ArgumentFieldPlan = {
      firstParameterIndex: parameterIndex,
      bindNumber: parameter.number,
      sourceName,
      publicName,
      publicNameLiteral: quoteTypeScriptString(publicName),
      column,
      valueKind: valueKindForColumn(column),
      nullable: !column.notNull,
      slice: column.isSqlcSlice
        ? {
            markerLiteral: quoteTypeScriptString(`/*SLICE:${column.name}*/?`),
            localName: `${SLICE_LOCAL_PREFIX}${publicName}`,
          }
        : undefined,
    };
    argumentFields.push(field);
    byBind.set(parameter.number, field);
  });

  const command = query.cmd as SupportedCommand;
  const insert = Boolean(query.insertIntoTable);
  const kind = command === ":one" && insert ? "one-insert" : COMMAND_KINDS[command];

  // Only row commands read result columns; the exec family plans no row artifacts at all.
  // An embed's own property shares the row's allocator, so an ordinary column named
  // "users" and an embed of "users" become "users" and "users_2".
  const rowCounts = new Map<string, number>();
  const slots = !ROW_COMMANDS.has(command)
    ? []
    : query.columns.map((column, columnIndex): RowSlot => {
        const sourceName = column.name;
        const embedTable = column.embedTable;
        const nameValid = !sourceName || FIELD_NAME_PATTERN.test(sourceName);
        if (!nameValid) {
          // A schema table's name cannot be aliased in SQL the way a result column's can.
          const message = embedTable
            ? `embedded table name ${quoteDiagnosticValue(sourceName)} must match ${quoteDiagnosticValue(FIELD_NAME_PATTERN.source)}; rename the table or project its columns explicitly instead of embedding it`
            : `result name ${quoteDiagnosticValue(sourceName)} must match ${quoteDiagnosticValue(FIELD_NAME_PATTERN.source)}; add a safe ASCII SQL alias`;
          diagnostics.push(
            emissionError(
              "INVALID_FIELD_NAME",
              message,
              context({ fieldPath: `columns[${columnIndex}].name`, fieldIndex: columnIndex }),
            ),
          );
        }
        const publicName = allocatePublicName(sourceName, columnIndex, rowCounts);
        const publicNameLiteral = quoteTypeScriptString(publicName);
        if (embedTable) {
          return {
            kind: "embed",
            pending: { columnIndex, sourceName, publicName, publicNameLiteral, embedTable, nameValid },
          };
        }
        return {
          kind: "scalar",
          columnIndex,
          sourceName,
          publicName,
          publicNameLiteral,
          physicalKey: column.name,
          physicalKeyLiteral: quoteTypeScriptString(column.name),
          pathLiteral: publicNameLiteral,
          column,
          valueKind: valueKindForColumn(column),
          nullable: !column.notNull,
        };
      });

  // Private aliases are collision-safe against every physical key the same query reads.
  const physicalKeyNamespace = new PhysicalKeyNamespace(
    slots.filter((slot): slot is RowScalarFieldPlan => slot.kind === "scalar").map((slot) => slot.physicalKey),
  );
  const pendingEmbeds = slots.filter((slot): slot is EmbedSlot => slot.kind === "embed").map((slot) => slot.pending);
  const planned =
    pendingEmbeds.length === 0
      ? { fields: NO_EMBED_FIELDS, text: query.text }
      : planEmbeds(query, pendingEmbeds, catalog, physicalKeyNamespace, context, diagnostics);
  const sqlText = planned.text;
  const rowFields: readonly RowFieldPlan[] = slots.map((slot): RowFieldPlan =>
    slot.kind === "scalar"
      ? slot
      : {
          kind: "embed",
          columnIndex: slot.pending.columnIndex,
          sourceName: slot.pending.sourceName,
          publicName: slot.pending.publicName,
          publicNameLiteral: slot.pending.publicNameLiteral,
          fields: planned.fields.get(slot.pending.columnIndex) ?? [],
        },
  );

  const rowTypeName = rowFields.length > 0 ? `${query.name}Row` : undefined;
  const resultType =
    command === ":one" ? `${rowTypeName} | null` : command === ":many" ? `${rowTypeName}[]` : COMMAND_RESULTS[command];
  return {
    queryIndex,
    command,
    insert,
    kindLiteral: quoteTypeScriptString(kind),
    queryNameLiteral: quoteTypeScriptString(query.name),
    factoryReturnType: `QueryDescriptor<${resultType}>`,
    sqlLiteral: quoteTypeScriptString(sqlText),
    factoryName,
    sqlConstantName: `${factoryName}Query`,
    argsTypeName: argumentFields.length > 0 ? `${query.name}Args` : undefined,
    rowTypeName,
    parserName: rowFields.length > 0 ? `parse${query.name}Row` : undefined,
    argumentFields,
    rowFields,
    physicalKeyNamespace,
  };
}

interface PendingEmbed {
  readonly columnIndex: number;
  readonly sourceName: string;
  readonly publicName: string;
  readonly publicNameLiteral: string;
  readonly embedTable: Identifier;
  readonly nameValid: boolean;
}

interface EmbedSlot {
  readonly kind: "embed";
  readonly pending: PendingEmbed;
}

// One planned result column before its embedded fields are known.
type RowSlot = RowScalarFieldPlan | EmbedSlot;

interface ResolvedEmbed extends PendingEmbed {
  readonly columns: readonly Column[];
}

interface PlannedEmbeds {
  readonly fields: ReadonlyMap<number, readonly RowValueFieldPlan[]>;
  readonly text: string;
}

const NO_EMBED_FIELDS: PlannedEmbeds["fields"] = new Map();

function describeEmbedTable(embedTable: Identifier): string {
  return quoteDiagnosticValue(embedTable.name);
}

/**
 * Resolves each embed against the catalog, locates the projection sqlc already expanded,
 * and gives every embedded column a private alias so colliding physical result names stay
 * distinguishable. Anything inconclusive fails generation instead of guessing.
 */
function planEmbeds(
  query: Query,
  pending: readonly PendingEmbed[],
  catalog: CatalogIndex,
  namespace: PhysicalKeyNamespace,
  context: (extra?: Partial<Diagnostic>) => Partial<Diagnostic>,
  diagnostics: Diagnostic[],
): PlannedEmbeds {
  const before = diagnostics.length;
  const resolved: ResolvedEmbed[] = [];
  // An embed whose own name is already unusable was reported by the caller; it still
  // suppresses location, because a partially planned query is never rewritten.
  let failed = pending.some((embed) => !embed.nameValid);
  for (const embed of pending) {
    if (!embed.nameValid) continue;
    const at = context({ fieldPath: `columns[${embed.columnIndex}].embedTable`, fieldIndex: embed.columnIndex });
    const described = describeEmbedTable(embed.embedTable);
    const columns = catalog.resolve(embed.embedTable);
    if (!columns) {
      diagnostics.push(
        emissionError(
          "UNKNOWN_EMBED_TABLE",
          `embedded table ${described} is not in the request catalog; embed a schema table instead`,
          at,
        ),
      );
      continue;
    }
    if (columns.length === 0) {
      diagnostics.push(emissionError("EMPTY_EMBED_TABLE", `embedded table ${described} has no columns`, at));
      continue;
    }
    const seen = new Set<string>();
    let valid = true;
    for (const column of columns) {
      if (seen.has(column.name)) {
        diagnostics.push(
          emissionError(
            "DUPLICATE_EMBED_COLUMN",
            `embedded table ${described} repeats column name ${quoteDiagnosticValue(column.name)}, so its embedded fields cannot be told apart`,
            at,
          ),
        );
        valid = false;
        break;
      }
      seen.add(column.name);
    }
    if (valid)
      for (const column of columns) {
        if (FIELD_NAME_PATTERN.test(column.name)) continue;
        // Unlike an ordinary result column, a schema column cannot be fixed with a SQL alias.
        diagnostics.push(
          emissionError(
            "INVALID_FIELD_NAME",
            `embedded column ${quoteDiagnosticValue(column.name)} of table ${described} must match ${quoteDiagnosticValue(FIELD_NAME_PATTERN.source)}; rename the column or project it explicitly instead of embedding it`,
            at,
          ),
        );
        valid = false;
      }
    if (valid) resolved.push({ ...embed, columns });
  }
  // One metadata failure is the whole story for this query: without a resolved column list
  // there is nothing to locate, and a cascade of location failures would only obscure it.
  if (failed || diagnostics.length !== before) return { fields: NO_EMBED_FIELDS, text: query.text };

  const reportAmbiguous = (embed: ResolvedEmbed, message: string): void => {
    failed = true;
    diagnostics.push(
      emissionError(
        "AMBIGUOUS_EMBED_PROJECTION",
        message,
        context({
          fieldPath: `columns[${embed.columnIndex}].embedTable`,
          fieldIndex: embed.columnIndex,
        }),
      ),
    );
  };

  // Every embed of one table expands identically, so a table's spans are counted together
  // and then handed out in text order, which is the order sqlc projected them in. Grouping
  // uses the catalog's own identity, so how each embed spelled the schema cannot split it.
  const groups = new Map<string, ResolvedEmbed[]>();
  for (const embed of resolved) {
    const group = groups.get(catalog.key(embed.embedTable)) ?? [];
    group.push(embed);
    groups.set(catalog.key(embed.embedTable), group);
  }
  const spans = new Map<number, ExpansionSpan>();
  for (const group of groups.values()) {
    const located = findEmbedExpansions(
      query.text,
      group[0].columns.map((column) => column.name),
    );
    if (located.length !== group.length) {
      for (const embed of group) {
        reportAmbiguous(
          embed,
          `the expanded projection of embedded table ${describeEmbedTable(embed.embedTable)} was found ${located.length} ${located.length === 1 ? "time" : "times"} but is embedded ${group.length} ${group.length === 1 ? "time" : "times"}; give the other projected columns explicit SQL aliases so the embedded columns can be identified`,
        );
      }
      continue;
    }
    group.forEach((embed, index) => spans.set(embed.columnIndex, located[index]));
  }
  if (failed) return { fields: NO_EMBED_FIELDS, text: query.text };

  // Projection order is column order, so each assigned span must start after the one before.
  let previousEnd = 0;
  for (const embed of resolved) {
    const span = spans.get(embed.columnIndex)!;
    if (span.start < previousEnd) {
      reportAmbiguous(
        embed,
        `the expanded projection of embedded table ${describeEmbedTable(embed.embedTable)} overlaps or precedes the projection of an earlier embedded table; give the other projected columns explicit SQL aliases so the embedded columns can be identified`,
      );
    }
    previousEnd = span.end;
  }
  if (failed) return { fields: NO_EMBED_FIELDS, text: query.text };

  const fields = new Map<number, readonly RowValueFieldPlan[]>();
  const aliased: AliasedItem[] = [];
  resolved.forEach((embed, embedOrdinal) => {
    const span = spans.get(embed.columnIndex)!;
    // Each embed object allocates its field names from its own counter, so a collision
    // inside one table cannot disturb the row's other properties.
    const counts = new Map<string, number>();
    fields.set(
      embed.columnIndex,
      embed.columns.map((column, columnOrdinal): RowValueFieldPlan => {
        const alias = namespace.allocatePrivatePhysicalAlias(`${EMBED_ALIAS_PREFIX}${embedOrdinal}_${columnOrdinal}`);
        aliased.push({ item: span.items[columnOrdinal], alias });
        const publicName = allocatePublicName(column.name, columnOrdinal, counts);
        return {
          sourceName: column.name,
          publicName,
          publicNameLiteral: quoteTypeScriptString(publicName),
          physicalKey: alias,
          physicalKeyLiteral: quoteTypeScriptString(alias),
          pathLiteral: quoteTypeScriptString(`${embed.publicName}.${publicName}`),
          column,
          valueKind: valueKindForColumn(column),
          nullable: !column.notNull,
        };
      }),
    );
  });
  return { fields, text: rewriteProjection(query.text, aliased) };
}

function validateModuleSymbols(
  filename: string,
  queryEntries: readonly { query: Query; index: number }[],
  plans: readonly QueryPlan[],
  imports: readonly RuntimeTypeImport[],
  helperBindings: readonly string[],
  diagnostics: Diagnostic[],
): void {
  const owners: SymbolOwner[] = [
    ...imports.map((identifier) => ({ identifier, role: "runtime import" })),
    ...helperBindings.map((identifier) => ({ identifier, role: "runtime helper" })),
  ];

  plans.forEach((plan, planIndex) => {
    const { query, index } = queryEntries[planIndex];
    const declarations: Array<[string | undefined, string]> = [
      [plan.factoryName, "factory"],
      [plan.sqlConstantName, "SQL constant"],
      [plan.argsTypeName, "arguments type"],
      [plan.rowTypeName, "row type"],
      [plan.parserName, "row parser"],
    ];
    for (const [identifier, role] of declarations)
      if (identifier) {
        if (isReservedBinding(identifier)) {
          diagnostics.push(
            emissionError(
              "RESERVED_DECLARATION",
              `query ${quoteDiagnosticValue(query.name)} derives reserved ${role} binding ${quoteDiagnosticValue(identifier)}`,
              { filename, queryName: query.name, queryIndex: index, fieldPath: "name" },
            ),
          );
        }
        owners.push({ identifier, role, queryName: query.name, queryIndex: index });
      }
  });

  const byIdentifier = new Map<string, SymbolOwner[]>();
  for (const owner of owners) {
    const matching = byIdentifier.get(owner.identifier) ?? [];
    matching.push(owner);
    byIdentifier.set(owner.identifier, matching);
  }

  for (const [identifier, matching] of [...byIdentifier.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    if (matching.length < 2) continue;
    matching.sort(compareSymbolOwners);
    const first = matching[0];
    for (const owner of matching.slice(1)) {
      diagnostics.push(
        emissionError(
          "DECLARATION_COLLISION",
          `${describeOwner(first)} and ${describeOwner(owner)} both derive module binding ${quoteDiagnosticValue(identifier)}; rename a query`,
          {
            filename,
            queryName: owner.queryName,
            queryIndex: owner.queryIndex,
            fieldPath: "name",
          },
        ),
      );
    }
  }
}

function compareSymbolOwners(left: SymbolOwner, right: SymbolOwner): number {
  const leftImported = left.queryName === undefined ? 0 : 1;
  const rightImported = right.queryName === undefined ? 0 : 1;
  return (
    leftImported - rightImported ||
    compareText(left.queryName ?? "", right.queryName ?? "") ||
    compareText(left.role, right.role) ||
    (left.queryIndex ?? -1) - (right.queryIndex ?? -1)
  );
}

function describeOwner(owner: SymbolOwner): string {
  return owner.queryName === undefined
    ? owner.role
    : `${owner.role} for query ${quoteDiagnosticValue(owner.queryName)}`;
}

function emissionError(reason: string, message: string, context: Partial<Diagnostic> = {}): Diagnostic {
  return { severity: "error", category: "EMISSION", reason, message, ...context };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
