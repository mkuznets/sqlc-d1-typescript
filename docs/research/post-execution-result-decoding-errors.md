# Research: post-execution row/result decoding failures

## Summary

Established APIs generally distinguish **server/driver execution errors** from **client-side row conversion errors**, but they generally do **not** attach a portable “committed” status to a conversion error. The transaction boundary matters more than the mapper: in an explicit transaction a decode error normally leaves commit/rollback to the caller, while in autocommit or an already-successful atomic D1 batch, effects can already be durable (or can be in an indeterminate completion window) when mapping fails.

The closest precedents for `QueryResultError` are sqlx’s `ColumnDecode`, Go `database/sql`’s contextual `Scan error on column`, pgx’s scan/mapping errors, and Dapper’s `DataException` around column parsing. These preserve useful mapping context but do not promise commit status. This supports treating an `effectsMayHaveCommitted` member as conservative retry-safety information, separate from the underlying mapping cause—not as proof that a commit occurred.

## Findings

1. **Rust sqlx has a distinct client-side decoding error, separate from database errors, but no commit-state field.** `sqlx::Error` has `Database(Box<dyn DatabaseError>)` for errors returned by the database and `ColumnDecode { index, source }` for decoding a value from a row. `FromRow` is explicitly implemented by calling `Row::try_get`, so generated/runtime row construction can fail after a row exists. `Transaction::commit` and `rollback` are separate operations; dropping an open transaction starts rollback. None of `ColumnDecode`, `FromRow`, or the transaction API exposes whether an autocommit statement committed. [sqlx `Error`](https://docs.rs/sqlx/latest/sqlx/error/enum.Error.html) · [sqlx `FromRow`](https://docs.rs/sqlx/latest/sqlx/trait.FromRow.html) · [sqlx `Transaction`](https://docs.rs/sqlx/latest/sqlx/struct.Transaction.html)

2. **Go `database/sql` makes row conversion a `Scan` concern and wraps it with column context, while transaction disposition remains explicit.** `Row.Scan` reports destination conversion failures; the implementation wraps these as `sql: Scan error on column index …, name …: %w`, preserving the underlying cause. `QueryRow` defers query errors until `Scan`, so callers receive execution and conversion failures through one method even though the implementation can distinguish their origin. For explicit transactions, `Tx.Commit`/`Rollback` are caller operations; the docs say that on a failed `Commit`, query results should be discarded, but neither a scan error nor a commit error carries a standard committed/indeterminate flag. [Go `database/sql` API](https://pkg.go.dev/database/sql) · [`convert.go` scan wrapping](https://cs.opensource.google/go/go/+/refs/tags/go1.24.0:src/database/sql/convert.go) · [`sql.go` `Row.Scan`/`Tx`](https://cs.opensource.google/go/go/+/refs/tags/go1.24.0:src/database/sql/sql.go)

3. **pgx likewise separates PostgreSQL server errors from scan/mapping failures, without commit inference.** The low-level `pgconn.PgError` represents a PostgreSQL `ErrorResponse`. At the row layer, `Row.Scan`, `CollectRows`, and helpers such as `RowToStructByName` can fail while converting an already-returned row; `CollectRows` closes rows and returns the collection/mapping error. `pgx.Tx` exposes explicit `Commit` and `Rollback`; its docs also note that a commit can return `ErrTxCommitRollback` when PostgreSQL has implicitly rolled back. That is transaction outcome information on the **commit operation**, not a commit marker attached to row-decoding errors. [pgx package API](https://pkg.go.dev/github.com/jackc/pgx/v5) · [`pgconn.PgError`](https://pkg.go.dev/github.com/jackc/pgx/v5/pgconn#PgError)

4. **JDBC uses `SQLException` for both database access and conversion failures, so categorization is less precise and commit inference is left to the caller/provider lifecycle.** Typed `ResultSet` getters throw `SQLException` when conversion fails. JDBC auto-commit semantics state that a transaction is committed when a statement “completes,” and define completion in terms of retrieving/closing all result sets and update counts. Consequently, an `INSERT … RETURNING` exposed as a result set can raise a conversion error before statement completion/auto-commit is observable; callers cannot infer commit solely from the exception class. With auto-commit disabled, `Connection.commit()` and `rollback()` remain explicit. JDBC provides no standard “effects may have committed” property on a getter exception. [`ResultSet`](https://docs.oracle.com/en/java/javase/21/docs/api/java.sql/java/sql/ResultSet.html) · [`Connection.setAutoCommit`](<https://docs.oracle.com/en/java/javase/21/docs/api/java.sql/java/sql/Connection.html#setAutoCommit(boolean)>) · [JDBC 4.3 specification](https://jcp.org/aboutJava/communityprocess/mrel/jsr221/index3.html)

5. **R2DBC specifies mapper exceptions as reactive errors, independently of transaction control.** `Result.map` maps readable row segments; exceptions from user mapping are propagated as error signals. The SPI separately defines auto-commit mode and `beginTransaction`, `commitTransaction`, and `rollbackTransaction`. It does not standardize a commit-state attribute for a mapping error. This is a clear API-level separation between “result consumption failed” and “transaction control,” but leaves autocommit completion semantics to the driver/database protocol. [R2DBC 1.0 specification: result mapping](https://r2dbc.io/spec/1.0.0.RELEASE/spec/html/#results.mapping) · [R2DBC transactions](https://r2dbc.io/spec/1.0.0.RELEASE/spec/html/#transactions)

6. **Dapper wraps materialization failures with row/column/value context, but provider/transaction semantics still determine durability.** Dapper’s `ThrowDataException` creates a `DataException` identifying the column index, name, value, and underlying exception while materializing a data-reader row. Database-provider exceptions remain their native types. Dapper accepts an `IDbTransaction` parameter rather than deciding commit/rollback after a mapping exception, and its mapping exception has no commit-status field. [Dapper `SqlMapper.ThrowDataException` source](https://github.com/DapperLib/Dapper/blob/main/Dapper/SqlMapper.cs) · [Dapper transaction usage in README](https://github.com/DapperLib/Dapper#execute-a-command-that-returns-no-results)

7. **Cloudflare D1’s batch contract makes the post-execution distinction especially important.** `D1Database.batch()` executes statements sequentially as a SQL transaction and states that, if a statement fails, the sequence aborts and rolls back. A successful batch therefore returns result objects only after D1 has treated the batch as successful; a later generated TypeScript row-mapping failure is not a D1 statement failure and cannot trigger that server-side rollback. D1 result metadata includes fields such as `changed_db`, `changes`, and `rows_written`, but the Workers binding does not define a commit-status field on a subsequent local mapper exception. [D1 `batch`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) · [D1 result object](https://developers.cloudflare.com/d1/worker-api/return-object/)

8. **Autocommit, explicit transactions, and post-batch mapping require different interpretations.**
   - **Autocommit statement:** a returned row proves the statement reached result production, but APIs such as JDBC can define commit completion around result-set exhaustion/closure. A decode error therefore does not portably prove either rollback or commit. Retrying a write solely because mapping failed can duplicate effects.
   - **Explicit transaction:** a decode failure normally does not itself call commit. The caller can usually roll back, unless it separately called commit or lost the connection; transaction-control errors, not mapper errors, are where libraries sometimes expose limited outcome information.
   - **Successful atomic batch followed by local mapping:** atomicity protects against a _statement_ failure inside the batch, not a consumer failure after successful execution. If D1 has returned a successful batch, local decoding cannot undo it; multiple write effects may already be committed together.

9. **Primary APIs preserve causes/context more often than commit status, and none reviewed instructs automatic retry after decode failure.** sqlx has an explicit `ColumnDecode` variant with a source; Go wraps the conversion cause with `%w`; Dapper wraps with an inner exception and column details. JDBC/R2DBC use broader error channels. Across these ecosystems, retry policy is not encoded in the mapping exception. The safe cross-ecosystem reading is that a client-side conversion failure is not evidence that a write failed.

## Implications for `QueryResultError` (without choosing the product design)

- A dedicated `QueryResultError` is consistent with sqlx’s `ColumnDecode` and Dapper/Go’s contextual scan errors: it can distinguish “D1 execution returned a result, but generated row mapping rejected it” from a D1/database error.
- Preserve the original mapping exception as `cause` and include stable query/row/column context where available. Avoid presenting the mapping error as a wrapped **database error**: the reviewed libraries generally keep server errors and conversion failures conceptually distinct, even when they share a broad base class.
- `effectsMayHaveCommitted` would be retry-safety metadata, not a transaction oracle. Its wording should remain conservative: `true` means the caller must not assume retry is safe; it does not mean every execution committed.
- The value can reasonably depend on execution phase and query shape: post-result mapping of a potentially effectful autocommit statement or a successful D1 batch has the hazard; pre-execution validation/binding does not. For an explicit transaction/session abstraction, the field alone cannot replace knowledge of whether commit was invoked.
- If the runtime cannot reliably classify read-only versus effectful descriptors, conservative `true` after database execution avoids a false “safe to retry” signal, at the cost of being less specific for reads.
- Batch errors should retain which descriptor/row failed to map while making clear that mapper failure is outside D1’s atomic rollback contract.

## Sources

### Kept

- [sqlx `Error`, `FromRow`, and `Transaction` API docs](https://docs.rs/sqlx/latest/sqlx/) — primary API definitions for decode-vs-database errors and transaction control.
- [Go `database/sql` docs and standard-library source](https://pkg.go.dev/database/sql) — primary documentation plus exact scan-error wrapping implementation.
- [pgx v5 API](https://pkg.go.dev/github.com/jackc/pgx/v5) — primary driver API for row collectors, PostgreSQL errors, and transaction methods.
- [Java SE 21 JDBC API and JDBC 4.3 specification](https://docs.oracle.com/en/java/javase/21/docs/api/java.sql/java/sql/package-summary.html) — normative auto-commit/result conversion behavior.
- [R2DBC 1.0 specification](https://r2dbc.io/spec/1.0.0.RELEASE/spec/html/) — normative reactive mapping and transaction behavior.
- [Dapper source](https://github.com/DapperLib/Dapper/blob/main/Dapper/SqlMapper.cs) — primary implementation of materialization error wrapping.
- [Cloudflare D1 Workers Binding docs](https://developers.cloudflare.com/d1/worker-api/) — authoritative batch atomicity and result metadata contract relevant to this plugin.

### Dropped

- ORM tutorials, Stack Overflow answers, blog posts, and retry guides — secondary evidence was excluded by the task.
- Prisma/Drizzle/Kysely commentary — no equally clear primary contract was identified that added commit-state evidence beyond the selected runtime-decoding examples.

## Gaps and residual risks

- Driver behavior can depend on protocol and cursor mode. In particular, whether an autocommit `RETURNING` statement is already committed at the exact instant a mapper fails is not portable across JDBC, PostgreSQL drivers, SQLite bindings, or streaming configurations.
- D1 documents successful-batch atomicity, but its public Workers API does not specify a distinct wire-level instant at which a JavaScript caller may regard commit as durable relative to local post-processing.
- This review establishes API contracts and implementation patterns; it does not experimentally fault-inject decoding failures against D1. A focused test with a successful write/batch followed by an intentionally throwing row mapper would verify the plugin’s concrete timing and error preservation.

## Review findings

- **High:** Retrying `INSERT/UPDATE … RETURNING` after a client-side decode/mapping failure can duplicate effects because the mapping failure is not proof of database rollback.
- **High:** A successful D1 atomic batch cannot be rolled back by a later generated row-mapping exception; all successful write effects in that batch may already be committed.
- **Medium:** A boolean commit-hazard field cannot report actual commit outcome across autocommit, streaming result consumption, connection loss, and explicit transactions; documentation must frame it as conservative retry-safety metadata.
- **Medium:** Collapsing mapping failures into a database-error type would obscure the phase distinction that sqlx, pgx, Go wrapping context, and Dapper preserve.
