export type DiagnosticSeverity = "error" | "warning";
export type DiagnosticCategory =
  | "PROTOCOL"
  | "OPTIONS"
  | "COMPATIBILITY"
  | "QUERY"
  | "EMISSION"
  | "INTERNAL";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  reason: string;
  message: string;
  filename?: string;
  queryName?: string;
  queryIndex?: number;
  fieldPath?: string;
  fieldIndex?: number;
}

export const PLUGIN_NAME = "sqlc-d1-typescript";
export const PLUGIN_BUILD_IDENTITY = "development";
export const PLUGIN_ISSUE_REPORT_URL = "https://github.com/mkuznets/sqlc-d1-typescript/issues";

const CATEGORY_RANK: Record<DiagnosticCategory, number> = {
  PROTOCOL: 0,
  OPTIONS: 1,
  COMPATIBILITY: 2,
  QUERY: 3,
  EMISSION: 4,
  INTERNAL: 5,
};

export class GenerationDiagnosticError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super("generation failed");
    this.name = "GenerationDiagnosticError";
    this.diagnostics = diagnostics;
  }
}

export function quoteDiagnosticValue(value: string): string {
  let output = '"';
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    switch (code) {
      case 0x22: output += '\\"'; break;
      case 0x5c: output += "\\\\"; break;
      case 0x0a: output += "\\n"; break;
      case 0x0d: output += "\\r"; break;
      case 0x09: output += "\\t"; break;
      default:
        if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
          output += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
          output += value[index];
        }
    }
  }
  return `${output}"`;
}

function compareText(left = "", right = ""): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOptionalNumber(left?: number, right?: number): number {
  const a = left ?? -1;
  const b = right ?? -1;
  return a - b;
}

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((left, right) =>
    CATEGORY_RANK[left.category] - CATEGORY_RANK[right.category]
    || compareText(left.filename, right.filename)
    || compareText(left.queryName, right.queryName)
    || compareOptionalNumber(left.queryIndex, right.queryIndex)
    || compareOptionalNumber(left.fieldIndex, right.fieldIndex)
    || compareText(left.fieldPath, right.fieldPath)
    || compareText(left.reason, right.reason));
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function heading(diagnostic: Diagnostic): string {
  let output = `[${diagnostic.category}/${diagnostic.reason}]`;
  const contexts: string[] = [];
  if (diagnostic.filename !== undefined) contexts.push(`file ${quoteDiagnosticValue(diagnostic.filename)}`);
  if (diagnostic.queryName !== undefined) contexts.push(`query ${quoteDiagnosticValue(diagnostic.queryName)}`);
  if (diagnostic.fieldPath !== undefined) contexts.push(`field ${quoteDiagnosticValue(diagnostic.fieldPath)}`);
  if (diagnostic.fieldIndex !== undefined) contexts.push(`position ${diagnostic.fieldIndex + 1}`);
  if (contexts.length > 0) output += ` ${contexts.join(", ")}:`;
  return output;
}

function renderSection(title: string, diagnostics: Diagnostic[]): string {
  return `${title}:\n${diagnostics.map((diagnostic) => `${heading(diagnostic)}\n${diagnostic.message}`).join("\n\n")}`;
}

export function renderFailureDiagnostics(diagnostics: readonly Diagnostic[]): string {
  const errors = sortDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity === "error"));
  const warnings = sortDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity === "warning"));
  let output = `${PLUGIN_NAME}: generation failed with ${countLabel(errors.length, "error")}`;
  if (warnings.length > 0) output += ` and ${countLabel(warnings.length, "warning")}`;
  output += `\n\n${renderSection("Errors", errors)}`;
  if (warnings.length > 0) output += `\n\n${renderSection("Warnings", warnings)}`;
  return `${output}\n`;
}

export function renderWarningDiagnostics(diagnostics: readonly Diagnostic[]): string {
  const warnings = sortDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity === "warning"));
  if (warnings.length === 0) return "";
  return `${PLUGIN_NAME}: generation completed with ${countLabel(warnings.length, "warning")}\n\n${renderSection("Warnings", warnings)}\n`;
}

export function internalPluginFailure(_error?: unknown): Diagnostic {
  return {
    severity: "error",
    category: "INTERNAL",
    reason: "PLUGIN_FAILURE",
    message: `${PLUGIN_NAME} (${PLUGIN_BUILD_IDENTITY}) encountered an internal failure; report it at ${PLUGIN_ISSUE_REPORT_URL}`,
  };
}
