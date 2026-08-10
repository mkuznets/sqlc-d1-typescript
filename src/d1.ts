import { Column } from "./gen/plugin/codegen_pb";
import type { QueryPlan, RowFieldPlan } from "./emission-plan";
import { RUNTIME } from "./runtime";

export class Driver {
  runtimeCode(): string {
    return RUNTIME;
  }

  columnType(column?: Column): string {
    if (column === undefined || column.type === undefined) return "any";

    let typ = "any";
    switch (column.type.name) {
      case "int":
      case "integer":
      case "tinyint":
      case "smallint":
      case "mediumint":
      case "bigint":
      case "unsignedbigint":
      case "int2":
      case "int8":
      case "real":
      case "double":
      case "doubleprecision":
      case "float":
      case "numeric":
      case "decimal":
        typ = "number";
        break;
      case "blob":
        typ = "ArrayBuffer";
        break;
      case "boolean":
      case "bool":
        typ = "boolean";
        break;
      case "text":
      case "varchar":
      case "character":
      case "nchar":
      case "nvarchar":
      case "clob":
      case "date":
      case "datetime":
      case "timestamp":
        typ = "string";
        break;
    }
    return column.notNull ? typ : `${typ} | null`;
  }

  parseFnDecl(funcName: string, returnIface: string, fields: readonly RowFieldPlan[]): string {
    const properties = fields.map((field) =>
      `        ${field.publicNameLiteral}: row[${field.physicalKeyLiteral}] as ${this.columnType(field.column)}`,
    ).join(",\n");
    return `function ${funcName}(row: Record<string, unknown>): ${returnIface} {
    return {
${properties}
    };
}`;
  }

  factoryDecl(plan: QueryPlan): string {
    const fnParams = plan.argsTypeName ? `args: ${plan.argsTypeName}` : "";
    const params = plan.bindAccesses.map((field) => `args[${field.publicNameLiteral}]`).join(", ");
    const properties = [
      `        kind: ${plan.kindLiteral}`,
      `        sql: ${plan.sqlConstantName}`,
      `        params: Object.freeze([${params}])`,
    ];
    if (plan.parserName) properties.push(`        parse: ${plan.parserName}`);
    return `export function ${plan.factoryName}(${fnParams}): ${plan.factoryReturnType} {
    return Object.freeze({
${properties.join(",\n")}
    }) as unknown as ${plan.factoryReturnType};
}`;
  }
}
