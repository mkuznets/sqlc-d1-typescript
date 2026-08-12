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

  async run(): Promise<Record<string, unknown>> {
    this.executor.throwFailure();
    return this.executor.produce([...this.executor.rows], this.executor.meta);
  }

  async all(): Promise<Record<string, unknown>> {
    return this.run();
  }
}

export const DEFAULT_FAKE_META: Readonly<Record<string, unknown>> = Object.freeze({ changes: 0, last_row_id: 0 });

export class FakeExecutor {
  readonly bound: BoundStatement[] = [];
  // Every result object handed back to the runtime, so identity passthrough is assertable.
  readonly produced: Record<string, unknown>[] = [];
  rows: unknown[] = [];
  batchRows: unknown[][] | undefined;
  // `undefined` omits the meta key entirely; any other value is served verbatim.
  meta: unknown = DEFAULT_FAKE_META;
  batchMetas: unknown[] | undefined;
  failure: unknown;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<Record<string, unknown>[]> {
    this.throwFailure();
    return statements.map((_, index) => this.produce(
      [...(this.batchRows?.[index] ?? this.rows)],
      this.batchMetas === undefined ? this.meta : this.batchMetas[index],
    ));
  }

  produce(results: unknown[], meta: unknown): Record<string, unknown> {
    const result: Record<string, unknown> = { results, success: true };
    if (meta !== undefined) result.meta = meta;
    this.produced.push(result);
    return result;
  }

  throwFailure(): void {
    if (this.failure !== undefined) throw this.failure;
  }
}
