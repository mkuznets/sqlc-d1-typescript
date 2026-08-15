# sqlc-to-D1 translation

sqlc remains responsible for parsing SQL, resolving schema types, and defining annotation and macro syntax. The Plugin consumes sqlc's analyzed SQLite metadata and translates the supported compatibility surface into TypeScript for the Workers binding interface. Use sqlc's [query annotations](https://docs.sqlc.dev/en/stable/reference/query-annotations.html) and [macro reference](https://docs.sqlc.dev/en/stable/reference/macros.html) for syntax.

## Commands

| sqlc command  | Generated descriptor result         | D1 operation                              |
| ------------- | ----------------------------------- | ----------------------------------------- |
| `:one`        | `Row \| null`                       | first row, including write-returning rows |
| `:many`       | `Row[]`                             | all rows                                  |
| `:exec`       | `void`                              | execute and discard native result         |
| `:execrows`   | safe-integer `number`               | validate `meta.changes`                   |
| `:execlastid` | safe-integer `number`               | validate `meta.last_row_id`               |
| `:execresult` | `D1Result<Record<string, unknown>>` | return the native result                  |

Other commands fail generation with `[QUERY/UNSUPPORTED_COMMAND]`. In particular, sqlc's batch annotation family is unsupported. Runtime `DB.batch()` is a separate API for batching already-generated query descriptors.

## Parameters and macros

| sqlc metadata                | Generated outcome                                                                |
| ---------------------------- | -------------------------------------------------------------------------------- |
| positional parameter         | required property derived from sqlc's parameter column metadata                  |
| `sqlc.arg` / named parameter | required property in the generated argument interface                            |
| `sqlc.narg`                  | required property whose type includes `null`                                     |
| `sqlc.slice`                 | required `ReadonlyArray<T>` property; expanded to bind placeholders              |
| `sqlc.embed`                 | nested public row object reconstructed from privately rewritten physical aliases |

The Plugin follows sqlc's metadata rather than reparsing macro syntax.

- A nullable argument is required: use `{ nickname: null }`, not `{}` or `{ nickname: undefined }`.
- A slice is type-expressible as an empty array, but descriptor construction synchronously rejects it with `QueryArgumentError` before D1 is called.
- Slice elements and BLOB inputs are snapshotted at descriptor construction, so later caller mutation cannot alter the descriptor.
- Embedded outer-join fields preserve each field's sqlc nullability. The containing public object is reconstructed rather than exposed as physical aliases.

## Declared SQLite types and TypeScript values

Type names are normalized without case, whitespace, or parenthesized size. Nullability adds `| null` where applicable.

| SQLite declared-type families        | Bind type                    | Row type and check                                      |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------- |
| integer families                     | `number`                     | safe-integer `number`                                   |
| real, numeric, decimal families      | `number`                     | finite `number`                                         |
| text, character, date, time families | `string`                     | `string`; no `Date` conversion or format promise        |
| boolean / bool                       | `boolean`                    | `boolean`, mapped only from physical integer `0` or `1` |
| BLOB                                 | `Uint8Array`                 | copied `Uint8Array`                                     |
| JSON / JSONB                         | checked `JsonValue`          | parsed `unknown`                                        |
| unknown declared type                | `D1NonNullValue` / `D1Value` | `unknown`                                               |

JSON arguments must be acyclic JSON values with finite numbers and plain string-keyed objects. They are serialized to text. Unknown bind types accept only the D1 value union, not arbitrary JavaScript objects.

## Naming and file grouping

- One `runtime.ts` is emitted per Plugin invocation.
- Queries from each SQL source file share a module. For example, `queries.sql` becomes `queries_sql.ts`; nested safe paths remain nested.
- PascalCase sqlc names produce camel-cased factories: `GetUser` becomes `getUser`.
- Generated argument and row declarations retain the query name: `GetUserArgs` and `GetUserRow`.
- Schema/query names must derive safe, unique, portable TypeScript declarations and output paths.

Generated files begin with a “do not edit” notice. Change input files and regenerate rather than patching output.

## Fail-closed boundaries

Generation stops instead of guessing when analyzed metadata cannot be translated safely. Important boundaries include:

- unsupported command, engine, or too-old sqlc version;
- missing/contradictory parameter or result metadata;
- bind numbers with gaps or an order D1 cannot reproduce;
- numbered placeholders mixed with an expanding slice;
- ambiguous slice markers or embedded projections;
- duplicate physical row keys without unique SQL aliases;
- unsafe/colliding output paths or TypeScript declarations.

A sqlc version newer than the tested ceiling is different: `[COMPATIBILITY/UNTESTED_SQLC_VERSION]` is a warning and generation continues unless another incompatibility exists. See [compatibility](compatibility.md) for the current floor and tested samples, [troubleshooting](troubleshooting.md) for corrections, and [runtime and errors](runtime-and-errors.md) for execution behavior.
