# sqlc-d1-typescript

A sqlc code-generation plugin that emits TypeScript executed through a Cloudflare Workers D1 binding.

Prettier owns formatting. Run `make fmt` before committing; `make fmt-check` gates CI.

Everything in `scripts/` is TypeScript run directly by Node (`node scripts/foo.ts`) — Node 24 strips the
types, so those files must stay within erasable syntax and must not use APIs newer than the `lib` in
`tsconfig.json`. `scripts/tsconfig.json` enforces both.

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
| `src/runtime.ts`               | Build-time stub that `scripts/runtime-text-plugin.ts` replaces with the runtime text.                                        |
| `src/gen/plugin/codegen_pb.ts` | Generated from the sqlc protobuf schema by its own `Makefile` rule; Prettier-ignored, never hand-edited.                     |

**The runtime is shipped text.** Only the lines between `// --- RUNTIME BEGIN ---` and `// --- RUNTIME END ---`
in `src/runtime.d1.ts` reach consumers; `scripts/runtime-text-plugin.ts` inlines them as a string literal at
build time. Reformatting or reindenting inside the markers changes the bytes every consumer receives, which is
why the file is excluded from the root `tsconfig.json` and compiled only through the generated fixtures. Follow
any edit with a rebuild and a fixture regeneration.

**Public versus private surface.** The public surface is what `test/types/consumer.ts` compiles against and
what `docs/generated-code-tour.md` shows. Query descriptor internals, row parsers, generated private aliases,
and `generatedInternals` members are private and may change freely.

**Diagnostics are an identifier contract.** The `[CATEGORY/REASON]` strings produced by `src/diagnostics.ts`
are public and documented in `docs/troubleshooting.md`. A diagnostic carries metadata locations — query name,
column, position — and describes the shape of what it rejected; SQL text and bind values stay out of it.

**Runtime error classes are a contract.**

- `QueryArgumentError` — the arguments failed validation and D1 was never called.
- `QueryUsageError` — a query descriptor or an executor was used in a way the API forbids.
- `QueryResultError` — D1 succeeded and row mapping failed.

Native D1 errors pass through unwrapped, so a consumer can recognize them. A `QueryResultError` raised after a
write means the write happened and the mapping failed; it is not evidence of a rollback.

**Fail closed at the compatibility surface.** Metadata the plugin cannot translate safely produces a diagnostic
and stops generation with no partial tree, rather than an approximated result shape or an unsafe cast.

## Verification

**One publication candidate, supplied everywhere.** Every exact-candidate target takes `CANDIDATE_WASM` and
`CANDIDATE_SHA256` as 64 lowercase hex characters, and refuses to run without both. Pass the candidate path
absolute: the sub-project targets run from their own directories and resolve it there. `make verify-local` is
the only target that builds a candidate: it removes prior build output, builds once, and delegates to
`make verify-candidate` with the digest it computed.

Evidence binds to bytes. A rebuild partway through a gate invalidates every result already collected, because
the collected results then describe two artifacts rather than one.

The layers, each answering a different question about the same candidate: `generator` (pure request-to-file
behavior), `types` (public-only strict compilation on the floor and current TypeScript), `candidate` (the same
generator scenarios through the real WASM), `verification` (contracts over manifests, scripts, and workflow
text), `miniflare` (isolated D1 with fresh storage per test), `example` (the canonical Worker), and
`managed-d1` (real D1 seams only a live account can show).

Adding a root test file means adding it to `ROOT_TESTS` and its bundle to `ROOT_DIST` in the `Makefile`, and to
`include` in `test/tsconfig.json`.

**Checked-in generated output and drift.** `test/miniflare/src/` and `examples/d1-worker/src/` hold plugin
output. The hand-written `index.ts` in each is the only exception, and `scripts/check-generated-drift.ts`
preserves them during regeneration. `.prettierignore` lists the emitted files because `make
test-generated-drift` compares them byte for byte.

`--mode mirror` regenerates into a temporary copy and leaves the worktree untouched. `--mode worktree`
regenerates in a detached `git worktree` at `HEAD` and asserts `git status --porcelain` is empty. Both write
the retained candidate to a `0400` temporary file and clean up unconditionally. Both need `sqlc` on `PATH`.

**Regenerating the fixtures:**

```
make build
SHA=$(shasum -a 256 build/plugin.wasm | awk '{print $1}')
for dir in test/miniflare examples/d1-worker; do
  node scripts/generate-candidate.ts --candidate "$PWD/build/plugin.wasm" --sha256 "$SHA" --config sqlc.yaml --cwd "$PWD/$dir"
done
```

**Sub-project formatting.** `examples/d1-worker/` and `test/miniflare/` are bun sub-projects that keep their
own Prettier configuration; Prettier resolves configuration per file, so their hand-written sources stay
tab-indented. Use bun inside those directories.

**Compatibility configuration is authoritative.** `verification/compatibility.json` is the only home for the
sqlc samples and their rationale, the known exceptions, the TypeScript floor and current versions, the exact
Cloudflare baseline, and the exact tool versions. `scripts/compatibility-config.ts` reads it,
`scripts/workflows/emit-compatibility-outputs.ts` feeds workflows from it, and `docs/compatibility.md`
presents it to consumers. Change the JSON; every other copy is derived.

**Decided, against the obvious default:** sqlc is sampled strategically — the floor, the tested ceiling, and
the intervening releases tied to a material protocol or metadata change. A matrix over every sqlc minor was
considered and rejected ([#13](https://github.com/mkuznets/sqlc-d1-typescript/issues/13),
[#38](https://github.com/mkuznets/sqlc-d1-typescript/issues/38)).

## Managed D1 creates real resources

Managed-D1 runs provision live Cloudflare resources under the reserved name grammar
`sqlc-d1-ci-yyyymmddthhmmssz-<run-id>-<attempt>-<8-lower-hex>` (`RESOURCE_NAME_PATTERN` in
`scripts/managed-d1-contract.ts`). Exact resource identifiers are persisted the moment they exist, primary
cleanup runs unconditionally and reports separately from the test outcome, and **a cleanup failure is a failed
release gate even when emergency recovery succeeds**. The weekly reaper (`make reap-managed-d1`) deletes only
complete reserved names strictly older than 24 hours. Stateful scenarios run once; diagnose a failure rather
than retrying it.

Scenario ids are compiled in as `MANAGED_SCENARIO_IDS` in `scripts/managed-d1-contract.ts`. The deployed
endpoint accepts those ids and returns scenario outcomes; SQL, bind values, and expected rows stay out of the
protocol in both directions. Operations, the protected Environment, token scopes, and the audit checklist live
in `docs/managed-d1-verification.md`.

## Sensitive data stays inside the run

Evidence, logs, artifacts, and issues carry candidate identity, configuration, scenario outcomes, exact
resource identifiers, and cleanup facts. SQL text, bind values, result rows, session bookmarks, authorization
headers, tokens, Cloudflare credentials, stack traces, error causes, and response bodies stay in the run that
produced them. `inspectKeys` in `scripts/managed-d1-contract.ts` enforces this for managed evidence by
rejecting any key outside its allow-list. Secret identifiers and minimum permission scopes are documentable;
their values live only in the Environment.

## Release

`.github/workflows/release.yml` validates release intent, builds one publication candidate, runs the
uncredentialed gates, calls managed-D1 verification through `.github/workflows/_managed-d1.yml`, assembles the
release manifest, and then publishes.

**A valid tag is the approval.** A strict SemVer `v*` tag on default-branch lineage is the maintainer's release
approval, and it is the only one. There is no dry-run mode: to rehearse a release, cut the next patch version.
**Decided, against the obvious default:** an additional required-reviewer click was considered and rejected;
the `managed-d1` Environment is protected by ref and tag restrictions with no reviewer and no wait timer
([#17](https://github.com/mkuznets/sqlc-d1-typescript/issues/17),
[#40](https://github.com/mkuznets/sqlc-d1-typescript/issues/40)).

**One candidate per run.** The `candidate` job builds exactly once per run and retains the bytes as
`publication-candidate-<run_id>`. Every downstream job, the credentialed managed-D1 job included, downloads by
artifact id and verifies the full SHA-256 before use. Evidence from one run describes one artifact, so a pass
is assembled from a single run's evidence.

**Publication order is the safety property.** R2 first, then the public origin is re-downloaded and compared to
the candidate, then the GitHub Release is cut — the release notes may only advertise a URL that already serves
the right bytes. The R2 write uses `--if-none-match '*'`, so a version key can never be replaced once
published. `contents: write` appears on the `publish` job and nowhere else, and
`test/verification-contracts.test.ts` holds the workflow to that. Operations live in
`docs/release-publication.md`.

**Canonical names.** `sqlc-gen-d1-typescript_<version>.wasm` and
`sqlc-gen-d1-typescript_<version>.manifest.json`, with no aliases. The permanent artifact URL shape and the
manifest contract live in `scripts/release-contract.ts`.

## GitHub Actions workflows

A `run:` block holds plain bash: a handful of commands, `test` and `echo` guards, and invocations of scripts.
Anything beyond a few lines of bash goes into a file under `scripts/workflows/` that the workflow calls. Pass
workflow values in through `env:` rather than interpolating `${{ }}` into the middle of a script. Shared
helpers live in `scripts/workflows/lib.sh` for bash (`log`, `detail`, `warn`, `fail`) and
`scripts/workflows/step.ts` for TypeScript (`fail`, `flagValue`, `writeStepOutputs`).

Every job and step carries a `name:` that says what it does, announces what it is about to do and what it
observed, and fails with a `::error::` annotation that says what failed **and what that means**. A bare
`test a = b` guard that fails silently leaves the reader with an exit code and nothing else.

The scripts the `intent` job runs execute before any job has run `npm ci`, so they must import only `node:`
builtins and each other. `test/verification-contracts.test.ts` walks that import graph and enforces it.

## Consumer skill

`skills/sqlc-d1-typescript/` is the one thing here that leaves the repository and runs in a consumer's
workspace. It promises one run, from a fresh consumer workspace to verified local behavior: bind to one
release, write the sqlc configuration, generate, wire the Workers binding interface, typecheck, and pass one
focused local D1 test. Then it reports and stops. Deployment, remote bindings, live D1 resources, and every
Cloudflare credential are outside that promise and stay outside it.

The skill ships inside the tagged tree. The install command in `README.md` clones the tag and writes it into
`INSTALLED_TAG` in the consumer's workspace; step 1 of the skill reads that stamp, compares it to the version
in the consumer's sqlc configuration, and stops on a mismatch. No version fact belongs in `SKILL.md` or its
`reference/` files — they are fetched from the release record and from tag-pinned `docs/`.

**Decided, against the obvious default:** a committed `VERSION` file under `skills/` was rejected — this
repository publishes nothing at tag time, so it would need a hand bump before every tag and would be wrong on
the default branch between releases ([#43](https://github.com/mkuznets/sqlc-d1-typescript/issues/43)).

## Issues

Issues live in this repository's GitHub Issues; use the `gh` CLI. Triage labels are `needs-triage`,
`needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`.

Decisions worth reading before re-deriving them:
[#7](https://github.com/mkuznets/sqlc-d1-typescript/issues/7) (generated-code public model),
[#8](https://github.com/mkuznets/sqlc-d1-typescript/issues/8) (command and macro semantics),
[#9](https://github.com/mkuznets/sqlc-d1-typescript/issues/9) (type, value, and row-mapping semantics),
[#10](https://github.com/mkuznets/sqlc-d1-typescript/issues/10) (batching and sessions),
[#11](https://github.com/mkuznets/sqlc-d1-typescript/issues/11) (runtime error contract),
[#13](https://github.com/mkuznets/sqlc-d1-typescript/issues/13) (verification strategy),
[#17](https://github.com/mkuznets/sqlc-d1-typescript/issues/17) (release gate),
[#19](https://github.com/mkuznets/sqlc-d1-typescript/issues/19) (safe emission and naming),
[#20](https://github.com/mkuznets/sqlc-d1-typescript/issues/20) (boundary validation and diagnostics),
[#40](https://github.com/mkuznets/sqlc-d1-typescript/issues/40) (managed-D1 verification and evidence).
