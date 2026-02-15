// @ts-expect-error
import { readFileSync, writeFileSync, STDIO } from "javy/fs";

import {
  GenerateRequest,
  GenerateResponse,
  Parameter,
  Column,
  File,
  Query,
} from "./gen/plugin/codegen_pb";

import { argName, colName } from "./utils";
import { Driver as D1Driver } from "./d1";

const input = readInput();
const result = codegen(input);
writeOutput(result);

interface Options {
  interface?: "workers";
}

interface Driver {
  runtimeCode: () => string;
  columnType: (c?: Column) => string;
  parseFnDecl: (
    funcName: string,
    returnIface: string,
    columns: Column[]
  ) => string;
  execDecl: (
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    params: Parameter[]
  ) => string;
  oneDecl: (
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    returnIface: string,
    parseFnName: string,
    params: Parameter[]
  ) => string;
  oneInsertDecl: (
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    returnIface: string,
    parseFnName: string,
    params: Parameter[]
  ) => string;
  manyDecl: (
    funcName: string,
    queryName: string,
    argIface: string | undefined,
    returnIface: string,
    parseFnName: string,
    params: Parameter[]
  ) => string;
}

function createNodeGenerator(options: Options): Driver {
  switch (options.interface) {
    case "workers":
      return new D1Driver();
  }
  throw new Error(`unknown interface: ${options.interface}`);
}

function codegen(input: GenerateRequest): GenerateResponse {
  let files = [];
  let options: Options = {};

  if (input.pluginOptions.length > 0) {
    const text = new TextDecoder().decode(input.pluginOptions);
    options = JSON.parse(text) as Options;
  }

  const driver = createNodeGenerator(options);

  const querymap = new Map<string, Query[]>();

  for (const query of input.queries) {
    if (!querymap.has(query.filename)) {
      querymap.set(query.filename, []);
    }
    const qs = querymap.get(query.filename);
    qs?.push(query);
  }

  for (const [filename, queries] of querymap.entries()) {
    const nodes: string[] = [];

    for (const query of queries) {
      const colmap = new Map<string, number>();
      for (let column of query.columns) {
        if (!column.name) {
          continue;
        }
        const count = colmap.get(column.name) || 0;
        if (count > 0) {
          column.name = `${column.name}_${count + 1}`;
        }
        colmap.set(column.name, count + 1);
      }

      const lowerName = query.name[0].toLowerCase() + query.name.slice(1);
      const textName = `${lowerName}Query`;

      nodes.push(
        queryDecl(
          textName,
          `-- name: ${query.name} ${query.cmd}\n${query.text}`
        )
      );

      let argIface = undefined;
      let returnIface = undefined;
      let parseFnName: string | undefined = undefined;
      if (query.params.length > 0) {
        argIface = `${query.name}Args`;
        nodes.push(argsDecl(argIface, driver, query.params));
      }
      if (query.columns.length > 0) {
        returnIface = `${query.name}Row`;
        parseFnName = `parse${query.name}Row`;
        nodes.push(rowDecl(returnIface, driver, query.columns));
        nodes.push(driver.parseFnDecl(parseFnName, returnIface, query.columns));
      }

      switch (query.cmd) {
        case ":exec": {
          nodes.push(
            driver.execDecl(lowerName, textName, argIface, query.params)
          );
          break;
        }
        case ":one": {
          if (query.insertIntoTable) {
            nodes.push(
              driver.oneInsertDecl(
                lowerName, textName, argIface,
                returnIface ?? "void", parseFnName ?? "", query.params
              )
            );
          } else {
            nodes.push(
              driver.oneDecl(
                lowerName, textName, argIface,
                returnIface ?? "void", parseFnName ?? "", query.params
              )
            );
          }
          break;
        }
        case ":many": {
          nodes.push(
            driver.manyDecl(
              lowerName, textName, argIface,
              returnIface ?? "void", parseFnName ?? "", query.params
            )
          );
          break;
        }
      }
    }

    files.push(
      new File({
        name: `${filename.replace(".", "_")}.ts`,
        contents: new TextEncoder().encode(printNode(driver, nodes)),
      })
    );
  }

  return new GenerateResponse({
    files: files,
  });
}

function readInput(): GenerateRequest {
  const buffer = readFileSync(STDIO.Stdin);
  return GenerateRequest.fromBinary(buffer);
}

function queryDecl(name: string, sql: string): string {
  return `const ${name} = \`${sql}\`;`;
}

function argsDecl(
  name: string,
  driver: Driver,
  params: Parameter[]
): string {
  const fields = params
    .map((param, i) => {
      const fieldName = argName(i, param.column);
      const typ = driver.columnType(param.column);
      return `    ${fieldName}: ${typ}`;
    })
    .join(";\n");

  return `export interface ${name} {\n${fields};\n}`;
}

function rowDecl(
  name: string,
  driver: Driver,
  columns: Column[]
): string {
  const fields = columns
    .map((column, i) => {
      const fieldName = colName(i, column);
      const typ = driver.columnType(column);
      return `    ${fieldName}: ${typ}`;
    })
    .join(";\n");

  return `export interface ${name} {\n${fields};\n}`;
}

function printNode(driver: Driver, nodes: string[]): string {
  let output = "// Code generated by sqlc. DO NOT EDIT.\n\n";
  output += driver.runtimeCode();
  output += "\n";
  for (let node of nodes) {
    output += node;
    output += "\n\n";
  }
  return output;
}

function writeOutput(output: GenerateResponse) {
  const encodedOutput = output.toBinary();
  const buffer = new Uint8Array(encodedOutput);
  writeFileSync(STDIO.Stdout, buffer);
}
