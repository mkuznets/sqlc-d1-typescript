# Release

The branch for preparing a release, changing the release spine, and touching candidate identity, the release
manifest, or the R2 publication contract.

## What the spine does today

`.github/workflows/release.yml` validates release intent, builds or reuses one publication candidate, runs the
uncredentialed gates, calls managed-D1 verification through `.github/workflows/_managed-d1.yml`, assembles the
release manifest, and then publishes.

Publication is one process, `scripts/publish-release.mjs`, and its order is the safety property: draft release,
assets, create-only R2 write, independent downloads of every surface, and the GitHub Release published last.
Nothing else in the workflow writes anywhere; `contents: write` appears on the `publish` job and nowhere else,
and `test/verification-contracts.test.ts` holds the workflow to that. Operations, the protected Environment,
token scopes, the dry-run procedure, and the recovery playbook live in `docs/release-publication.md`.

The workflow still creates no tag. A dry run rehearses the whole path against the real accounts using a
rehearsal object key and a draft name that can never become a tag, then deletes both.

## A valid tag is the approval

A strict SemVer `v*` tag on default-branch lineage is the maintainer's release approval, and it is the only
one. **Decided, against the obvious default:** an additional required-reviewer click was considered and
rejected; the `managed-d1` Environment is protected by ref and tag restrictions with no reviewer and no wait
timer ([#17](https://github.com/mkuznets/sqlc-d1-typescript/issues/17),
[#40](https://github.com/mkuznets/sqlc-d1-typescript/issues/40)). Keep the path from tag to evidence
click-free.

## One candidate per run

The `candidate` job builds exactly once per workflow run and retains the bytes as
`publication-candidate-<run_id>`. A rerun (`github.run_attempt` above one) reuses those bytes by numeric
artifact id, and the reuse path is asserted to contain no build step. Every downstream job, the credentialed
managed-D1 job included, downloads by artifact id and verifies the full SHA-256 before use.

An infrastructure failure is rerun against the retained candidate inside the same run. Evidence from one run
describes one artifact, so a pass is assembled from a single run's evidence.

## Canonical names

`sqlc-gen-d1-typescript_<version>.wasm` and `sqlc-gen-d1-typescript_<version>.manifest.json`, with no aliases:
`test/verification-contracts.test.ts` asserts the earlier generic name, release-manifest.json, appears nowhere
in the workflow. The permanent artifact URL shape and the manifest contract live in
`scripts/release-contract.mjs` and `verification/release-manifest.schema.json`.

## The permanent version-key boundary

Before the R2 version key for a version exists, that version is still free: a failed tag may be deleted and
recreated at the same version after fixing source, workflow, or configuration.

Once the key exists, the version is permanently bound to those bytes, because the public URL may already be
cached anywhere. A later retry re-uploads the exact retained bytes; any change to the artifact requires a new
version. Publication is create-only (`If-None-Match: *`), and a `412` on an existing key is acceptable only
after verifying full-byte identity.

This is live behavior, not a plan. `scripts/publish-release.mjs` writes the key, then proves the artifact by
downloading it from the S3 endpoint and again from the public URL unauthenticated, and only then publishes.
Every failure names the phase and the recovery that applies to the side of the boundary it reached.

**Decided, against the obvious default:** burning the version on any failed tag was considered and rejected
([#16](https://github.com/mkuznets/sqlc-d1-typescript/issues/16),
[#17](https://github.com/mkuznets/sqlc-d1-typescript/issues/17),
[#44](https://github.com/mkuznets/sqlc-d1-typescript/issues/44)).

## Agents prepare; the maintainer tags

Prepare the change, run the gates that need no credentials, state precisely what remains, and hand the tag
decision to the maintainer. Tag creation, tag movement, tag deletion, GitHub Releases, and publication
workflows are the maintainer's to run.

## Credentials

Secret identifiers and minimum permission scopes are documented in `docs/managed-d1-verification.md` and
`docs/release-publication.md`. Their values live only in the protected Environments.

## Decisions governing this area

Read the issue rather than re-deriving the decision:
[#16](https://github.com/mkuznets/sqlc-d1-typescript/issues/16) (immutable R2 release contract),
[#17](https://github.com/mkuznets/sqlc-d1-typescript/issues/17) (release gate),
[#39](https://github.com/mkuznets/sqlc-d1-typescript/issues/39) (exact-artifact release spine),
[#44](https://github.com/mkuznets/sqlc-d1-typescript/issues/44) (immutable GitHub and R2 publication).

The gate the spine runs is described in `docs/agents/verification.md`; when the change lands in a workflow
file, `docs/agents/workflows.md` carries the authoring rules.
