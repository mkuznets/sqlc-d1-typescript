# sqlc-d1-typescript

A sqlc code-generation Plugin that emits TypeScript executed through a Cloudflare Workers D1 binding.
`CONTEXT.md` fixes the vocabulary — Plugin, Workers binding interface, query descriptor, query executor,
session executor, session bookmark, compatibility surface, bind value, row mapping, release gate, publication
candidate, published artifact, version key, release record — and names the synonym each term replaces. Use its
terms.

Prettier owns formatting. Run `make fmt` before committing; `make fmt-check` gates CI.

## Task branches

- Changing the generator or the runtime shipped inside generated code — anything under `src/`:
  `docs/agents/generator-runtime.md`.
- Adding or moving a test, regenerating checked-in generated fixtures, running the local gate, reading a
  coverage or drift failure, or changing managed-D1 scenarios: `docs/agents/verification.md`.
- Preparing a release, changing `.github/workflows/release.yml`, or touching candidate identity, the release
  manifest, or the R2 publication contract: `docs/agents/release.md`.
- Editing anything under `.github/workflows/` or `scripts/workflows/`: `docs/agents/workflows.md`.

## Agent skills

### Issue tracker

Issues are tracked in this repository’s GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The tracker uses the default five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.
