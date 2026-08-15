# sqlc-d1-typescript

A sqlc code-generation plugin that emits TypeScript executed through a Cloudflare Workers D1 binding.

Prettier owns formatting. Run `make fmt` before committing; `make fmt-check` gates CI.

Everything in `scripts/` is TypeScript run directly by Node (`node scripts/foo.ts`) — Node strips the types, so those files must stay within erasable syntax (no `enum`, no `namespace`, no constructor parameter properties) and must use explicit `.ts` extensions on relative imports. The same applies to `src/` and `test/`, because the tests run those sources directly. `scripts/workflows/pins.mjs` is the one exception: it chooses the Node version, so it runs before the toolchain is pinned and must stay plain JavaScript.

## The generator and the shipped runtime (`src/`)

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
| `src/runtime.ts`               | **Generated and gitignored.** `scripts/extract-runtime.ts` writes the shipped runtime here as a string literal.              |
| `src/gen/plugin/codegen_pb.ts` | Generated from the sqlc protobuf schema by its own `Makefile` rule; Prettier-ignored, never hand-edited.                     |

**The runtime is shipped text.** Only the lines between `// --- RUNTIME BEGIN ---` and `// --- RUNTIME END ---` in `src/runtime.d1.ts` reach consumers. Reformatting or reindenting inside the markers changes the bytes every consumer receives, which is why the file is excluded from the root `tsconfig.json` and compiled only through the generated fixtures. The Makefile regenerates `src/runtime.ts` whenever `src/runtime.d1.ts` changes, so the wasm build and the tests always see identical bytes; follow any edit with a fixture regeneration.

**Public versus private surface.** The public surface is what `test/types/consumer.ts` compiles against and what `docs/generated-code-tour.md` shows. Query descriptor internals, row parsers, generated private aliases, and `generatedInternals` members are private and may change freely.

**Diagnostics are an identifier contract.** The `[CATEGORY/REASON]` strings produced by `src/diagnostics.ts` are public and documented in `docs/troubleshooting.md`. A diagnostic carries metadata locations — query name, column, position — and describes the shape of what it rejected; SQL text and bind values stay out of it.

**Runtime error classes are a contract.**

- `QueryArgumentError` — the arguments failed validation and D1 was never called.
- `QueryUsageError` — a query descriptor or an executor was used in a way the API forbids.
- `QueryResultError` — D1 succeeded and row mapping failed.

Native D1 errors pass through unwrapped, so a consumer can recognize them. A `QueryResultError` raised after a write means the write happened and the mapping failed; it is not evidence of a rollback.

**Fail closed at the compatibility surface.** Metadata the plugin cannot translate safely produces a diagnostic and stops generation with no partial tree, rather than an approximated result shape or an unsafe cast.

## Verification

`make verify-local` builds the plugin once and runs everything that needs no credentials. The layers each answer a different question about the same build:

| Target                | Question                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `make test-unit`      | Pure request-to-file generator behaviour, plus the script contracts.                                       |
| `make test-candidate` | The same scenarios through the real wasm, and the public type surface on the floor and current TypeScript. |
| `make test-drift`     | Does the committed generated output still match what the plugin emits?                                     |
| `make test-miniflare` | Real workerd and D1 storage, fresh per test.                                                               |
| `make test-example`   | The canonical Worker still builds and passes.                                                              |

Tests run straight from TypeScript (`node --test`), and the unit target globs `test/*.test.ts test/generator/*.test.ts` — adding a test file needs no list edited anywhere.

Targets that need the plugin default to `build/plugin.wasm`; pass `CANDIDATE=/path/to/plugin.wasm` to point them at another build.

**Checked-in generated output and drift.** `test/miniflare/src/` and `examples/d1-worker/src/` hold plugin output. The hand-written `index.ts` in each is the only exception, and `scripts/check-generated-drift.ts` preserves them during regeneration. `.prettierignore` lists the emitted files because `make test-drift` compares them byte for byte. Drift regenerates into a throwaway copy, so it never touches the working tree; it needs `sqlc` on `PATH`.

**Regenerating the fixtures:**

```sh
make build
for dir in test/miniflare examples/d1-worker; do
  node scripts/generate-candidate.ts --candidate "$PWD/build/plugin.wasm" --config sqlc.yaml --cwd "$PWD/$dir"
done
```

**Sub-project formatting.** `examples/d1-worker/` and `test/miniflare/` are bun sub-projects that keep their own Prettier configuration; Prettier resolves configuration per file, so their hand-written sources stay tab-indented. Use bun inside those directories.

**Compatibility configuration.** `verification/compatibility.json` pins the sqlc samples and their rationale, the known exceptions, the TypeScript floor and current versions, and the Node/npm/Bun versions CI installs. It holds only what is not already recorded elsewhere — the Cloudflare versions live in the fixtures' `bun.lock` and `wrangler.jsonc`, and the buf and javy pins live in their install scripts. `scripts/workflows/pins.mjs` feeds the workflows from it and `docs/compatibility.md` presents it to consumers.

**Decided, against the obvious default:** sqlc is sampled strategically — the floor, the tested ceiling, and the intervening releases tied to a material protocol or metadata change. A matrix over every sqlc minor was considered and rejected ([#13](https://github.com/mkuznets/sqlc-d1-typescript/issues/13), [#38](https://github.com/mkuznets/sqlc-d1-typescript/issues/38)).

## Release

`.github/workflows/release.yml` validates the release identity, builds the plugin once, runs the same gates CI runs, then publishes.

**A valid tag is the approval.** A strict SemVer `v*` tag on default-branch lineage is the maintainer's release approval, and it is the only one. There is no dry-run mode: to rehearse a release, cut the next patch version.

**Publication order is the safety property.** R2 first, then the public origin is re-downloaded and compared, then the GitHub Release is cut — the release notes may only advertise a URL that already serves the right bytes. The R2 write uses `--if-none-match '*'`, so a version key can never be replaced once published. `contents: write` appears on the `publish` job and nowhere else, and `test/verification-contracts.test.ts` holds the workflow to that. Operations live in `docs/release-publication.md`.

**Canonical names.** `sqlc-gen-d1-typescript_<version>.wasm` and `sqlc-gen-d1-typescript_<version>.manifest.json`, with no aliases. The URL shape and the manifest contract live in `scripts/release.ts`.

## GitHub Actions workflows

Two workflows, `ci.yml` and `release.yml`, sharing `.github/actions/setup` for the toolchain. A `run:` block holds plain bash: a handful of commands and invocations of scripts. Pass workflow values in through `env:` rather than interpolating `${{ }}` into the middle of a script.

## Consumer skill

`skills/sqlc-d1-typescript/` is the one thing here that leaves the repository and runs in a consumer's workspace. It promises one run, from a fresh consumer workspace to verified local behaviour: bind to one release, write the sqlc configuration, generate, wire the Workers binding interface, typecheck, and pass one focused local D1 test. Then it reports and stops. Deployment, remote bindings, live D1 resources, and every Cloudflare credential are outside that promise and stay outside it.

The skill ships inside the tagged tree, so its guidance describes the version of the tag it was cloned from. No version fact belongs in `SKILL.md` or its `reference/` files — they are fetched from the release record and from tag-pinned `docs/`.

## Issues

Issues live in this repository's GitHub Issues; use the `gh` CLI. Triage labels are `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`.

Decisions worth reading before re-deriving them:
[#7](https://github.com/mkuznets/sqlc-d1-typescript/issues/7) (generated-code public model),
[#8](https://github.com/mkuznets/sqlc-d1-typescript/issues/8) (command and macro semantics),
[#9](https://github.com/mkuznets/sqlc-d1-typescript/issues/9) (type, value, and row-mapping semantics),
[#10](https://github.com/mkuznets/sqlc-d1-typescript/issues/10) (batching and sessions),
[#11](https://github.com/mkuznets/sqlc-d1-typescript/issues/11) (runtime error contract),
[#19](https://github.com/mkuznets/sqlc-d1-typescript/issues/19) (safe emission and naming),
[#20](https://github.com/mkuznets/sqlc-d1-typescript/issues/20) (boundary validation and diagnostics).
