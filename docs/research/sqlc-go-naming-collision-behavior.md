# sqlc Go naming-collision behavior

Research for [Define safe TypeScript source emission and naming](https://github.com/mkuznets/sqlc-d1-typescript/issues/19).

## Current D1 TypeScript plugin

The current plugin has no identifier or output-name allocator.

- Query declarations are derived directly from `query.name`; transformed collisions and reserved words are not checked (`src/app.ts`). For example, `Foo` and `foo` both derive `foo` and `fooQuery`, while `Class` derives the invalid factory name `class`.
- Argument and row properties use a lossy lowercase-plus-underscore transformation without collision checking (`src/utils.ts`). Distinct parameters can therefore collapse onto one `args` property and bind the same value twice (`src/d1.ts`).
- Exact duplicate physical result-column names are explicitly rejected because D1 object rows cannot preserve both values (`src/app.ts`). Distinct physical names that normalize to the same public property are not detected.
- Output filenames use only `filename.replace(".", "_")` and are not checked for traversal, portability, or derived-name collisions (`src/app.ts`).

Except for exact duplicate D1 result keys, collisions currently become malformed generated TypeScript, later compiler errors, or silent semantic aliasing.

## Official sqlc Go generator

The official Go generator provides a useful but partial precedent. The behavior below exists in sqlc v1.18.0 and remains in the current generator unless noted.

### Explicit duplicate query-name rejection

The compiler rejects an exact repeated `-- name:` before code generation. It also stores `filepath.Base(filename)` in query metadata, so query modules are organized by source basename rather than the original directory path.

Sources:

- [v1.18.0 compiler](https://github.com/sqlc-dev/sqlc/blob/v1.18.0/internal/compiler/compile.go)
- [current compiler](https://github.com/sqlc-dev/sqlc/blob/main/internal/compiler/compile.go)

### Deterministic struct-field suffixes

`columnsToStruct` allocates normalized Go fields in position order. A later collision becomes `_2`, `_3`, and so forth. Repeated occurrences of the same logical named parameter remain one field rather than being suffixed.

For example, positional columns that normalize to `CreatedAt` become:

```go
CreatedAt   time.Time
CreatedAt_2 time.Time
```

This works for Go result rows because `rows.Scan` is positional. It cannot justify accepting exact duplicate D1 physical result keys: a D1 object row has already discarded one value before public-property naming begins.

Sources:

- [v1.18.0 `columnsToStruct`](https://github.com/sqlc-dev/sqlc/blob/v1.18.0/internal/codegen/golang/result.go)
- [current `columnsToStruct`](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/result.go)

### Reserved words and wider symbol collisions

Current sqlc has an `escape` helper that appends `_` to Go reserved local/parameter names. It does not form a complete package-wide allocator: query constants are derived separately, and distinct query names can still collide after case conversion. Some current configurations explicitly validate exported query constants against generated model and enum names, but other generated-symbol collisions can still reach generated-source formatting or Go compilation.

Sources:

- [current reserved-name handling](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/reserved.go)
- [current generator validation](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/gen.go)
- [current query construction](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/result.go)

### Output files

The compiler reduces query source paths to basenames. The Go generator groups all queries with the same `SourceName` into one query file and stores rendered files in a filename-keyed map. It does not encode the original directory path or allocate suffixed filenames.

Sources:

- [v1.18.0 generator](https://github.com/sqlc-dev/sqlc/blob/v1.18.0/internal/codegen/golang/gen.go)
- [current generator](https://github.com/sqlc-dev/sqlc/blob/main/internal/codegen/golang/gen.go)

## Decision implication

The Go generator is precedent for deterministic suffixes inside a generated argument or row structure, but not for relying on compiler failures or overwrites elsewhere.

For the D1 TypeScript plugin:

- exact duplicate physical D1 result keys still require an SQL alias and a generation error;
- repeated occurrences of one logical named argument should remain one public property;
- distinct arguments or distinct physical row aliases that normalize to the same public property can safely use deterministic positional suffixes;
- query declaration and output-path collisions should receive explicit generation diagnostics rather than silently changing public names.
