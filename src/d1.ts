import { Parameter, Column } from "./gen/plugin/codegen_pb";
import { argName, colName } from "./utils";
import { RUNTIME } from "./runtime";

export class Driver {
  runtimeCode(): string {
    return RUNTIME;
  }

  columnType(column?: Column): string {
    if (column === undefined || column.type === undefined) {
      return "any";
    }

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

    if (column.notNull) {
      return typ;
    }
    return `${typ} | null`;
  }

  parseFnDecl(
    funcName: string,
    returnIface: string,
    columns: Column[]
  ): string {
    const properties = columns
      .map((column, i) => {
        const name = colName(i, column);
        const typ = this.columnType(column);
        return `        ${name}: row["${column.name}"] as ${typ}`;
      })
      .join(",\n");

    return `function ${funcName}(row: Record<string, unknown>): ${returnIface} {
    return {
${properties}
    };
}`;
  }

  execDecl(
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    params: Parameter[]
  ): string {
    return this.factoryFnDecl(funcName, queryName, argIface, "ExecQuery", undefined, undefined, "exec", params);
  }

  oneDecl(
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    returnIface: string,
    parseFnName: string,
    params: Parameter[]
  ): string {
    return this.factoryFnDecl(funcName, queryName, argIface, "OneQuery", returnIface, parseFnName, "one", params);
  }

  oneInsertDecl(
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    returnIface: string,
    parseFnName: string,
    params: Parameter[]
  ): string {
    return this.factoryFnDecl(funcName, queryName, argIface, "OneInsertQuery", returnIface, parseFnName, "one-insert", params);
  }

  manyDecl(
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    returnIface: string,
    parseFnName: string,
    params: Parameter[]
  ): string {
    return this.factoryFnDecl(funcName, queryName, argIface, "ManyQuery", returnIface, parseFnName, "many", params);
  }

  private factoryFnDecl(
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    queryType: string,
    returnIface: string | undefined,
    parseFnName: string | undefined,
    kind: string,
    params: Parameter[]
  ): string {
    const fnParams = argIface ? `args: ${argIface}` : "";
    const returnType = returnIface ? `${queryType}<${returnIface}>` : queryType;

    const paramsList = params
      .map((param, i) => `args.${argName(i, param.column)}`)
      .join(", ");

    const properties: string[] = [
      `        kind: "${kind}"`,
      `        sql: ${queryName}`,
      `        params: [${paramsList}]`,
    ];

    if (parseFnName) {
      properties.push(`        parse: ${parseFnName}`);
    }

    return `export function ${funcName}(${fnParams}): ${returnType} {
    return {
${properties.join(",\n")}
    };
}`;
  }
}
