
interface Executor {
    prepare(sql: string): D1PreparedStatement

    batch<T = unknown>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]>
}

export type D1NonNullValue = boolean | number | string | Uint8Array
export type D1Value = D1NonNullValue | null
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface SqlcD1ErrorContext {
    readonly operation: "construct" | "execute" | "batch" | "withSession"
    readonly queryName?: string | undefined
    readonly batchIndex?: number | undefined
    readonly rowIndex?: number | undefined
    readonly path?: string | undefined
    readonly expected?: string | undefined
    readonly received?: string | undefined
    readonly cause?: unknown
}

export class SqlcD1Error extends Error {
    readonly operation: SqlcD1ErrorContext["operation"]
    readonly queryName?: string | undefined
    readonly batchIndex?: number | undefined
    readonly rowIndex?: number | undefined
    readonly path?: string | undefined
    readonly expected?: string | undefined
    readonly received?: string | undefined
    readonly cause?: unknown

    constructor(message: string, context: SqlcD1ErrorContext) {
        super(message)
        this.name = "SqlcD1Error"
        this.operation = context.operation
        this.queryName = context.queryName
        this.batchIndex = context.batchIndex
        this.rowIndex = context.rowIndex
        this.path = context.path
        this.expected = context.expected
        this.received = context.received
        this.cause = context.cause
    }
}

export class QueryArgumentError extends SqlcD1Error {
    constructor(message: string, context: SqlcD1ErrorContext) {
        super(message, context)
        this.name = "QueryArgumentError"
    }
}

export class QueryUsageError extends SqlcD1Error {
    constructor(message: string, context: SqlcD1ErrorContext) {
        super(message, context)
        this.name = "QueryUsageError"
    }
}

export class QueryResultError extends SqlcD1Error {
    constructor(message: string, context: SqlcD1ErrorContext) {
        super(message, context)
        this.name = "QueryResultError"
    }
}

function describeValue(value: unknown): string {
    if (value === null) return "null"
    if (value === undefined) return "undefined"
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return "non-finite number"
        if (!Number.isInteger(value)) return "non-integer number"
        if (!Number.isSafeInteger(value)) return "unsafe integer"
        return "number"
    }
    if (typeof value === "string") return "string"
    if (typeof value === "boolean") return "boolean"
    if (typeof value === "bigint") return "bigint"
    if (typeof value === "function") return "function"
    if (typeof value === "symbol") return "symbol"
    if (value instanceof Uint8Array) return "Uint8Array"
    if (Array.isArray(value)) return "array"
    return "object"
}

function argumentFailure(queryName: string, path: string, expected: string, value: unknown): QueryArgumentError {
    return new QueryArgumentError(`argument ${path} of query ${queryName} must be ${expected}`, {
        operation: "construct",
        queryName,
        path,
        expected,
        received: describeValue(value),
    })
}

function requireArgs(args: unknown, queryName: string): void {
    if (typeof args !== "object" || args === null) {
        throw new QueryArgumentError(`query ${queryName} requires an arguments object`, {
            operation: "construct",
            queryName,
            expected: "an arguments object",
            received: describeValue(args),
        })
    }
}

function argInteger(value: unknown, queryName: string, path: string): number {
    if (typeof value === "number" && Number.isSafeInteger(value)) return value
    throw argumentFailure(queryName, path, "a safe integer", value)
}

function argIntegerOrNull(value: unknown, queryName: string, path: string): number | null {
    if (value === null) return null
    if (typeof value === "number" && Number.isSafeInteger(value)) return value
    throw argumentFailure(queryName, path, "a safe integer or null", value)
}

function argNumber(value: unknown, queryName: string, path: string): number {
    if (typeof value === "number" && Number.isFinite(value)) return value
    throw argumentFailure(queryName, path, "a finite number", value)
}

function argNumberOrNull(value: unknown, queryName: string, path: string): number | null {
    if (value === null) return null
    if (typeof value === "number" && Number.isFinite(value)) return value
    throw argumentFailure(queryName, path, "a finite number or null", value)
}

function argText(value: unknown, queryName: string, path: string): string {
    if (typeof value === "string") return value
    throw argumentFailure(queryName, path, "a string", value)
}

function argTextOrNull(value: unknown, queryName: string, path: string): string | null {
    if (value === null) return null
    if (typeof value === "string") return value
    throw argumentFailure(queryName, path, "a string or null", value)
}

function argBoolean(value: unknown, queryName: string, path: string): boolean {
    if (typeof value === "boolean") return value
    throw argumentFailure(queryName, path, "a boolean", value)
}

function argBooleanOrNull(value: unknown, queryName: string, path: string): boolean | null {
    if (value === null) return null
    if (typeof value === "boolean") return value
    throw argumentFailure(queryName, path, "a boolean or null", value)
}

function argBlob(value: unknown, queryName: string, path: string): Uint8Array {
    if (value instanceof Uint8Array) return new Uint8Array(value)
    throw argumentFailure(queryName, path, "a Uint8Array", value)
}

function argBlobOrNull(value: unknown, queryName: string, path: string): Uint8Array | null {
    if (value === null) return null
    if (value instanceof Uint8Array) return new Uint8Array(value)
    throw argumentFailure(queryName, path, "a Uint8Array or null", value)
}

function validateJsonValue(value: unknown, queryName: string, path: string, seen: Set<object>): void {
    if (value === null || typeof value === "string" || typeof value === "boolean") return
    if (typeof value === "number") {
        if (Number.isFinite(value)) return
        throw argumentFailure(queryName, path, "a finite number", value)
    }
    if (typeof value !== "object") throw argumentFailure(queryName, path, "a JSON value", value)
    if (seen.has(value)) throw argumentFailure(queryName, path, "an acyclic JSON value", value)
    seen.add(value)
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
            validateJsonValue(value[index], queryName, `${path}[${index}]`, seen)
        }
    } else {
        const prototype = Object.getPrototypeOf(value) as unknown
        if (prototype !== Object.prototype && prototype !== null) {
            throw argumentFailure(queryName, path, "a plain JSON object", value)
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
            throw argumentFailure(queryName, path, "a JSON object without symbol keys", value)
        }
        const record = value as Record<string, unknown>
        for (const key of Object.keys(record)) {
            validateJsonValue(record[key], queryName, `${path}.${key}`, seen)
        }
    }
    seen.delete(value)
}

function argJson(value: unknown, queryName: string, path: string): string {
    validateJsonValue(value, queryName, path, new Set<object>())
    return JSON.stringify(value)
}

function argJsonOrNull(value: unknown, queryName: string, path: string): string | null {
    if (value === null) return null
    validateJsonValue(value, queryName, path, new Set<object>())
    return JSON.stringify(value)
}

function argUnknown(value: unknown, queryName: string, path: string): D1NonNullValue {
    if (typeof value === "boolean" || typeof value === "string") return value
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (value instanceof Uint8Array) return new Uint8Array(value)
    throw argumentFailure(queryName, path, "a boolean, finite number, string, or Uint8Array", value)
}

function argUnknownOrNull(value: unknown, queryName: string, path: string): D1Value {
    if (value === null) return null
    if (typeof value === "boolean" || typeof value === "string") return value
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (value instanceof Uint8Array) return new Uint8Array(value)
    throw argumentFailure(queryName, path, "a boolean, finite number, string, Uint8Array, or null", value)
}

interface ResultContext {
    readonly operation: "execute" | "batch"
    readonly queryName: string
    readonly batchIndex?: number | undefined
    readonly rowIndex?: number | undefined
}

function resultFailure(ctx: ResultContext, path: string, expected: string, received: string, cause?: unknown): QueryResultError {
    return new QueryResultError(`result field ${path} of query ${ctx.queryName} must be ${expected}`, {
        operation: ctx.operation,
        queryName: ctx.queryName,
        batchIndex: ctx.batchIndex,
        rowIndex: ctx.rowIndex,
        path,
        expected,
        received,
        cause,
    })
}

function requireField(row: Record<string, unknown>, key: string, path: string, expected: string, ctx: ResultContext): unknown {
    if (!Object.prototype.hasOwnProperty.call(row, key)) throw resultFailure(ctx, path, expected, "missing field")
    return row[key]
}

function rowInteger(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): number {
    const value = requireField(row, key, path, "a safe integer", ctx)
    if (typeof value === "number" && Number.isSafeInteger(value)) return value
    throw resultFailure(ctx, path, "a safe integer", describeValue(value))
}

function rowIntegerOrNull(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): number | null {
    const value = requireField(row, key, path, "a safe integer or null", ctx)
    if (value === null) return null
    if (typeof value === "number" && Number.isSafeInteger(value)) return value
    throw resultFailure(ctx, path, "a safe integer or null", describeValue(value))
}

function rowNumber(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): number {
    const value = requireField(row, key, path, "a finite number", ctx)
    if (typeof value === "number" && Number.isFinite(value)) return value
    throw resultFailure(ctx, path, "a finite number", describeValue(value))
}

function rowNumberOrNull(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): number | null {
    const value = requireField(row, key, path, "a finite number or null", ctx)
    if (value === null) return null
    if (typeof value === "number" && Number.isFinite(value)) return value
    throw resultFailure(ctx, path, "a finite number or null", describeValue(value))
}

function rowText(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): string {
    const value = requireField(row, key, path, "a string", ctx)
    if (typeof value === "string") return value
    throw resultFailure(ctx, path, "a string", describeValue(value))
}

function rowTextOrNull(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): string | null {
    const value = requireField(row, key, path, "a string or null", ctx)
    if (value === null) return null
    if (typeof value === "string") return value
    throw resultFailure(ctx, path, "a string or null", describeValue(value))
}

function rowBoolean(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): boolean {
    const value = requireField(row, key, path, "the integer 0 or 1", ctx)
    if (value === 0) return false
    if (value === 1) return true
    throw resultFailure(ctx, path, "the integer 0 or 1", describeValue(value))
}

function rowBooleanOrNull(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): boolean | null {
    const value = requireField(row, key, path, "the integer 0 or 1, or null", ctx)
    if (value === null) return null
    if (value === 0) return false
    if (value === 1) return true
    throw resultFailure(ctx, path, "the integer 0 or 1, or null", describeValue(value))
}

function toBytes(value: unknown): Uint8Array | undefined {
    if (value instanceof Uint8Array) return new Uint8Array(value)
    // slice() first: new Uint8Array(buffer) would be a view over the caller's buffer.
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
    if (!Array.isArray(value)) return undefined
    const bytes = new Uint8Array(value.length)
    for (let index = 0; index < value.length; index++) {
        const element: unknown = value[index]
        if (typeof element !== "number" || !Number.isInteger(element) || element < 0 || element > 255) return undefined
        bytes[index] = element
    }
    return bytes
}

function rowBlob(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): Uint8Array {
    const value = requireField(row, key, path, "a byte array", ctx)
    const bytes = toBytes(value)
    if (bytes === undefined) throw resultFailure(ctx, path, "a byte array", describeValue(value))
    return bytes
}

function rowBlobOrNull(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): Uint8Array | null {
    const value = requireField(row, key, path, "a byte array or null", ctx)
    if (value === null) return null
    const bytes = toBytes(value)
    if (bytes === undefined) throw resultFailure(ctx, path, "a byte array or null", describeValue(value))
    return bytes
}

function parseJsonText(value: unknown, path: string, expected: string, ctx: ResultContext): unknown {
    if (typeof value !== "string") throw resultFailure(ctx, path, expected, describeValue(value))
    try {
        return JSON.parse(value)
    } catch (error) {
        throw resultFailure(ctx, path, expected, "malformed JSON string", error)
    }
}

function rowJson(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): unknown {
    return parseJsonText(requireField(row, key, path, "JSON text", ctx), path, "JSON text", ctx)
}

function rowJsonOrNull(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): unknown {
    const value = requireField(row, key, path, "JSON text or null", ctx)
    if (value === null) return null
    return parseJsonText(value, path, "JSON text or null", ctx)
}

function rowUnknown(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): unknown {
    const value = requireField(row, key, path, "a non-null value", ctx)
    if (value === null) throw resultFailure(ctx, path, "a non-null value", "null")
    return value
}

function rowUnknownOrNull(row: Record<string, unknown>, key: string, path: string, ctx: ResultContext): unknown {
    return requireField(row, key, path, "a present value", ctx)
}

/**
 * Internal implementation detail shared with generated query modules.
 * Not a supported API: its shape may change in any release.
 */
export const generatedInternals = Object.freeze({
    requireArgs,
    argInteger,
    argIntegerOrNull,
    argNumber,
    argNumberOrNull,
    argText,
    argTextOrNull,
    argBoolean,
    argBooleanOrNull,
    argBlob,
    argBlobOrNull,
    argJson,
    argJsonOrNull,
    argUnknown,
    argUnknownOrNull,
    rowInteger,
    rowIntegerOrNull,
    rowNumber,
    rowNumberOrNull,
    rowText,
    rowTextOrNull,
    rowBoolean,
    rowBooleanOrNull,
    rowBlob,
    rowBlobOrNull,
    rowJson,
    rowJsonOrNull,
    rowUnknown,
    rowUnknownOrNull,
})

declare const queryDescriptorResult: unique symbol

export interface QueryDescriptor<Result> {
    readonly [queryDescriptorResult]: Result
}

type InternalQuery =
    | {
        readonly kind: "one" | "one-insert"
        readonly name: string
        readonly sql: string
        readonly params: readonly unknown[]
        readonly parse: (row: Record<string, unknown>, ctx: ResultContext) => unknown
    }
    | {
        readonly kind: "many"
        readonly name: string
        readonly sql: string
        readonly params: readonly unknown[]
        readonly parse: (row: Record<string, unknown>, ctx: ResultContext) => unknown
    }
    | {
        readonly kind: "exec"
        readonly name: string
        readonly sql: string
        readonly params: readonly unknown[]
    }

function asInternalQuery(query: unknown, operation: "execute" | "batch", batchIndex?: number): InternalQuery {
    const usageFailure = (expected: string): QueryUsageError =>
        new QueryUsageError(`${operation} received a value that is not a generated query descriptor`, {
            operation,
            batchIndex,
            expected,
            received: describeValue(query),
        })
    if (typeof query !== "object" || query === null) throw usageFailure("a generated query descriptor")
    const candidate = query as Record<string, unknown>
    if (typeof candidate.name !== "string" || typeof candidate.sql !== "string" || !Array.isArray(candidate.params)) {
        throw usageFailure("a generated query descriptor")
    }
    const kind = candidate.kind
    if (kind !== "one" && kind !== "one-insert" && kind !== "many" && kind !== "exec") {
        throw usageFailure("a known query descriptor kind")
    }
    if (kind !== "exec" && typeof candidate.parse !== "function") throw usageFailure("a query descriptor with a row parser")
    return query as InternalQuery
}

type DescriptorResult<Q> = Q extends QueryDescriptor<infer Result> ? Result : never
type BatchResults<Q extends readonly QueryDescriptor<unknown>[]> = {
    [K in keyof Q]: DescriptorResult<Q[K]>
}

export abstract class QueryExecutor {
    protected constructor(protected executor: Executor) {
    }

    async execute<Result>(query: QueryDescriptor<Result>): Promise<Result> {
        const internalQuery = asInternalQuery(query, "execute")
        const queryName = internalQuery.name
        const stmt = this.executor.prepare(internalQuery.sql).bind(...internalQuery.params)
        switch (internalQuery.kind) {
            case "one": {
                const row = await stmt.first()
                if (row === null) return null as Result
                return internalQuery.parse(row as Record<string, unknown>, { operation: "execute", queryName, rowIndex: 0 }) as Result
            }
            case "one-insert": {
                const result = await stmt.run()
                if (result.results.length === 0) return null as Result
                return internalQuery.parse(result.results[0] as Record<string, unknown>, { operation: "execute", queryName, rowIndex: 0 }) as Result
            }
            case "many": {
                const result = await stmt.all()
                return result.results.map((row, rowIndex) =>
                    internalQuery.parse(row as Record<string, unknown>, { operation: "execute", queryName, rowIndex }),
                ) as Result
            }
            case "exec": {
                await stmt.run()
                return undefined as Result
            }
        }
    }

    async batch<Q extends readonly QueryDescriptor<unknown>[]>(...queries: Q): Promise<BatchResults<Q>> {
        const internalQueries = queries.map((query, batchIndex) => asInternalQuery(query, "batch", batchIndex))
        const stmts = internalQueries.map((query) =>
            this.executor.prepare(query.sql).bind(...query.params),
        )
        const results = await this.executor.batch(stmts)
        return results.map((result, batchIndex) => {
            const query = internalQueries[batchIndex]
            const queryName = query.name
            switch (query.kind) {
                case "one":
                case "one-insert": {
                    const rows = (result as D1Result<Record<string, unknown>>).results
                    if (rows.length === 0) return null
                    return query.parse(rows[0], { operation: "batch", queryName, batchIndex, rowIndex: 0 })
                }
                case "many": {
                    const rows = (result as D1Result<Record<string, unknown>>).results
                    return rows.map((row, rowIndex) => query.parse(row, { operation: "batch", queryName, batchIndex, rowIndex }))
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
