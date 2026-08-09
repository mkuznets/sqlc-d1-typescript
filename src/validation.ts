import { Column, GenerateRequest, Identifier, Query } from "./gen/plugin/codegen_pb";
import {
  GenerationDiagnosticError,
  quoteDiagnosticValue,
  type Diagnostic,
} from "./diagnostics";

export const MINIMUM_SQLC_VERSION = "1.18.0";
export const TESTED_SQLC_VERSION = "1.31.1";
export const SUPPORTED_COMMANDS = [":one", ":many", ":exec", ":execrows", ":execlastid", ":execresult"] as const;

export interface ValidatedGeneration {
  request: GenerateRequest;
  options: { interface: "workers" };
  warnings: Diagnostic[];
}

interface SemVer {
  core: [string, string, string];
  prerelease: string[];
}

const minimumVersion = parseSemVer(MINIMUM_SQLC_VERSION)!;
const testedVersion = parseSemVer(TESTED_SQLC_VERSION)!;

export function validateGenerateRequest(request: GenerateRequest): ValidatedGeneration {
  const diagnostics: Diagnostic[] = [];
  const options = decodeOptions(request.pluginOptions, diagnostics);

  let compatible = true;
  if (!request.settings) {
    diagnostics.push(error("PROTOCOL", "MISSING_SETTINGS", "request settings are required"));
    compatible = false;
  } else if (request.settings.engine !== "sqlite") {
    diagnostics.push(error(
      "COMPATIBILITY",
      "UNSUPPORTED_ENGINE",
      `engine ${quoteDiagnosticValue(request.settings.engine)} is unsupported; supported engine: ${quoteDiagnosticValue("sqlite")}`,
    ));
    compatible = false;
  }

  let version: SemVer | undefined;
  if (!request.sqlcVersion) {
    diagnostics.push(error("COMPATIBILITY", "MISSING_SQLC_VERSION", "sqlc version is required"));
    compatible = false;
  } else {
    version = parseSemVer(request.sqlcVersion);
    if (!version) {
      diagnostics.push(error(
        "COMPATIBILITY",
        "MALFORMED_SQLC_VERSION",
        `sqlc version ${quoteDiagnosticValue(request.sqlcVersion)} is not a valid semantic version`,
      ));
      compatible = false;
    } else if (compareSemVer(version, minimumVersion) < 0) {
      diagnostics.push(error(
        "COMPATIBILITY",
        "UNSUPPORTED_SQLC_VERSION",
        `sqlc ${quoteDiagnosticValue(request.sqlcVersion)} is older than the minimum supported version v${MINIMUM_SQLC_VERSION}`,
      ));
      compatible = false;
    } else if (compareSemVer(version, testedVersion) > 0) {
      diagnostics.push({
        severity: "warning",
        category: "COMPATIBILITY",
        reason: "UNTESTED_SQLC_VERSION",
        message: `sqlc ${quoteDiagnosticValue(request.sqlcVersion)} is newer than the tested ceiling v${TESTED_SQLC_VERSION}; generation will continue`,
      });
    }
  }

  if (compatible) {
    request.queries.forEach((query, queryIndex) => validateQuery(query, queryIndex, diagnostics));
  }

  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new GenerationDiagnosticError(diagnostics);
  return {
    request,
    options: options ?? { interface: "workers" },
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === "warning"),
  };
}

function decodeOptions(bytes: Uint8Array, diagnostics: Diagnostic[]): { interface: "workers" } | undefined {
  if (bytes.length === 0) return { interface: "workers" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    diagnostics.push(error("OPTIONS", "INVALID_UTF8", "Plugin options must be valid UTF-8"));
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    diagnostics.push(error("OPTIONS", "MALFORMED_JSON", "Plugin options must be valid JSON"));
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push(error("OPTIONS", "NON_OBJECT", "Plugin options must be a JSON object"));
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "interface").sort(compareText);
  for (const key of unknownKeys) {
    diagnostics.push(error(
      "OPTIONS",
      "UNKNOWN_OPTION",
      `option ${quoteDiagnosticValue(key)} is unknown; supported option: ${quoteDiagnosticValue("interface")}`,
      { fieldPath: key },
    ));
  }
  if (Object.prototype.hasOwnProperty.call(record, "interface") && record.interface !== "workers") {
    diagnostics.push(error(
      "OPTIONS",
      "UNSUPPORTED_INTERFACE",
      `interface option must be ${quoteDiagnosticValue("workers")}`,
      { fieldPath: "interface" },
    ));
  }
  if (unknownKeys.length > 0 || (Object.prototype.hasOwnProperty.call(record, "interface") && record.interface !== "workers")) {
    return undefined;
  }
  return { interface: "workers" };
}

export function parseSemVer(value: string): SemVer | undefined {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) return undefined;
  return { core: [match[1], match[2], match[3]], prerelease };
}

export function compareSemVer(left: SemVer, right: SemVer): number {
  for (let index = 0; index < 3; index++) {
    const comparison = compareNumericText(left.core[index], right.core[index]);
    if (comparison !== 0) return comparison;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const comparison = compareNumericText(a, b);
      if (comparison !== 0) return comparison;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else {
      const comparison = compareText(a, b);
      if (comparison !== 0) return comparison;
    }
  }
  return 0;
}

function compareNumericText(left: string, right: string): number {
  return left.length - right.length || compareText(left, right);
}

function validateQuery(query: Query, queryIndex: number, diagnostics: Diagnostic[]): void {
  const start = diagnostics.length;
  const context = (extra: Partial<Diagnostic> = {}): Partial<Diagnostic> => ({
    filename: query.filename || undefined,
    queryName: query.name || undefined,
    queryIndex,
    ...extra,
  });

  if (!query.filename) diagnostics.push(error("QUERY", "MISSING_FILENAME", "query filename is required", context({ fieldPath: "filename" })));
  if (!query.name) diagnostics.push(error("QUERY", "MISSING_NAME", "query name is required", context({ fieldPath: "name" })));
  if (!query.cmd) diagnostics.push(error("QUERY", "MISSING_COMMAND", "query command is required", context({ fieldPath: "cmd" })));
  if (!query.text) diagnostics.push(error("QUERY", "MISSING_SQL", "query SQL is required", context({ fieldPath: "text" })));

  const supported = (SUPPORTED_COMMANDS as readonly string[]).includes(query.cmd);
  if (query.cmd && !supported) {
    diagnostics.push(error(
      "QUERY",
      "UNSUPPORTED_COMMAND",
      `command ${quoteDiagnosticValue(query.cmd)} is unsupported; supported commands: ${SUPPORTED_COMMANDS.join(", ")}`,
      context({ fieldPath: "cmd" }),
    ));
  }

  const priorBinds = new Map<number, { column: Column; index: number }>();
  query.params.forEach((parameter, parameterIndex) => {
    if (!parameter.column) {
      diagnostics.push(error("QUERY", "MISSING_PARAMETER_COLUMN", "parameter column metadata is required", context({ fieldPath: `params[${parameterIndex}].column`, fieldIndex: parameterIndex })));
    }
    if (parameter.number <= 0) {
      diagnostics.push(error("QUERY", "INVALID_BIND_NUMBER", `bind number ${quoteDiagnosticValue(String(parameter.number))} must be positive`, context({ fieldPath: `params[${parameterIndex}].number`, fieldIndex: parameterIndex })));
    } else if (parameter.column) {
      const prior = priorBinds.get(parameter.number);
      if (prior && !columnsEquivalent(prior.column, parameter.column)) {
        diagnostics.push(error(
          "QUERY",
          "CONFLICTING_BIND_NUMBER",
          `bind number ${quoteDiagnosticValue(String(parameter.number))} has conflicting metadata at parameter positions ${prior.index + 1} and ${parameterIndex + 1}`,
          context({ fieldPath: `params[${parameterIndex}]`, fieldIndex: parameterIndex }),
        ));
      } else if (!prior) {
        priorBinds.set(parameter.number, { column: parameter.column, index: parameterIndex });
      }
    }
  });

  if (query.text) validateSlices(query, queryIndex, diagnostics);
  validateEmbeds(query, queryIndex, diagnostics);

  if ((query.cmd === ":one" || query.cmd === ":many") && query.columns.length === 0) {
    diagnostics.push(error("QUERY", "MISSING_RESULT_COLUMNS", `command ${quoteDiagnosticValue(query.cmd)} requires at least one result column`, context({ fieldPath: "columns" })));
  }
  const physicalColumns = new Map<string, number>();
  query.columns.forEach((column, columnIndex) => {
    if (!column.name) return;
    const prior = physicalColumns.get(column.name);
    if (prior !== undefined) {
      diagnostics.push(error(
        "QUERY",
        "DUPLICATE_PHYSICAL_COLUMN",
        `physical result key ${quoteDiagnosticValue(column.name)} is repeated at column positions ${prior + 1} and ${columnIndex + 1}; add a unique SQL alias`,
        context({ fieldPath: `columns[${columnIndex}].name`, fieldIndex: columnIndex }),
      ));
    } else {
      physicalColumns.set(column.name, columnIndex);
    }
  });

  if (diagnostics.slice(start).some((diagnostic) => diagnostic.severity === "error")) return;
  if ([":execrows", ":execlastid", ":execresult"].includes(query.cmd)) {
    diagnostics.push(error("EMISSION", "UNIMPLEMENTED_COMMAND", `command ${quoteDiagnosticValue(query.cmd)} is recognized but not yet renderable`, context({ fieldPath: "cmd" })));
  }
  if (query.params.some((parameter) => parameter.column?.isSqlcSlice)) {
    diagnostics.push(error("EMISSION", "UNIMPLEMENTED_SLICE", "sqlc slice parameters are recognized but not yet renderable", context({ fieldPath: "params" })));
  }
  if (query.columns.some((column) => column.embedTable !== undefined)) {
    diagnostics.push(error("EMISSION", "UNIMPLEMENTED_EMBED", "sqlc embed columns are recognized but not yet renderable", context({ fieldPath: "columns" })));
  }
}

function validateSlices(query: Query, queryIndex: number, diagnostics: Diagnostic[]): void {
  const slices = query.params
    .map((parameter, index) => ({ column: parameter.column, index }))
    .filter((item): item is { column: Column; index: number } => item.column?.isSqlcSlice === true);
  const markers: Array<{ name: string; index: number }> = [];
  const pattern = /\/\*SLICE:([^*]*)\*\/\?/g;
  for (let match = pattern.exec(query.text); match; match = pattern.exec(query.text)) {
    markers.push({ name: match[1], index: markers.length });
  }
  const base = { filename: query.filename || undefined, queryName: query.name || undefined, queryIndex };
  for (const slice of slices) {
    if (!slice.column.name) {
      diagnostics.push(error("QUERY", "SLICE_METADATA_MISMATCH", "slice parameter name is required", { ...base, fieldPath: `params[${slice.index}].column.name`, fieldIndex: slice.index }));
      continue;
    }
    const matchingMarkers = markers.filter((marker) => marker.name === slice.column.name).length;
    const matchingSlices = slices.filter((candidate) => candidate.column.name === slice.column.name).length;
    if (matchingMarkers === 0 || matchingSlices !== 1) {
      diagnostics.push(error(
        "QUERY",
        "SLICE_METADATA_MISMATCH",
        `slice parameter ${quoteDiagnosticValue(slice.column.name)} must map unambiguously to a SQL slice marker`,
        { ...base, fieldPath: `params[${slice.index}].column.isSqlcSlice`, fieldIndex: slice.index },
      ));
    }
  }
  for (const marker of markers) {
    const matchingSlices = slices.filter((slice) => slice.column.name === marker.name).length;
    const matchingMarkers = markers.filter((candidate) => candidate.name === marker.name).length;
    if (matchingSlices !== 1 || matchingMarkers !== 1) {
      diagnostics.push(error(
        "QUERY",
        "SLICE_METADATA_MISMATCH",
        `SQL slice marker ${quoteDiagnosticValue(marker.name)} must map unambiguously to one slice parameter`,
        { ...base, fieldPath: `sliceMarkers[${marker.index}]`, fieldIndex: marker.index },
      ));
    }
  }
}

function validateEmbeds(query: Query, queryIndex: number, diagnostics: Diagnostic[]): void {
  query.columns.forEach((column, columnIndex) => {
    if (!column.embedTable) return;
    if (!column.name || !column.embedTable.name) {
      diagnostics.push(error(
        "QUERY",
        "INVALID_EMBED_METADATA",
        "embed column requires a logical column name and a nonempty embed table name",
        {
          filename: query.filename || undefined,
          queryName: query.name || undefined,
          queryIndex,
          fieldPath: `columns[${columnIndex}].embedTable`,
          fieldIndex: columnIndex,
        },
      ));
    }
  });
}

function columnsEquivalent(left: Column, right: Column): boolean {
  const identifier = (value?: Identifier) => value === undefined ? undefined : [value.catalog, value.schema, value.name];
  const projection = (column: Column) => [
    column.name, column.notNull, column.isArray, column.length, column.isNamedParam,
    column.isFuncCall, column.scope, identifier(column.table), column.tableAlias,
    identifier(column.type), column.isSqlcSlice, identifier(column.embedTable),
    column.originalName, column.unsigned, column.arrayDims,
  ];
  return JSON.stringify(projection(left)) === JSON.stringify(projection(right));
}

function error(
  category: Diagnostic["category"],
  reason: string,
  message: string,
  context: Partial<Diagnostic> = {},
): Diagnostic {
  return { severity: "error", category, reason, message, ...context };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
