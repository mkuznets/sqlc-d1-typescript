## Agent skills

### Issue tracker

Issues are tracked in this repository’s GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The tracker uses the default five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

### GitHub Actions workflows

Two rules govern everything under `.github/workflows/`:

**No scripts inside workflow files — bash only.** A `run:` block may contain plain bash: a handful of
commands, `test`/`echo` guards, and invocations of scripts. It must never contain a `node -e '…'` one-liner,
a `node - <<'NODE'` heredoc, an inline Python/JS program, or a long procedure. Anything beyond a few lines of
bash goes into a file under `scripts/workflows/` and the workflow calls it. Pass workflow values in through
`env:` rather than interpolating `${{ }}` into the middle of a script. Shared helpers live in
`scripts/workflows/lib.sh` (`log`, `detail`, `warn`, `fail`).

**Every workflow must log what is going on, including every meaningful failure.** Concretely:

- Every job and every step carries a `name:` that says what it does.
- Each step announces what it is about to do and what it observed — versions installed, digests compared,
  artifacts selected, which branch of a reuse/create decision was taken and why.
- Every failure exits with a message that says what failed **and what that means**, emitted as a
  `::error::` annotation (use `fail` from `lib.sh`) so it shows up on the run summary. A bare
  `test a = b` or `[[ … ]]` that fails silently is not acceptable.
- Guards that check for a missing secret, variable, tool, or file report which one is missing and which
  setup step should have provided it.

Contract tests in `test/verification-contracts.test.ts` and `test/compatibility-scripts.test.ts` assert on
workflow text. When logic moves from a workflow into `scripts/workflows/`, move the corresponding assertion
with it instead of deleting it.

### Formatting

Prettier owns formatting. Run `make fmt` before committing; `make fmt-check` gates CI.

The root `.prettierrc.json` applies to `src/`, `scripts/`, `test/`, docs, and workflows. The bun sub-projects
(`examples/d1-worker`, `test/miniflare`) keep their own `.prettierrc` — Prettier resolves config per file, so
their hand-written sources stay tab-indented.

`.prettierignore` lists what must not be reformatted, chiefly plugin-emitted files that
`make test-generated-drift` compares byte for byte. Reformatting those makes drift fail; regenerate instead.

`src/runtime.d1.ts` is a special case: everything between its `// --- RUNTIME BEGIN ---` and
`// --- RUNTIME END ---` markers is embedded verbatim into the runtime shipped to users, so reformatting it
changes generated output. After editing it, rebuild and regenerate both fixtures:

```
make build
SHA=$(shasum -a 256 build/plugin.wasm | awk '{print $1}')
for dir in test/miniflare examples/d1-worker; do
  node scripts/generate-candidate.mjs --candidate "$PWD/build/plugin.wasm" --sha256 "$SHA" --config sqlc.yaml --cwd "$PWD/$dir"
done
```
