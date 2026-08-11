import ts from "typescript";
import type { GenerateResponse } from "../../src/gen/plugin/codegen_pb";

export interface BoundStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

// Loads the emitted TypeScript in-process so the generated runtime contract can be
// exercised hermetically, against source and against the publication candidate alike.
export function loadGeneratedModules(response: GenerateResponse): (path: string) => Record<string, unknown> {
  const decoder = new TextDecoder();
  const sources = new Map<string, string>();
  for (const file of response.files) sources.set(file.name.replace(/\.ts$/, ""), decoder.decode(file.contents));
  const cache = new Map<string, Record<string, unknown>>();

  const load = (id: string): Record<string, unknown> => {
    const cached = cache.get(id);
    if (cached) return cached;
    const source = sources.get(id);
    if (source === undefined) throw new Error(`unknown generated module ${id}`);
    const javascript = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const exports: Record<string, unknown> = {};
    cache.set(id, exports);
    const directory = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
    const require = (specifier: string): Record<string, unknown> => load(resolveModuleId(directory, specifier));
    new Function("exports", "module", "require", javascript)(exports, { exports }, require);
    return exports;
  };

  return (path: string) => load(path.replace(/\.ts$/, ""));
}

function resolveModuleId(directory: string, specifier: string): string {
  const resolved: string[] = [];
  for (const segment of [...directory.split("/"), ...specifier.split("/")]) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join("/");
}

export class FakeStatement {
  constructor(private readonly executor: FakeExecutor, private readonly sql: string) {}

  bind(...params: unknown[]): FakeStatement {
    this.executor.bound.push({ sql: this.sql, params });
    return this;
  }

  async first(): Promise<unknown> {
    this.executor.throwFailure();
    return this.executor.rows.length === 0 ? null : this.executor.rows[0];
  }

  async run(): Promise<{ results: unknown[]; success: boolean; meta: Record<string, unknown> }> {
    this.executor.throwFailure();
    return { results: [...this.executor.rows], success: true, meta: {} };
  }

  async all(): Promise<{ results: unknown[]; success: boolean; meta: Record<string, unknown> }> {
    return this.run();
  }
}

export class FakeExecutor {
  readonly bound: BoundStatement[] = [];
  rows: unknown[] = [];
  batchRows: unknown[][] | undefined;
  failure: unknown;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<{ results: unknown[] }[]> {
    this.throwFailure();
    return statements.map((_, index) => ({ results: [...(this.batchRows?.[index] ?? this.rows)] }));
  }

  throwFailure(): void {
    if (this.failure !== undefined) throw this.failure;
  }
}
