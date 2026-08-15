# Failure routing

Reached from `SKILL.md` when `sqlc generate` prints a `[CATEGORY/REASON]` line, when the compiler rejects a
generated type, or when a local D1 test throws.

Every route below ends in the same place: change an input — the sqlc configuration, the schema, the query, or
the consumer code that calls the generated API — and run the step again. Generated files stay exactly as the
Plugin wrote them.

## Generation diagnostics

An error stops generation and leaves no partial generated tree, so correct the input the phase names and run
`sqlc generate` again. `[COMPATIBILITY/UNTESTED_SQLC_VERSION]` is the one warning that lets generation
continue; carry it into the step 7 report rather than absorbing it.

| Phase           | What it means                                                             | What to change                                     |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| `PROTOCOL`      | sqlc could not supply a usable Plugin request.                            | The sqlc invocation and the sqlc version.          |
| `OPTIONS`       | `codegen.options` is malformed or unsupported.                            | The configuration; `interface: workers` is it.     |
| `COMPATIBILITY` | Engine or sqlc-version policy does not match, or the version is untested. | The `engine` value, or the sqlc version.           |
| `QUERY`         | Analyzed query metadata cannot be translated safely.                      | The query or the schema.                           |
| `EMISSION`      | Metadata cannot produce safe unique TypeScript files or declarations.     | Query names, SQL source filenames, or `out`.       |
| `INTERNAL`      | An unexpected Plugin failure.                                             | Nothing locally: collect safe evidence and report. |

The exact identifier, its correction, and the full inventory live in
[`docs/troubleshooting.md`](https://github.com/mkuznets/sqlc-d1-typescript/blob/v<version>/docs/troubleshooting.md)
at the installed tag. Search that page for the identifier the Plugin printed; the identifiers are stable.

The commands, macros, metadata shapes, and value representations the Plugin promises to translate — the
compatibility surface — are in
[`docs/sqlc-to-d1.md`](https://github.com/mkuznets/sqlc-d1-typescript/blob/v<version>/docs/sqlc-to-d1.md) at
the same tag. An input outside that surface is corrected in the SQL, never worked around in the output.

## Runtime errors

The generated runtime exports four stable error classes. `SqlcD1Error` is the base class the other three
extend, and it carries the safe context fields `operation`, `queryName`, `batchIndex`, `rowIndex`, `path`,
`expected`, `received`, and `cause`. The fact that decides what to do at the moment of failure is whether D1
already ran.

| Class                | Phase                     | Was D1 called?                         | What to do                                                                                                                                 |
| -------------------- | ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `QueryArgumentError` | descriptor construction   | no                                     | Correct the argument shape or the bind value passed to the factory.                                                                        |
| `QueryUsageError`    | construction/executor use | normally no native operation           | Build query descriptors through generated factories, session executors through `withSession()`, batches with a statically non-empty tuple. |
| `QueryResultError`   | post-native mapping       | yes — a write may already have effects | Report the safe context fields and treat any retry as a separate, application-specific decision.                                           |
| native D1 error      | native execution          | attempted; identity unchanged          | Use Cloudflare's own D1 diagnostics: the Plugin does not wrap native failures.                                                             |

Descriptor reuse, batch atomicity, session executors, session bookmarks, retry safety, and the logging rules
are in
[`docs/runtime-and-errors.md`](https://github.com/mkuznets/sqlc-d1-typescript/blob/v<version>/docs/runtime-and-errors.md)
at the installed tag.

## The fail-closed rule

Stop the run and report what was reached when the release record cannot be read, when a diagnostic is not
understood, when an input falls outside the compatibility surface, or when a value does not fit a generated
declaration.

Reporting a stop is the successful outcome of that situation. The generated declarations are the contract:
make them right by changing the SQL, the schema, or the configuration and regenerating. Keep consumer code
free of type assertions and compiler suppressions, keep generated files byte-identical to what the Plugin
emitted, and keep every query on the Workers binding interface.
