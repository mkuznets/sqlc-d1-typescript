
interface Executor {
    prepare(sql: string): D1PreparedStatement

    batch<T = unknown>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]>
}

export interface OneQuery<T> {
    kind: "one"
    sql: string
    params: unknown[]
    parse: (row: Record<string, unknown>) => T
}

export interface OneInsertQuery<T> {
    kind: "one-insert"
    sql: string
    params: unknown[]
    parse: (row: Record<string, unknown>) => T
}

export interface ManyQuery<T> {
    kind: "many"
    sql: string
    params: unknown[]
    parse: (row: Record<string, unknown>) => T
}

export interface ExecQuery {
    kind: "exec"
    sql: string
    params: unknown[]
}

type AnyQuery = OneQuery<unknown> | OneInsertQuery<unknown> | ManyQuery<unknown> | ExecQuery

type QueryResult<Q> =
    Q extends OneQuery<infer T> ? T | null :
        Q extends OneInsertQuery<infer T> ? T | null :
            Q extends ManyQuery<infer T> ? T[] :
                Q extends ExecQuery ? void :
                    never

type BatchResults<Q extends AnyQuery[]> = { [K in keyof Q]: QueryResult<Q[K]> }

export class QueryExecutor {
    constructor(protected executor: Executor) {
    }

    async execute<Q extends AnyQuery>(query: Q): Promise<QueryResult<Q>> {
        const stmt = this.executor.prepare(query.sql).bind(...query.params)
        switch (query.kind) {
            case "one": {
                const row = await stmt.first()
                if (row === null) return null as QueryResult<Q>
                return query.parse(row as Record<string, unknown>) as QueryResult<Q>
            }
            case "one-insert": {
                const result = await stmt.run()
                if (result.results.length === 0) return null as QueryResult<Q>
                return query.parse(result.results[0] as Record<string, unknown>) as QueryResult<Q>
            }
            case "many": {
                const result = await stmt.all()
                return result.results.map((row) =>
                    query.parse(row as Record<string, unknown>),
                ) as QueryResult<Q>
            }
            case "exec": {
                await stmt.run()
                return undefined as QueryResult<Q>
            }
        }
    }

    async batch<Q extends AnyQuery[]>(...queries: Q): Promise<BatchResults<Q>> {
        const stmts = queries.map((q) => this.executor.prepare(q.sql).bind(...q.params))
        const results = await this.executor.batch(stmts)
        return results.map((result, i) => {
            const q = queries[i]
            switch (q.kind) {
                case "one":
                case "one-insert": {
                    const rows = (result as D1Result<Record<string, unknown>>).results
                    if (rows.length === 0) return null
                    return q.parse(rows[0])
                }
                case "many": {
                    const rows = (result as D1Result<Record<string, unknown>>).results
                    return rows.map((row) => q.parse(row))
                }
                case "exec":
                    return undefined
            }
        }) as BatchResults<Q>
    }
}

export class DB extends QueryExecutor {
    constructor(db: D1Database) {
        super(db)
    }

    withSession(constraint?: "first-primary" | "first-unconstrained"): QueryExecutor {
        return new QueryExecutor((this.executor as D1Database).withSession(constraint))
    }
}
