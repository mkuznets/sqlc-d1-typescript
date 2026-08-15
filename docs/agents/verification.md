# Verification

The branch for adding or moving a test, regenerating checked-in generated fixtures, running the local gate,
reading a coverage or drift failure, and changing managed-D1 scenarios.

## One publication candidate, supplied everywhere

Every exact-candidate target takes `CANDIDATE_WASM` and `CANDIDATE_SHA256` as 64 lowercase hex characters, and
refuses to run without both. Pass the candidate path absolute: the sub-project targets run from their own
directories and resolve it there. `make verify-local` is the only target that builds a
candidate: it removes prior build output, builds once, and delegates to `make verify-candidate` with the
digest it computed. Everything downstream consumes those bytes.

Evidence binds to bytes. A rebuild partway through a gate invalidates every result already collected, because
the collected results then describe two artifacts rather than one. The focused targets are listed in the
`Makefile`.

## Layers and primary ownership

Seven layers, each answering a different question about the same candidate:

| Layer          | What it exercises                                                   |
| -------------- | ------------------------------------------------------------------- |
| `generator`    | Pure request-to-file behavior of the generator sources.             |
| `types`        | Public-only strict compilation on the floor and current TypeScript. |
| `candidate`    | The same generator scenarios executed through the real WASM.        |
| `verification` | Contracts over manifests, publication, scripts, and workflow text.  |
| `miniflare`    | Isolated D1 with fresh storage per test.                            |
| `example`      | The canonical Worker in `examples/d1-worker/`.                      |
| `managed-d1`   | Real D1 seams that only a live account can show.                    |

`verification/coverage-manifest.json` assigns every promised behavior exactly one **primary owner** and any
number of smoke tests; smoke tests are additional, never substitutes. Adding a behavior is three edits in one
change: register the id literally in the test title, add the entry to `test/catalog.ts`, add the same entry to
`verification/coverage-manifest.json`. A behavior that arrives in a new root test file adds two more: the file
joins `ROOT_TESTS` and its bundle joins `ROOT_DIST` in the `Makefile`, and the file joins `include` in
`test/tsconfig.json`. A coverage failure names the missing or duplicated owner — read it as "this behavior has
no owner", not as a schema complaint.

## Checked-in generated output and drift

`test/miniflare/src/` and `examples/d1-worker/src/` hold Plugin output. The hand-written
`test/miniflare/src/index.ts` and `examples/d1-worker/src/index.ts` are the only exceptions, and
`scripts/check-generated-drift.mjs` preserves them during regeneration. `.prettierignore`
lists the emitted files in those trees because `make test-generated-drift` compares them byte for byte; when
their content should change, regenerate them from the candidate.

`--mode mirror` regenerates into a temporary copy and leaves the worktree untouched. `--mode worktree`
regenerates in a detached `git worktree` at `HEAD` and asserts `git status --porcelain` is empty. Both write
the retained candidate to a `0400` temporary file and clean up unconditionally. Both need `sqlc` on `PATH`.

## Regenerating the fixtures

`scripts/generate-candidate.mjs` rewrites a copy of a fixture's sqlc configuration to point at the retained
candidate `file:` URL and its digest, runs `sqlc generate`, and removes both temporaries. This block is the
single source of the procedure:

```
make build
SHA=$(shasum -a 256 build/plugin.wasm | awk '{print $1}')
for dir in test/miniflare examples/d1-worker; do
  node scripts/generate-candidate.mjs --candidate "$PWD/build/plugin.wasm" --sha256 "$SHA" --config sqlc.yaml --cwd "$PWD/$dir"
done
```

## Sub-project formatting

`examples/d1-worker/` and `test/miniflare/` are bun sub-projects that keep their own Prettier configuration;
Prettier resolves configuration per file, so their hand-written sources stay tab-indented. Use bun inside those
directories.

## Compatibility configuration is authoritative

`verification/compatibility.json` is the only home for the sqlc samples and their rationale, the known
exceptions, the TypeScript floor and current versions, the exact Cloudflare baseline, and the exact tool
versions. `scripts/compatibility-config.mjs` reads it, `scripts/workflows/emit-compatibility-outputs.mjs` feeds
workflows from it, and `docs/compatibility.md` presents it to consumers. Change the JSON; every other copy is
derived.

**Decided, against the obvious default:** sqlc is sampled strategically — the floor, the tested ceiling, and
the intervening releases tied to a material protocol or metadata change. A matrix over every sqlc minor was
considered and rejected ([#13](https://github.com/mkuznets/sqlc-d1-typescript/issues/13),
[#38](https://github.com/mkuznets/sqlc-d1-typescript/issues/38)).

## Managed D1 creates real resources

Managed-D1 runs provision live Cloudflare resources under the reserved name grammar
`sqlc-d1-ci-yyyymmddthhmmssz-<run-id>-<attempt>-<8-lower-hex>` (`RESOURCE_NAME_PATTERN` in
`scripts/managed-d1-contract.mjs`). Exact resource identifiers are persisted the moment they exist, primary
cleanup runs unconditionally and reports separately from the test outcome, and **a cleanup failure is a failed
release gate even when emergency recovery succeeds**. The weekly reaper (`make reap-managed-d1`) deletes only
complete reserved names strictly older than 24 hours. Stateful scenarios run once; diagnose a failure rather
than retrying it.

Scenario ids are compiled in as `MANAGED_SCENARIO_IDS` in `scripts/managed-d1-contract.mjs`. The deployed
endpoint accepts those ids and returns scenario outcomes; SQL, bind values, and expected rows stay out of the
protocol in both directions. Operations, the protected Environment, token scopes, and the audit checklist live
in `docs/managed-d1-verification.md`.

## Publication is a verification layer too

The `verification` layer also owns the publication contracts: object keys and their permanent HTTP metadata,
the release body, the closed publication record, and the order in which surfaces may be written. Those rules
live in `scripts/publication-contract.mjs`; ordering and the version-key boundary live in
`scripts/publish-release.mjs`. Both are exercised without credentials and without touching the network — every
seam is an injected `fetchImpl` whose double throws on any request it was not primed for. Operations and the
audit checklist are in `docs/release-publication.md`.

## Sensitive data stays inside the run

`verification/evidence.schema.json`, `verification/managed-d1-evidence.schema.json`, and
`verification/publication-record.schema.json` are closed schemas (`additionalProperties: false`); keep them
closed, and add a field by naming it in the schema.

Evidence, logs, artifacts, and issues carry candidate identity, configuration, scenario outcomes, exact
resource identifiers, and cleanup facts. SQL text, bind values, result rows, session bookmarks, authorization
headers, tokens, Cloudflare credentials, stack traces, error causes, and response bodies stay in the run that
produced them. Secret identifiers and minimum permission scopes are documentable; their values live only in
the Environment.

## Running the gate

`make verify-local` runs the full local gate from a clean build. `make verify-candidate` runs it against bytes
someone else built, given `CANDIDATE_WASM` and `CANDIDATE_SHA256`. The focused targets each gate names are in
the `Makefile`.

## Decisions governing this area

Read the issue rather than re-deriving the decision:
[#13](https://github.com/mkuznets/sqlc-d1-typescript/issues/13) (verification strategy and disposable D1
lifecycle), [#17](https://github.com/mkuznets/sqlc-d1-typescript/issues/17) (release gate),
[#37](https://github.com/mkuznets/sqlc-d1-typescript/issues/37) (local coverage and the canonical Worker),
[#38](https://github.com/mkuznets/sqlc-d1-typescript/issues/38) (compatibility matrix and uncredentialed CI),
[#40](https://github.com/mkuznets/sqlc-d1-typescript/issues/40) (managed-D1 verification and evidence).

When the change lands in a workflow file, `docs/agents/workflows.md` carries the authoring rules.
