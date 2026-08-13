# Troubleshooting

Search this page for the exact `[CATEGORY/REASON]` printed by the Plugin. Generation diagnostics contain metadata locations but intentionally avoid SQL and values. Errors stop generation and produce no partial generated tree; `[COMPATIBILITY/UNTESTED_SQLC_VERSION]` is the sole warning listed below and generation continues.

## Triage by phase

1. **PROTOCOL** — sqlc could not supply a usable Plugin request.
2. **OPTIONS** — the `codegen.options` object is malformed or unsupported.
3. **COMPATIBILITY** — engine/sqlc-version policy does not match, or a newer version is untested.
4. **QUERY** — analyzed query metadata cannot be translated safely.
5. **EMISSION** — metadata cannot produce safe unique TypeScript files/declarations.
6. **INTERNAL** — an unexpected Plugin failure; collect safe report evidence.

Never correct these by editing generated files. Change sqlc configuration, schema, or query input and regenerate.

## Common generation diagnostics

### `[OPTIONS/UNKNOWN_OPTION]`

**Meaning:** `codegen.options` contains a key other than `interface`.

Failing configuration:

```yaml
options:
  interface: workers
  runtime: d1
```

Correction: remove `runtime`; the only option is `interface: workers`. **Generation stops.**

### `[COMPATIBILITY/UNTESTED_SQLC_VERSION]`

**Meaning:** sqlc is newer than the currently tested ceiling.

Failing-to-tested-evidence example: run generation with a version newer than v1.31.1.

Correction: use a [strategically tested version](compatibility.md#sqlc-support-policy), or review the warning and validate the newer version in your own environment. This is a **warning; generation continues** unless another diagnostic stops it.

### `[QUERY/UNSUPPORTED_COMMAND]`

**Meaning:** the annotation is outside the six supported commands.

```sql
-- name: LoadUsers :batchexec
DELETE FROM users WHERE id = ?;
```

Correction: use one of `:one`, `:many`, `:exec`, `:execrows`, `:execlastid`, or `:execresult`. If native runtime batching is wanted, generate ordinary descriptors and pass a non-empty tuple to `DB.batch()`. **Generation stops.**

### Bind-order failures

`[QUERY/BIND_NUMBER_GAP]` means bind numbers do not cover `1..N`. `[QUERY/UNSUPPORTED_BIND_ORDER]` means sqlc's order for mixed named/positional parameters cannot be reproduced safely as a SQLite binding.

```sql
-- name: Mixed :one
SELECT id, name FROM users WHERE id = ? AND name = sqlc.arg(name);
```

Correction: use named parameters consistently so sqlc produces reproducible contiguous bind metadata, or use plain positional placeholders consistently. **Generation stops.**

### Slice failures

`[QUERY/SLICE_BIND_MIXTURE]` rejects numbered placeholders in a query whose slice expansion would move them. `[QUERY/SLICE_METADATA_MISMATCH]` means slice parameters and SQL markers do not map one-to-one.

```sql
-- name: UsersByIds :many
SELECT id, name FROM users
WHERE id IN (sqlc.slice(ids)) AND name = sqlc.arg(name);
```

Correction: for a slice query, replace named/numbered scalar parameters with plain `?` placeholders as directed by the diagnostic, and ensure every slice name occurs unambiguously once. **Generation stops.** An empty slice is different: it throws `QueryArgumentError` synchronously when constructing the descriptor.

### `[EMISSION/OUTPUT_PATH_COLLISION]`

**Meaning:** two SQL source filenames derive the same output path (for example, `queries.sql` and `queries_sql`).

Correction: rename one SQL source file so each source maps to a distinct generated `*_*.ts` path. **Generation stops.** `[EMISSION/PORTABLE_OUTPUT_PATH_COLLISION]` covers paths differing only by filesystem case.

## Complete stable identifier inventory

Every identifier currently emitted by the Plugin is listed here. Unless marked “warning,” it stops generation.

### PROTOCOL

- `[PROTOCOL/MALFORMED_REQUEST]`
- `[PROTOCOL/MISSING_SETTINGS]`

### OPTIONS

- `[OPTIONS/INVALID_UTF8]`
- `[OPTIONS/MALFORMED_JSON]`
- `[OPTIONS/NON_OBJECT]`
- `[OPTIONS/UNKNOWN_OPTION]`
- `[OPTIONS/UNSUPPORTED_INTERFACE]`

### COMPATIBILITY

- `[COMPATIBILITY/MALFORMED_SQLC_VERSION]`
- `[COMPATIBILITY/MISSING_SQLC_VERSION]`
- `[COMPATIBILITY/UNSUPPORTED_ENGINE]`
- `[COMPATIBILITY/UNSUPPORTED_SQLC_VERSION]`
- `[COMPATIBILITY/UNTESTED_SQLC_VERSION]` — warning; continues

### QUERY

- `[QUERY/BIND_NUMBER_GAP]`
- `[QUERY/CONFLICTING_BIND_NUMBER]`
- `[QUERY/DUPLICATE_PHYSICAL_COLUMN]`
- `[QUERY/INVALID_BIND_NUMBER]`
- `[QUERY/INVALID_EMBED_METADATA]`
- `[QUERY/MISSING_COMMAND]`
- `[QUERY/MISSING_FILENAME]`
- `[QUERY/MISSING_NAME]`
- `[QUERY/MISSING_PARAMETER_COLUMN]`
- `[QUERY/MISSING_RESULT_COLUMNS]`
- `[QUERY/MISSING_SQL]`
- `[QUERY/SLICE_BIND_MIXTURE]`
- `[QUERY/SLICE_METADATA_MISMATCH]`
- `[QUERY/UNSUPPORTED_BIND_ORDER]`
- `[QUERY/UNSUPPORTED_COMMAND]`

### EMISSION

- `[EMISSION/AMBIGUOUS_EMBED_PROJECTION]`
- `[EMISSION/DECLARATION_COLLISION]`
- `[EMISSION/DUPLICATE_EMBED_COLUMN]`
- `[EMISSION/EMPTY_EMBED_TABLE]`
- `[EMISSION/INVALID_FIELD_NAME]`
- `[EMISSION/INVALID_OUTPUT_PATH]`
- `[EMISSION/INVALID_QUERY_NAME]`
- `[EMISSION/OUTPUT_PATH_COLLISION]`
- `[EMISSION/PORTABLE_OUTPUT_PATH_COLLISION]`
- `[EMISSION/RESERVED_DECLARATION]`
- `[EMISSION/UNKNOWN_EMBED_TABLE]`

### INTERNAL

- `[INTERNAL/PLUGIN_FAILURE]`

## Runtime errors

### `QueryArgumentError`

A generated factory rejected an argument synchronously. D1 was not called. Correct the required object shape/value; use `null` for SQL NULL, a safe integer for integer families, a finite number for numeric families, and a non-empty array for a slice.

### `QueryUsageError`

The runtime rejected executor use: common causes are an empty batch, a value that is not a generated descriptor, or an invalid session input. Construct descriptors only through generated factories and sessions only through `DB.withSession()`.

### `QueryResultError`

D1 returned successfully, but row or metadata mapping failed. Inspect safe fields such as `queryName`, `batchIndex`, `rowIndex`, `path`, `expected`, and `received`. A write may already have committed. **Do not retry solely because this error occurred.**

### Native D1 errors

Native errors pass through unchanged and are not wrapped as `SqlcD1Error`. Use Cloudflare's D1 diagnostics while preserving the original error identity. Native batch failure semantics differ from post-success local mapping failure; see [runtime and errors](runtime-and-errors.md#native-atomicity-and-local-mapping).

## Evidence for a report

Include:

- selected Plugin/release version and exact SHA-256;
- sqlc version;
- stable generation identifier or runtime error class;
- safe public context fields;
- minimal schema/query/configuration that reproduces the issue.

Remove credentials, authorization headers, production values, rows, bookmarks, and sensitive identifiers. Do not paste the publication candidate bytes. For an internal failure, report at the [repository issue tracker](https://github.com/mkuznets/sqlc-d1-typescript/issues).
