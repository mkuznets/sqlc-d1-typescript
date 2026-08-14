import {
  RESULT_CONTEXT_ALIAS,
  RUNTIME_VALUE_ALIAS,
  type ArgumentFieldPlan,
  type QueryPlan,
  type RowFieldPlan,
  type RowValueFieldPlan,
  type SlicePlan,
  type ValueFieldPlan,
} from "./emission-plan";
import { RUNTIME } from "./runtime";
import { VALUE_KINDS } from "./sqlite-types";

type SliceArgumentFieldPlan = ArgumentFieldPlan & { readonly slice: SlicePlan };

const spelling = (field: ValueFieldPlan) => VALUE_KINDS[field.valueKind];

function codecCall(prefix: "arg" | "row", field: ValueFieldPlan): string {
  return `${RUNTIME_VALUE_ALIAS}.${prefix}${spelling(field).codecSuffix}${field.nullable ? "OrNull" : ""}`;
}

function valueType(field: ValueFieldPlan): string {
  const entry = spelling(field);
  return field.nullable ? entry.nullableRowType : entry.rowType;
}

// The one place a mapped value becomes a property, so a nested field and a flat one
// cannot drift apart in physical key, public path, or codec.
function valueProperty(field: RowValueFieldPlan, indent: string): string {
  return `${indent}${field.publicNameLiteral}: ${codecCall("row", field)}(row, ${field.physicalKeyLiteral}, ${field.pathLiteral}, ctx)`;
}

function codecProperty(field: RowFieldPlan, indent: string): string {
  if (field.kind !== "embed") return valueProperty(field, indent);
  const nested = field.fields.map((nestedField) => valueProperty(nestedField, `${indent}    `)).join(",\n");
  return `${indent}${field.publicNameLiteral}: {\n${nested}\n${indent}}`;
}

export class Driver {
  runtimeCode(): string {
    return RUNTIME;
  }

  // Structurally identical to the runtime's private ResultContext; both sides must change together.
  resultContextDecl(): string {
    return `type ${RESULT_CONTEXT_ALIAS} = { readonly operation: "execute" | "batch"; readonly queryName: string; readonly batchIndex?: number | undefined; readonly rowIndex?: number | undefined };`;
  }

  argumentType(field: ArgumentFieldPlan): string {
    const entry = spelling(field);
    const base = field.nullable ? entry.nullableArgumentType : entry.argumentType;
    return field.slice ? `ReadonlyArray<${base}>` : base;
  }

  // An embed is spelled inline: a derived module-level interface name could collide with
  // another query's declarations, and GetUserRow["users"] already names the nested type.
  rowType(field: RowFieldPlan): string {
    if (field.kind !== "embed") return valueType(field);
    const nested = field.fields
      .map((nestedField) => `        ${nestedField.publicNameLiteral}: ${valueType(nestedField)}`)
      .join(";\n");
    return `{\n${nested};\n    }`;
  }

  parseFnDecl(funcName: string, returnIface: string, fields: readonly RowFieldPlan[]): string {
    const properties = fields.map((field) => codecProperty(field, "        ")).join(",\n");
    return `function ${funcName}(row: Record<string, unknown>, ctx: ${RESULT_CONTEXT_ALIAS}): ${returnIface} {
    return {
${properties}
    };
}`;
  }

  factoryDecl(plan: QueryPlan): string {
    const fnParams = plan.argsTypeName ? `args: ${plan.argsTypeName}` : "";
    // A slice is validated and snapshotted first, so its length is known before the
    // descriptor's SQL and bind values are built from it.
    const slices = plan.argumentFields.filter((field): field is SliceArgumentFieldPlan => field.slice !== undefined);
    const preamble = plan.argsTypeName
      ? [`    ${RUNTIME_VALUE_ALIAS}.requireArgs(args, ${plan.queryNameLiteral});`]
      : [];
    for (const field of slices) {
      preamble.push(
        `    const ${field.slice.localName} = ${RUNTIME_VALUE_ALIAS}.argSlice(args[${field.publicNameLiteral}], ${codecCall("arg", field)}, ${plan.queryNameLiteral}, ${field.publicNameLiteral});`,
      );
    }

    const sql =
      slices.length === 0
        ? plan.sqlConstantName
        : `${RUNTIME_VALUE_ALIAS}.expandSlices(${plan.sqlConstantName}, ${plan.queryNameLiteral}, [${slices
            .map((field) => `[${field.slice.markerLiteral}, ${field.slice.localName}.length]`)
            .join(", ")}])`;

    const params = plan.argumentFields
      .map((field) =>
        field.slice
          ? `...${field.slice.localName}`
          : `${codecCall("arg", field)}(args[${field.publicNameLiteral}], ${plan.queryNameLiteral}, ${field.publicNameLiteral})`,
      )
      .join(", ");

    const properties = [
      `        kind: ${plan.kindLiteral}`,
      `        name: ${plan.queryNameLiteral}`,
      `        sql: ${sql}`,
      `        params: Object.freeze([${params}])`,
    ];
    if (plan.parserName) properties.push(`        parse: ${plan.parserName}`);

    const guard = preamble.length > 0 ? `${preamble.join("\n")}\n` : "";
    return `export function ${plan.factoryName}(${fnParams}): ${plan.factoryReturnType} {
${guard}    return Object.freeze({
${properties.join(",\n")}
    }) as unknown as ${plan.factoryReturnType};
}`;
  }
}
