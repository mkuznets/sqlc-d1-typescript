# Consumer skill

The branch for changing the consumer skill under `skills/sqlc-d1-typescript/` or the installation guidance in
`README.md`.

Everything else under `docs/agents/` addresses an agent changing **this** repository. This one document
addresses an agent changing what a **consumer's** agent reads: the skill is the only material here that leaves
the repository and runs somewhere else.

## What the skill promises

One run, from a fresh consumer workspace to verified local behavior: bind to one release, write the sqlc
configuration, generate, wire the Workers binding interface, typecheck, and pass one focused local D1 test.
Then it reports and stops.

The stopping point is the promise. Deployment, remote bindings, live D1 resources, and every Cloudflare
credential are outside it, and stay outside it. Nothing the skill drives needs an account.

## Tag-matched installation

A valid SemVer `v*` tag on default-branch lineage is the maintainer's release approval, so the tag that
authorizes a version is also the object a consumer can install the skill from. The skill ships inside the
tagged tree and adds no publication object: the contract stays one WASM artifact and one release manifest per
version, at the canonical filenames `scripts/release-contract.mjs` fixes.

The install command in `README.md` clones the tag and writes the tag it cloned into `INSTALLED_TAG` in the
consumer's workspace. Step 1 of the skill reads that stamp, compares it to the version in the consumer's sqlc
configuration, and stops on a mismatch.

**Decided, against the obvious default:** a committed `VERSION` file under `skills/` was rejected — this
repository publishes nothing at tag time, so such a file would need a hand bump before every tag and would be
wrong on the default branch between releases. Asking the human which tag they installed was rejected too: it
is unverifiable, and it pushes a correctness check onto the one party with no way to answer it. The install
command is the only moment the tag is known for certain, so the install command writes it.
`test/consumer-skill.test.ts` asserts the repository ships no `INSTALLED_TAG` of its own, so a stale stamp can
never reach a consumer.

## Three tiers, and what may live in each

| Tier                                      | Owns                                                           |
| ----------------------------------------- | -------------------------------------------------------------- |
| `skills/sqlc-d1-typescript/SKILL.md`      | The ordered process, completion criteria, fail-closed rules.   |
| `skills/sqlc-d1-typescript/reference/`    | Branch-conditional detail: failure routing, local test wiring. |
| Tag-pinned `docs/` and the release record | Every version-specific fact.                                   |

No version fact belongs in the first two tiers. The supported sqlc range, the TypeScript evidence, the exact
Cloudflare baseline, the artifact digest, and the compatibility surface are fetched from the release record and
from the human documentation pinned to the installed tag's `blob` URLs, never copied down. A skill file
containing a `MAJOR.MINOR` literal fails the gate, exactly as a maintainer guidance file does.

Reference files are disclosed, not inlined, because they are genuine branches: most runs never hit a
diagnostic, and a project that already tests its Worker never opens the local-test wiring.

## What the gate enforces

`test/consumer-skill.test.ts` is static, candidate-free, and runs inside `make test-generator`. It reads its
expectations out of source rather than restating them, so changing the Plugin fails the skill's gate instead of
silently invalidating the skill:

- diagnostic phases against `DiagnosticCategory` in `src/diagnostics.ts`, all of them covered;
- runtime error classes and the safe context fields against the shipped runtime in `src/runtime.d1.ts`;
- the install command the skill quotes at its mismatch stop against the one in `README.md`, line for line;
- the option surface against `src/validation.ts` — `interface: workers` and nothing else;
- snippet imports and SQL against the canonical Worker in `examples/d1-worker/`;
- the artifact URL, the manifest filename, and the digest shape against `scripts/release-contract.mjs` and
  `verification/release-manifest.schema.json`;
- every repository link pinned to the installed tag and resolving to a path that exists today;
- the vocabulary fixed by `CONTEXT.md`;
- no version literal, no credential, no deployment, no runtime interface other than the Workers binding
  interface.

Adding a file under `skills/sqlc-d1-typescript/` requires a pointer to it from another skill file; the gate
rejects orphans.

## Validating a change to the skill

The gate is static. Before shipping a change to the skill's procedure, run it end to end from a workspace
outside this repository, against a locally built candidate:

```
make build
SHA=$(shasum -a 256 build/plugin.wasm | awk '{print $1}')
WORK=$(mktemp -d)
mkdir -p "$WORK/.claude/skills"
cp -R skills/sqlc-d1-typescript "$WORK/.claude/skills/"
printf 'v0-validation\n' >"$WORK/.claude/skills/sqlc-d1-typescript/INSTALLED_TAG"
```

Then follow `skills/sqlc-d1-typescript/SKILL.md` inside `$WORK` with two maintainer-side substitutions, neither
of them part of the shipped guidance: step 1's release record becomes the retained candidate (`url:` a `file:`
URL for the built WASM, `sha256:` the digest above, version-match satisfied by the stamp), and the
version-specific facts step 1 would read from the release record come from the working tree's
`docs/compatibility.md`. Everything from step 2 onward runs unmodified. Use the canonical schema and queries
from `examples/d1-worker/` so the generated output can be compared with the checked-in canonical tree — the
same `file:` URL substitution `scripts/generate-candidate.mjs` performs for fixtures.

Exercise both fail-closed paths in the same run: a mismatched `INSTALLED_TAG`, and an input the Plugin refuses.
Each must stop and report rather than degrade.

No published artifact exists until [#44](https://github.com/mkuznets/sqlc-d1-typescript/issues/44) lands, so
the skill's HTTPS path to a release record cannot be exercised before the first tag. That is an accepted
assumption of the design, not an oversight.

## Decisions governing this area

Read the issue rather than re-deriving the decision:
[#15](https://github.com/mkuznets/sqlc-d1-typescript/issues/15) (repository-agent guidance and the consumer
skill boundary), [#16](https://github.com/mkuznets/sqlc-d1-typescript/issues/16) (the immutable release
contract), [#43](https://github.com/mkuznets/sqlc-d1-typescript/issues/43) (the tag-matched consumer skill).

When the change also touches a test registration, `docs/agents/verification.md` carries the coverage rules.
