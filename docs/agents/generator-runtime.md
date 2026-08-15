# Generator and runtime

The branch for changing anything under `src/` — the Plugin itself and the runtime shipped inside generated
code.

## Source map

| File                           | Responsibility                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/app.ts`                   | Javy entry point: read stdin, write stdout and stderr, throw on failure.                                                     |
| `src/plugin.ts`                | Decode the generate request, run validation and generation, render diagnostics. The one place a failure becomes stderr text. |
| `src/validation.ts`            | Protocol, options, and query boundary validation. `SUPPORTED_COMMANDS` is the command surface.                               |
| `src/diagnostics.ts`           | `[CATEGORY/REASON]` identifiers, severity, and redaction of SQL and values.                                                  |
| `src/emission-plan.ts`         | Naming, collision avoidance, argument and row field plans, per-command result shapes.                                        |
| `src/embeds.ts`                | `sqlc.embed` reconstruction and private alias rewriting.                                                                     |
| `src/sqlite-types.ts`          | SQLite type family to TypeScript bind and row type mapping.                                                                  |
| `src/d1.ts`                    | The Workers `Driver`: runtime text, factory and parser emission, result context declaration.                                 |
| `src/generator.ts`             | Assembles file outputs from the emission plan; owns the `Driver` interface.                                                  |
| `src/runtime.d1.ts`            | The runtime shipped to consumers.                                                                                            |
| `src/runtime.ts`               | Build-time stub that `scripts/runtime-text-plugin.mjs` replaces with the runtime text.                                       |
| `src/gen/plugin/codegen_pb.ts` | Generated from the sqlc protobuf schema by its own `Makefile` rule; Prettier-ignored, never hand-edited.                     |

## The runtime is shipped text

Only the lines between `// --- RUNTIME BEGIN ---` and `// --- RUNTIME END ---` in `src/runtime.d1.ts` reach
consumers; `scripts/runtime-text-plugin.mjs` inlines them as a string literal at build time. Reformatting or
reindenting inside the markers changes the bytes every consumer receives, which is why the file is excluded
from the root `tsconfig.json` and compiled only through the generated fixtures. Follow any edit with a rebuild
and a fixture regeneration — `docs/agents/verification.md` owns that procedure.

## Public versus private surface

The public surface is what `test/types/consumer.ts` compiles against and what `docs/generated-code-tour.md`
shows. Query descriptor internals, row parsers, generated private aliases, and `generatedInternals` members
are private and may change freely. Changing the public surface changes the type fixtures, the consumer
documentation, and `verification/coverage-manifest.json` in the same change.

## Diagnostics are an identifier contract

The `[CATEGORY/REASON]` strings produced by `src/diagnostics.ts` are public and documented in
`docs/troubleshooting.md`. A diagnostic carries metadata locations — query name, column, position — and
describes the shape of what it rejected; SQL text and bind values stay out of it. Adding one means adding a
matching `diagnostic-*` promise to `verification/coverage-manifest.json`, which the surface inventory in
`test/verification-contracts.test.ts` asserts.

## Runtime error classes are a contract

- `QueryArgumentError` — the arguments failed validation and D1 was never called.
- `QueryUsageError` — a query descriptor or an executor was used in a way the API forbids.
- `QueryResultError` — D1 succeeded and row mapping failed.

Native D1 errors pass through unwrapped, so a consumer can recognize them. A `QueryResultError` raised after a
write means the write happened and the mapping failed; it is not evidence of a rollback.

## Fail closed at the compatibility surface

Metadata the Plugin cannot translate safely produces a diagnostic and stops generation with no partial tree,
rather than an approximated result shape or an unsafe cast. A consumer reads a hard failure at generation time
as an honest limit; an unsound type is discovered in production.

## Decisions governing this area

Read the issue rather than re-deriving the decision:
[#7](https://github.com/mkuznets/sqlc-d1-typescript/issues/7) (generated-code public model),
[#8](https://github.com/mkuznets/sqlc-d1-typescript/issues/8) (command and macro semantics),
[#9](https://github.com/mkuznets/sqlc-d1-typescript/issues/9) (type, value, and row-mapping semantics),
[#10](https://github.com/mkuznets/sqlc-d1-typescript/issues/10) (batching and sessions),
[#11](https://github.com/mkuznets/sqlc-d1-typescript/issues/11) (runtime error contract),
[#19](https://github.com/mkuznets/sqlc-d1-typescript/issues/19) (safe emission and naming),
[#20](https://github.com/mkuznets/sqlc-d1-typescript/issues/20) (boundary validation and diagnostics).

## Finishing

`docs/agents/verification.md` carries the primary owner rule for the behavior you changed, the regeneration
procedure for the checked-in fixtures, and the exact-candidate rule that governs the gate. `AGENTS.md` carries
the `make fmt` reminder that applies to every commit.
