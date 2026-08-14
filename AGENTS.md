## Agent skills

### Issue tracker

Issues are tracked in this repository’s GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The tracker uses the default five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

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
