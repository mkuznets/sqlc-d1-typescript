import { Column, Query } from "./gen/plugin/codegen_pb";
import {
  GenerationDiagnosticError,
  quoteDiagnosticValue,
  type Diagnostic,
} from "./diagnostics";
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

export interface RowFieldPlan extends PlannedPropertyAccess, ValueFieldPlan {
  readonly columnIndex: number;
  readonly sourceName: string;
  readonly physicalKey: string;
  readonly physicalKeyLiteral: string;
  readonly column: Column;
}

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
    .split(String.fromCharCode(0x2028)).join("\\u2028")
    .split(String.fromCharCode(0x2029)).join("\\u2029");
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
  return tokenizeAsciiName(value).map((word, index) => {
    if (index === 0) return asciiLower(word.text);
    if (word.acronym) return word.text;
    return asciiUpperFirst(asciiLower(word.text));
  }).join("");
}

export function toPublicFieldCamelCase(value: string): string {
  return tokenizeAsciiName(value).map((word, index) => {
    const lowered = asciiLower(word.text);
    return index === 0 ? lowered : asciiUpperFirst(lowered);
  }).join("");
}

// Reserved words and context-sensitive binding restrictions across supported TS targets.
const RESERVED_BINDINGS = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "eval", "export", "extends",
  "false", "finally", "for", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "package", "private", "protected", "public", "return",
  "static", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void",
  "while", "with", "yield",
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
  if (!sourceFilename || sourceFilename.startsWith("/") || /^[A-Za-z]:/.test(sourceFilename)
    || sourceFilename.startsWith("\\\\") || sourceFilename.includes("\\")) return undefined;
  const segments = sourceFilename.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || !/^[A-Za-z0-9._-]+$/.test(segment) || segment.endsWith(".") || isWindowsDevice(segment))) return undefined;
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
      diagnostics.push(emissionError("INVALID_OUTPUT_PATH", `source filename ${quoteDiagnosticValue(sourceFilename)} is not a safe portable relative path`, { filename: sourceFilename, fieldPath: "filename" }));
    } else {
      const exactOwner = pathOwners.get(outputPath);
      if (exactOwner !== undefined) {
        diagnostics.push(emissionError("OUTPUT_PATH_COLLISION", `source files ${quoteDiagnosticValue(exactOwner)} and ${quoteDiagnosticValue(sourceFilename)} both derive output path ${quoteDiagnosticValue(outputPath)}`, { filename: sourceFilename, fieldPath: "filename" }));
      } else {
        const folded = asciiLower(outputPath);
        const portableOwner = foldedPathOwners.get(folded);
        if (portableOwner !== undefined) {
          diagnostics.push(emissionError("PORTABLE_OUTPUT_PATH_COLLISION", `source files ${quoteDiagnosticValue(portableOwner.source)} and ${quoteDiagnosticValue(sourceFilename)} derive paths ${quoteDiagnosticValue(portableOwner.path)} and ${quoteDiagnosticValue(outputPath)}, which collide on case-insensitive filesystems`, { filename: sourceFilename, fieldPath: "filename" }));
        }
        pathOwners.set(outputPath, sourceFilename);
        if (!portableOwner) foldedPathOwners.set(folded, { path: outputPath, source: sourceFilename });
      }
    }

    const plannedQueries: QueryPlan[] = [];
    const importSet = new Set<RuntimeTypeImport>();
    for (const { query, index } of queryEntries) {
      const plannedQuery = planQuery(query, index, diagnostics);
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
    if (outputPath) modules.push({
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

function planQuery(query: Query, queryIndex: number, diagnostics: Diagnostic[]): QueryPlan {
  const context = (extra: Partial<Diagnostic> = {}): Partial<Diagnostic> => ({ filename: query.filename, queryName: query.name, queryIndex, ...extra });
  if (!QUERY_NAME_PATTERN.test(query.name)) {
    diagnostics.push(emissionError("INVALID_QUERY_NAME", `query name ${quoteDiagnosticValue(query.name)} must match ${quoteDiagnosticValue(QUERY_NAME_PATTERN.source)}`, context({ fieldPath: "name" })));
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
      diagnostics.push(emissionError("INVALID_FIELD_NAME", `argument name ${quoteDiagnosticValue(sourceName)} must match ${quoteDiagnosticValue(FIELD_NAME_PATTERN.source)}`, context({ fieldPath: `params[${parameterIndex}].column.name`, fieldIndex: parameterIndex })));
    }
    const publicName = allocatePublicName(sourceName, parameterIndex, argumentCounts);
    const field: ArgumentFieldPlan = {
      firstParameterIndex: parameterIndex, bindNumber: parameter.number, sourceName, publicName,
      publicNameLiteral: quoteTypeScriptString(publicName), column,
      valueKind: valueKindForColumn(column), nullable: !column.notNull,
      slice: column.isSqlcSlice
        ? { markerLiteral: quoteTypeScriptString(`/*SLICE:${column.name}*/?`), localName: `${SLICE_LOCAL_PREFIX}${publicName}` }
        : undefined,
    };
    argumentFields.push(field);
    byBind.set(parameter.number, field);
  });

  const command = query.cmd as SupportedCommand;
  const insert = Boolean(query.insertIntoTable);
  const kind = command === ":one" && insert ? "one-insert" : COMMAND_KINDS[command];

  // Only row commands read result columns; the exec family plans no row artifacts at all.
  const rowCounts = new Map<string, number>();
  const rowFields = !ROW_COMMANDS.has(command) ? [] : query.columns.map((column, columnIndex): RowFieldPlan => {
    const sourceName = column.name;
    if (sourceName && !FIELD_NAME_PATTERN.test(sourceName)) {
      diagnostics.push(emissionError("INVALID_FIELD_NAME", `result name ${quoteDiagnosticValue(sourceName)} must match ${quoteDiagnosticValue(FIELD_NAME_PATTERN.source)}; add a safe ASCII SQL alias`, context({ fieldPath: `columns[${columnIndex}].name`, fieldIndex: columnIndex })));
    }
    const publicName = allocatePublicName(sourceName, columnIndex, rowCounts);
    return { columnIndex, sourceName, publicName, publicNameLiteral: quoteTypeScriptString(publicName), physicalKey: column.name, physicalKeyLiteral: quoteTypeScriptString(column.name), column, valueKind: valueKindForColumn(column), nullable: !column.notNull };
  });

  const rowTypeName = rowFields.length > 0 ? `${query.name}Row` : undefined;
  const resultType = command === ":one" ? `${rowTypeName} | null`
    : command === ":many" ? `${rowTypeName}[]`
    : COMMAND_RESULTS[command];
  return {
    queryIndex,
    command,
    insert,
    kindLiteral: quoteTypeScriptString(kind),
    queryNameLiteral: quoteTypeScriptString(query.name),
    factoryReturnType: `QueryDescriptor<${resultType}>`,
    sqlLiteral: quoteTypeScriptString(query.text),
    factoryName,
    sqlConstantName: `${factoryName}Query`,
    argsTypeName: argumentFields.length > 0 ? `${query.name}Args` : undefined,
    rowTypeName,
    parserName: rowFields.length > 0 ? `parse${query.name}Row` : undefined,
    argumentFields,
    rowFields,
    physicalKeyNamespace: new PhysicalKeyNamespace(rowFields.map((field) => field.physicalKey)),
  };
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
      [plan.factoryName, "factory"], [plan.sqlConstantName, "SQL constant"],
      [plan.argsTypeName, "arguments type"], [plan.rowTypeName, "row type"], [plan.parserName, "row parser"],
    ];
    for (const [identifier, role] of declarations) if (identifier) {
      if (isReservedBinding(identifier)) {
        diagnostics.push(emissionError("RESERVED_DECLARATION", `query ${quoteDiagnosticValue(query.name)} derives reserved ${role} binding ${quoteDiagnosticValue(identifier)}`, { filename, queryName: query.name, queryIndex: index, fieldPath: "name" }));
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
  for (const [identifier, matching] of [...byIdentifier.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (matching.length < 2) continue;
    matching.sort(compareSymbolOwners);
    const first = matching[0];
    for (const owner of matching.slice(1)) {
      diagnostics.push(emissionError("DECLARATION_COLLISION", `${describeOwner(first)} and ${describeOwner(owner)} both derive module binding ${quoteDiagnosticValue(identifier)}; rename a query`, {
        filename, queryName: owner.queryName, queryIndex: owner.queryIndex, fieldPath: "name",
      }));
    }
  }
}

function compareSymbolOwners(left: SymbolOwner, right: SymbolOwner): number {
  const leftImported = left.queryName === undefined ? 0 : 1;
  const rightImported = right.queryName === undefined ? 0 : 1;
  return leftImported - rightImported
    || compareText(left.queryName ?? "", right.queryName ?? "")
    || compareText(left.role, right.role)
    || (left.queryIndex ?? -1) - (right.queryIndex ?? -1);
}

function describeOwner(owner: SymbolOwner): string {
  return owner.queryName === undefined ? owner.role : `${owner.role} for query ${quoteDiagnosticValue(owner.queryName)}`;
}

function emissionError(reason: string, message: string, context: Partial<Diagnostic> = {}): Diagnostic {
  return { severity: "error", category: "EMISSION", reason, message, ...context };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
