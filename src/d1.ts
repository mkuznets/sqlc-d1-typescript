import { RESULT_CONTEXT_ALIAS, RUNTIME_VALUE_ALIAS, type QueryPlan, type RowFieldPlan, type ValueFieldPlan } from "./emission-plan";
import { RUNTIME } from "./runtime";
import type { ValueKind } from "./sqlite-types";

type ScalarValueKind = Exclude<ValueKind, "json" | "unknown">;

const SCALAR_TYPES: Readonly<Record<ScalarValueKind, string>> = {
  integer: "number",
  number: "number",
  text: "string",
  boolean: "boolean",
  blob: "Uint8Array",
};

const CODEC_SUFFIXES: Readonly<Record<ValueKind, string>> = {
  integer: "Integer",
  number: "Number",
  text: "Text",
  boolean: "Boolean",
  blob: "Blob",
  json: "Json",
  unknown: "Unknown",
};

function codecCall(prefix: "arg" | "row", field: ValueFieldPlan): string {
  return `${RUNTIME_VALUE_ALIAS}.${prefix}${CODEC_SUFFIXES[field.valueKind]}${field.nullable ? "OrNull" : ""}`;
}

export class Driver {
  runtimeCode(): string {
    return RUNTIME;
  }

  // Structurally identical to the runtime's private ResultContext; both sides must change together.
  resultContextDecl(): string {
    return `type ${RESULT_CONTEXT_ALIAS} = { readonly operation: "execute" | "batch"; readonly queryName: string; readonly batchIndex?: number | undefined; readonly rowIndex?: number | undefined };`;
  }

  argumentType(field: ValueFieldPlan): string {
    if (field.valueKind === "unknown") return field.nullable ? "D1Value" : "D1NonNullValue";
    const base = field.valueKind === "json" ? "JsonValue" : SCALAR_TYPES[field.valueKind];
    return field.nullable ? `${base} | null` : base;
  }

  rowType(field: ValueFieldPlan): string {
    if (field.valueKind === "unknown" || field.valueKind === "json") return "unknown";
    const base = SCALAR_TYPES[field.valueKind];
    return field.nullable ? `${base} | null` : base;
  }

  parseFnDecl(funcName: string, returnIface: string, fields: readonly RowFieldPlan[]): string {
    const properties = fields.map((field) =>
      `        ${field.publicNameLiteral}: ${codecCall("row", field)}(row, ${field.physicalKeyLiteral}, ${field.publicNameLiteral}, ctx)`,
    ).join(",\n");
    return `function ${funcName}(row: Record<string, unknown>, ctx: ${RESULT_CONTEXT_ALIAS}): ${returnIface} {
    return {
${properties}
    };
}`;
  }

  factoryDecl(plan: QueryPlan): string {
    const fnParams = plan.argsTypeName ? `args: ${plan.argsTypeName}` : "";
    const params = plan.bindAccesses.map((field) =>
      `${codecCall("arg", field)}(args[${field.publicNameLiteral}], ${plan.queryNameLiteral}, ${field.publicNameLiteral})`,
    ).join(", ");
    const properties = [
      `        kind: ${plan.kindLiteral}`,
      `        name: ${plan.queryNameLiteral}`,
      `        sql: ${plan.sqlConstantName}`,
      `        params: Object.freeze([${params}])`,
    ];
    if (plan.parserName) properties.push(`        parse: ${plan.parserName}`);
    const guard = plan.argsTypeName ? `    ${RUNTIME_VALUE_ALIAS}.requireArgs(args, ${plan.queryNameLiteral});\n` : "";
    return `export function ${plan.factoryName}(${fnParams}): ${plan.factoryReturnType} {
${guard}    return Object.freeze({
${properties.join(",\n")}
    }) as unknown as ${plan.factoryReturnType};
}`;
  }
}
