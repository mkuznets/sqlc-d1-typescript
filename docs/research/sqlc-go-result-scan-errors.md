# Research: sqlc Go result/`Scan` error behavior

## Summary

First-party sqlc Go output does not introduce a result-decoding error type. For PostgreSQL with either `database/sql` or pgx, and for SQLite through `database/sql`, generated `:one`/`RETURNING` methods return `row.Scan(...)` errors unchanged; generated `:many` methods likewise return `rows.Scan`/`rows.Err` errors unchanged. Any distinction or column context therefore comes from the called API (`database/sql` or pgx), not sqlc, and sqlc attaches neither query identity nor commit/retry metadata.

A write with `RETURNING` can have reached result production before conversion fails, but neither sqlc nor the underlying row-scan APIs report whether its effects committed. Explicit transactions differ operationally because the caller still controls `Commit`/`Rollback`; the generated scan-error contract itself is the same as in autocommit use.

## Scope and direct answers

| Question                                                     | Finding                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (1) Does sqlc wrap `Scan` errors?                            | **No.** Generated code returns the exact error value produced by `Scan` (or by `Rows.Err`/`Close`) without `%w`, replacement, or a sqlc error type.                                                                                                                                                                                    |
| (2) Does generated code distinguish execution from decoding? | **No stable generated distinction.** `QueryRow` deliberately defers query errors to `Scan`, so both emerge from the same generated `return i, err`. `:many` has a separate immediate `Query` error branch, but scan/iteration errors remain plain driver/API errors.                                                                   |
| (3) Does it attach query identity/context?                   | **No.** SQL text and generated method name exist in code, but are not added to the returned error. `database/sql` and pgx may add column/destination context.                                                                                                                                                                          |
| (4) Commit state or retry safety after `RETURNING`?          | **No.** No sqlc template, `database/sql` scan error, or pgx scan error reviewed carries committed/rolled-back/indeterminate or retry-safe metadata.                                                                                                                                                                                    |
| (5) Transaction versus autocommit?                           | **Same scan-error shape.** `WithTx` changes the executor stored in `Queries`; it does not change scanning. In an explicit transaction, the caller separately decides `Commit`/`Rollback`. With a `*sql.DB`/`*pgx.Conn`, statement transaction handling is outside the generated method, so a scan failure is not evidence of rollback. |

## Findings

### 1. sqlc's standard-library template returns `Scan` errors directly

**Severity: high for runtime-contract compatibility.** The first-party `database/sql` query template emits the equivalent of:

```go
row := q.queryRow(ctx, q.createAuthorStmt, createAuthor, arg.Name, arg.Bio)
var i Author
err := row.Scan(&i.ID, &i.Name, &i.Bio)
return i, err
```

This is the documented/generated shape for an `INSERT ... RETURNING ...` query annotated `:one`. There is no sqlc wrapper, phase enum, query name, SQL text, or effects flag around `err`. The same template family is selected for standard-library Go output regardless of whether sqlc's SQL engine is PostgreSQL or SQLite; database choice changes types and SQL, not this error path. [sqlc standard-library `queryCode.tmpl`](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/templates/stdlib/queryCode.tmpl) · [sqlc first-party INSERT/`RETURNING` example](https://docs.sqlc.dev/en/stable/howto/insert.html#returning-columns-from-inserted-rows)

For `:many`, the generated structure separates failure to start `QueryContext` from later consumption, but still adds no error identity:

```go
rows, err := q.query(ctx, q.someStmt, someQuery, args...)
if err != nil { return nil, err }
defer rows.Close()
for rows.Next() {
    var i T
    if err := rows.Scan(&i.Field1, &i.Field2); err != nil {
        return nil, err
    }
    items = append(items, i)
}
if err := rows.Err(); err != nil { return nil, err }
return items, nil
```

Thus a caller can sometimes infer “query call” versus “row consumption” only from the concrete underlying error or external instrumentation—not from a generated sqlc contract. [stdlib template, same source](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/templates/stdlib/queryCode.tmpl)

### 2. sqlc's pgx templates follow the same direct-return policy

**Severity: high for cross-driver consistency.** The pgx/v5 generated shape is materially the same:

```go
row := q.queryRow(ctx, q.createAuthorStmt, createAuthor, arg.Name, arg.Bio)
var i Author
err := row.Scan(&i.ID, &i.Name, &i.Bio)
return i, err
```

The pgx template returns `row.Scan` and `rows.Scan` failures directly. It does not translate a pgx scan failure into a sqlc-owned type, nor add the generated query name or constant. [sqlc pgx/v5 `queryCode.tmpl`](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/templates/pgx/v5/queryCode.tmpl) · [pgx/v4 template, showing the established earlier behavior](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/templates/pgx/v4/queryCode.tmpl)

The same is true of pgx batch-result methods: sqlc consumes the queued result with pgx and returns its scan error. Batch support changes when execution is flushed, but does not add commit-state or retry metadata to decode failures. [sqlc pgx/v5 batch template](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/templates/pgx/v5/batchCode.tmpl)

### 3. `database/sql` itself supplies column context, while `QueryRow` merges deferred execution and scan errors at the call site

**Severity: medium; important distinction between sqlc policy and standard-library behavior.** `DB.QueryRowContext` always returns a non-nil `*Row`; its documentation says errors are deferred until `Row.Scan`. `Row.Scan` first returns the deferred query error, then handles `ErrNoRows`, then calls `Rows.Scan`. Consequently this sqlc line:

```go
err := row.Scan(...)
```

can return a server/driver execution error, `sql.ErrNoRows`, or a conversion/destination error. sqlc does not tag which branch occurred. [`DB.QueryRowContext` and `Row.Scan`, Go source](https://cs.opensource.google/go/go/+/refs/tags/go1.24.0:src/database/sql/sql.go) · [`database/sql` package documentation](https://pkg.go.dev/database/sql@go1.24.0)

When conversion itself fails, `Rows.Scan` wraps the cause with standard-library column context using `%w`:

```go
return fmt.Errorf(
    `sql: Scan error on column index %d, name %q: %w`,
    i, rs.rowsi.Columns()[i], err,
)
```

That context is column index/name only. It is not a sqlc wrapper and contains no query/method identity, execution phase field, transaction state, or retry guidance. [`Rows.Scan` implementation in `database/sql/sql.go`](https://cs.opensource.google/go/go/+/refs/tags/go1.24.0:src/database/sql/sql.go)

### 4. pgx supplies destination/column scan context but sqlc propagates it unchanged

**Severity: medium.** pgx v5's row implementation constructs a `ScanArgError` when a scan plan cannot assign a field. The type records the destination/column index, optional PostgreSQL field name, and underlying error; the row is then made fatal/closed. `QueryRow` also defers errors until `Scan`, parallel to `database/sql`. [pgx v5 `rows.go`: `ScanArgError`, `baseRows.Scan`, and `connRow.Scan`](https://github.com/jackc/pgx/blob/v5.7.2/rows.go) · [pgx v5 `Row`/`Rows` API](https://pkg.go.dev/github.com/jackc/pgx/v5@v5.7.2#Row)

This gives more diagnostic decoding context than sqlc itself, but still does not identify the generated query and does not assert whether a write committed. PostgreSQL server errors remain pgx/pgconn errors; because `QueryRow` defers them, the generated `:one` method does not by itself separate those from client-side scan errors.

### 5. SQLite does not introduce a different sqlc contract

**Severity: medium.** sqlc's SQLite Go output uses the standard-library template and its `DBTX` abstraction (`ExecContext`, `QueryContext`, `QueryRowContext`). Therefore a SQLite `INSERT/UPDATE/DELETE ... RETURNING` annotated `:one` reaches the same generated `row.Scan` / direct `return i, err` path as PostgreSQL `database/sql`. [sqlc stdlib `dbCode.tmpl`](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/templates/stdlib/dbCode.tmpl) · [sqlc SQLite getting-started generated code](https://docs.sqlc.dev/en/stable/tutorials/getting-started-sqlite.html)

With a common SQLite `database/sql` driver such as `mattn/go-sqlite3`, the driver implements the `database/sql/driver` connection, rows, and transaction interfaces; destination assignment and the standard `sql: Scan error on column ...` wrapper occur above it in `database/sql`. The driver's transaction `Commit` and `Rollback` are separate operations and its scan values carry no sqlc query identity or retry-safety flag. [`mattn/go-sqlite3` driver source](https://github.com/mattn/go-sqlite3/blob/v1.14.24/sqlite3.go) · [`sqlite3_go18.go` context methods](https://github.com/mattn/go-sqlite3/blob/v1.14.24/sqlite3_go18.go)

The precise instant at which a SQLite driver finishes an implicit transaction relative to consuming all `RETURNING` rows is a driver/core execution detail. sqlc's returned error does not expose it, so the generated API offers no basis for treating a decoding failure as proof of rollback or as permission to retry.

### 6. `WithTx` swaps the executor; it does not alter or enrich errors

**Severity: high for documenting transaction semantics.** Standard-library generated code implements `WithTx(tx *sql.Tx)` by returning a `Queries` whose `db`/prepared handles use that transaction. pgx output does the analogous thing with `pgx.Tx`. Query methods and their `Scan` returns are otherwise unchanged. [stdlib `dbCode.tmpl`](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/templates/stdlib/dbCode.tmpl) · [pgx/v5 `dbCode.tmpl`](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/templates/pgx/v5/dbCode.tmpl)

The primary APIs keep disposition separate:

- `database/sql.Tx` must be ended with `Commit` or `Rollback`; after either, operations fail with `ErrTxDone`. Its docs warn that a failed `Commit` means query results should be discarded, but a prior `Scan` failure itself says nothing about the later commit outcome. [`database/sql.Tx` docs/source](https://cs.opensource.google/go/go/+/refs/tags/go1.24.0:src/database/sql/sql.go)
- pgx `Tx.Commit` and `Tx.Rollback` are explicit. pgx documents `ErrTxCommitRollback` for a commit that PostgreSQL converted to rollback, but that information belongs to the commit operation—not a row scan error. [pgx v5 `tx.go`](https://github.com/jackc/pgx/blob/v5.7.2/tx.go)

Accordingly:

- **Explicit transaction:** after a `RETURNING` scan failure, sqlc has not automatically committed or rolled back. The caller still owns transaction disposition (subject to server/connection failure). Retrying inside or outside that transaction cannot be decided from the scan error alone.
- **Connection/DB execution (commonly called autocommit):** no generated transaction handle remains for the caller to roll back. A returned/partially consumed result proves execution reached result handling, but the scan error does not report whether implicit commit completed. Automatic retry is therefore not justified by sqlc's error contract.

## Comparison with candidate `QueryResultError` / `effectsMayHaveCommitted`

This comparison describes deltas, not a product recommendation.

| Candidate property                     | Established sqlc Go behavior                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dedicated `QueryResultError`           | No sqlc-owned equivalent. Scan errors retain the standard-library/driver concrete error and identity.                                                      |
| Distinct post-execution decoding phase | Not represented by a stable generated type. Some `:many` control flow separates initial `Query` failure; `:one` execution errors are deferred into `Scan`. |
| Preserve underlying cause              | Direct return preserves exact identity. `database/sql` and pgx may themselves wrap while retaining a cause.                                                |
| Query identity/context                 | Generated method/SQL constant is not attached to errors. Only scan-column/destination context may be supplied below sqlc.                                  |
| `effectsMayHaveCommitted`              | No analogue in sqlc, `database/sql` scan errors, pgx scan errors, or the reviewed SQLite driver API.                                                       |
| Retry-safety meaning                   | No reviewed API labels scan failures retry-safe. Commit/rollback is handled through transaction APIs, not inferred from mapping failure.                   |

A candidate wrapper would therefore be a deliberately richer contract than first-party sqlc Go output. If it preserves `cause`, it can retain the useful low-level conversion detail, but query identity, explicit phase, and a conservative effects-hazard flag would all be additions rather than parity behavior. Conversely, matching sqlc exactly would mean no runtime-owned classification and no commit-hazard signal.

## Sources

### Kept

- [sqlc stdlib `queryCode.tmpl`](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/templates/stdlib/queryCode.tmpl) — primary generator logic for PostgreSQL and SQLite through `database/sql`.
- [sqlc pgx/v5 `queryCode.tmpl`](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/templates/pgx/v5/queryCode.tmpl) — primary pgx generator logic.
- [sqlc pgx/v5 `batchCode.tmpl`](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/templates/pgx/v5/batchCode.tmpl) — primary queued-result scan behavior.
- [sqlc stdlib and pgx/v5 `dbCode.tmpl`](https://github.com/sqlc-dev/sqlc/tree/main/internal/codegen/golang/templates) — generated executor and `WithTx` behavior.
- [sqlc INSERT/`RETURNING` how-to](https://docs.sqlc.dev/en/stable/howto/insert.html#returning-columns-from-inserted-rows) — representative first-party generated method.
- [Go 1.24 `database/sql` source](https://cs.opensource.google/go/go/+/refs/tags/go1.24.0:src/database/sql/sql.go) — exact deferred `QueryRow` and scan-wrapping behavior.
- [pgx v5.7.2 `rows.go`](https://github.com/jackc/pgx/blob/v5.7.2/rows.go) and [`tx.go`](https://github.com/jackc/pgx/blob/v5.7.2/tx.go) — scan context and explicit transaction behavior.
- [`mattn/go-sqlite3` v1.14.24 source](https://github.com/mattn/go-sqlite3/tree/v1.14.24) — representative primary SQLite `database/sql` driver implementation.

### Dropped

- Existing `docs/research/post-execution-result-decoding-errors.md` — useful scope context, but excluded as evidence because it is secondary to the requested sqlc-specific sources.
- Blog posts, Stack Overflow answers, ORM discussions, and generated code from non-sqlc repositories — excluded by the primary-source requirement.
- JDBC, R2DBC, Dapper, Rust sqlx, and Cloudflare D1 material — outside this focused Go/sqlc evidence request.

## Gaps and confidence

**Confidence: high** that first-party sqlc templates return scan errors unchanged and attach no query or commit metadata; **high** on `database/sql` and pgx's scan/deferred-error behavior; **moderate** on a universal autocommit timing statement, because exact `RETURNING` result-consumption/implicit-commit timing can vary by PostgreSQL protocol mode and SQLite driver/core behavior.

Gaps:

1. This source review does not fault-inject a `RETURNING` conversion failure against every supported driver/protocol mode; doing so would characterize timing, not change the generated error contract.
2. sqlc supports more SQLite drivers than `mattn/go-sqlite3`; all pass through `database/sql` for generated stdlib code, but driver-specific result lifecycle details may differ.
3. Main-branch sqlc template links can move. The pgx and Go runtime evidence is version-pinned; a follow-up archival pass could pin the sqlc links to the exact sqlc release used as the compatibility baseline.

## Review findings

- **High — `internal/codegen/golang/templates/stdlib/queryCode.tmpl`:** sqlc directly returns `Scan` failures, with no generated execution-vs-decoding classification or query identity.
- **High — `internal/codegen/golang/templates/pgx/v5/queryCode.tmpl`:** pgx output has the same direct-return behavior, including writes with `RETURNING`.
- **High — `internal/codegen/golang/templates/{stdlib,pgx/v5}/dbCode.tmpl`:** transaction use changes the executor only; it does not change the scan-error contract or report commit state.
- **Medium — Go `src/database/sql/sql.go` and pgx `rows.go`:** lower layers add column/destination context, but no query identity, commit state, or retry-safety guarantee.
- **Medium — SQLite driver lifecycle:** a post-execution conversion failure is not portable evidence that an implicit transaction rolled back; sqlc exposes no state with which to decide that question.
