import { Column } from "./gen/plugin/codegen_pb";

export function fieldName(prefix: string, index: number, column?: Column): string {
  let name = `${prefix}_${index}`;
  if (column) {
    name = column.name;
  }
  return name
    .toLowerCase()
    .replace(/([_][a-z])/g, (group) => group.toUpperCase().replace("_", ""));
}

export function argName(index: number, column?: Column): string {
  return fieldName("arg", index, column);
}

export function colName(index: number, column?: Column): string {
  return fieldName("col", index, column);
}
