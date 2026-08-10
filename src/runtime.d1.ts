// The imports are only needed to avoid warning about unknown types and make editing easier.
// They are not part of the generated code.
import {D1Database, D1DatabaseSession, D1PreparedStatement, D1Result} from "@cloudflare/workers-types"

// --- RUNTIME BEGIN ---

interface Executor {
    prepare(sql: string): D1PreparedStatement

    batch<T = unknown>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]>
}

export type D1NonNullValue = boolean | number | string | Uint8Array
export type D1Value = D1NonNullValue | null
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export class SqlcD1Error extends Error {}
export class QueryArgumentError extends SqlcD1Error {}
export class QueryUsageError extends SqlcD1Error {}
export class QueryResultError extends SqlcD1Error {}

declare const queryDescriptorResult: unique symbol

export interface QueryDescriptor<Result> {
    readonly [queryDescriptorResult]: Result
}

type InternalQuery =
    | {
        readonly kind: "one" | "one-insert"
        readonly sql: string
        readonly params: readonly unknown[]
        readonly parse: (row: Record<string, unknown>) => unknown
    }
    | {
        readonly kind: "many"
        readonly sql: string
        readonly params: readonly unknown[]
        readonly parse: (row: Record<string, unknown>) => unknown
    }
    | {
        readonly kind: "exec"
        readonly sql: string
        readonly params: readonly unknown[]
    }

type DescriptorResult<Q> = Q extends QueryDescriptor<infer Result> ? Result : never
type BatchResults<Q extends readonly QueryDescriptor<unknown>[]> = {
    [K in keyof Q]: DescriptorResult<Q[K]>
}

export abstract class QueryExecutor {
    protected constructor(protected executor: Executor) {
    }

    async execute<Result>(query: QueryDescriptor<Result>): Promise<Result> {
        const internalQuery = query as unknown as InternalQuery
        const stmt = this.executor.prepare(internalQuery.sql).bind(...internalQuery.params)
        switch (internalQuery.kind) {
            case "one": {
                const row = await stmt.first()
                if (row === null) return null as Result
                return internalQuery.parse(row as Record<string, unknown>) as Result
            }
            case "one-insert": {
                const result = await stmt.run()
                if (result.results.length === 0) return null as Result
                return internalQuery.parse(result.results[0] as Record<string, unknown>) as Result
            }
            case "many": {
                const result = await stmt.all()
                return result.results.map((row) =>
                    internalQuery.parse(row as Record<string, unknown>),
                ) as Result
            }
            case "exec": {
                await stmt.run()
                return undefined as Result
            }
        }
    }

    async batch<Q extends readonly QueryDescriptor<unknown>[]>(...queries: Q): Promise<BatchResults<Q>> {
        const internalQueries = queries as unknown as readonly InternalQuery[]
        const stmts = internalQueries.map((query) =>
            this.executor.prepare(query.sql).bind(...query.params),
        )
        const results = await this.executor.batch(stmts)
        return results.map((result, index) => {
            const query = internalQueries[index]
            switch (query.kind) {
                case "one":
                case "one-insert": {
                    const rows = (result as D1Result<Record<string, unknown>>).results
                    if (rows.length === 0) return null
                    return query.parse(rows[0])
                }
                case "many": {
                    const rows = (result as D1Result<Record<string, unknown>>).results
                    return rows.map((row) => query.parse(row))
                }
                case "exec":
                    return undefined
            }
        }) as BatchResults<Q>
    }
}

const sessionExecutorCapability: unique symbol = Symbol("SessionExecutor")

export abstract class SessionExecutor extends QueryExecutor {
    protected constructor(executor: Executor, capability: typeof sessionExecutorCapability) {
        if (capability !== sessionExecutorCapability) throw new TypeError("SessionExecutor must be created by DB.withSession")
        super(executor)
    }

    abstract getBookmark(): string | null
}

class D1SessionExecutor extends SessionExecutor {
    constructor(private readonly session: D1DatabaseSession) {
        super(session, sessionExecutorCapability)
    }

    getBookmark(): string | null {
        return this.session.getBookmark()
    }
}

export class DB extends QueryExecutor {
    constructor(db: D1Database) {
        super(db)
    }

    withSession(constraintOrBookmark?: string): SessionExecutor {
        return new D1SessionExecutor((this.executor as D1Database).withSession(constraintOrBookmark))
    }
}

// --- RUNTIME END ---
