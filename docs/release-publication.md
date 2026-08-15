# Release publication operations

Publication turns one proven publication candidate into a published artifact. It runs only after every release gate has passed for that exact candidate, it writes the immutable R2 version key before it advertises anything, and it publishes the GitHub Release last.

Everything below is executed by `.github/workflows/release.yml`. Nothing here is a manual procedure except the one-time configuration and the audit.

## What publication does, in order

1. **Preflight** — read-only proof that the `sqlc` bucket is reachable, the R2 credential is scoped to that bucket alone, and the public custom domain answers for a known-absent key. It runs as its own job off the release identity, so a misconfigured account fails within a minute rather than after the full gate. Two checks report `not-verifiable` rather than passing: the immutable-releases setting and the Environment ref policy both need the Administration permission, which no job-scoped `GITHUB_TOKEN` can hold, so the manual audit below is what proves them.
2. **Draft release** — create or reuse a draft whose body is byte-identical to the body this run would publish, and attach the retained WASM and its release manifest.
3. **Draft verification** — download both assets again through the API and hash them.
4. **Version key** — `aws s3api put-object` with `--if-none-match '*'` and `--content-md5`. A `412` is accepted only after a full-byte comparison proves the existing object is this candidate.
5. **Direct verification** — `GetObject` from the S3 endpoint, hash the complete body, and assert `Content-Type`, `Content-Disposition`, `Cache-Control`, and the SHA-256 object metadata.
6. **Public verification** — fetch the public URL unauthenticated, exactly as a consumer does, and hash the body. A `404` is propagation and is polled; a `200` with different bytes is an immediate hard failure.
7. **Digest agreement** — one SHA-256 must equal the retained candidate, the release asset, the object metadata, the direct download, the public download, the manifest, and the digest quoted in the release body.
8. **Publish** — `draft: false`. This is the moment the version becomes publicly advertised, and it is the last write of the run.
9. **Record** — a closed JSON publication record is written as run evidence and uploaded as `release-publication-<run>-<attempt>`.

No API response, ETag, `Content-MD5` acknowledgement, or `HEAD` result ever satisfies verification on its own.

## GitHub Environment

Create a protected Environment named **`release-publication`** with selected deployment refs only:

- branch: `main`;
- tag: `v*`;
- no required reviewer;
- no wait timer.

The absence of a reviewer is deliberate: a validated release tag is release approval, and there is no second click. Because `release.yml` triggers only on tag push and manual dispatch, and both credentialed jobs sit behind this Environment, no pull request can reach these secrets.

Configure these identifiers (never commit their values):

- Environment secret `R2_ACCESS_KEY_ID`;
- Environment secret `R2_SECRET_ACCESS_KEY`;
- Environment variable `CLOUDFLARE_ACCOUNT_ID`, the same account that carries the `sqlc` bucket.

The ref rules are two separate kinds. `main` is a **branch** rule and `v*` is a **tag** rule; a `v*` rule created as a branch rule matches no tag, and every tag push is then refused the Environment.

GitHub credentials are the job-scoped `GITHUB_TOKEN` only. `contents: write` appears on the publish job and nowhere else; there is no PAT and no OIDC token.

Repository Actions artifact retention must permit at least 30 days.

## How R2 is reached

Uploads and read-backs go through the **AWS CLI** (`aws s3api`), which GitHub runners preinstall and which already speaks S3 conditional writes. `scripts/publish-release.mjs` is the only caller; credentials reach it through the child process environment, never through argv, so they cannot appear in a process listing or a log.

Two environment settings matter and are set automatically: `AWS_ENDPOINT_URL` points at the account's R2 S3 endpoint, and `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` stops aws-cli v2 adding the CRC32 checksum that R2 rejects. The integrity check that matters is the `Content-MD5` sent with the object.

The CLI version is not pinned; it is reported in the job log so a change is visible.

## R2 API token

Create an account-owned R2 API token, not one tied to a maintainer's user account, and grant only:

- Object Read & Write on the `sqlc` bucket.

Workers, D1, KV, Queues, and zone permissions are not required. The managed-D1 token is a separate credential and must never gain R2 permissions. Preflight fails closed if the token can see any bucket other than `sqlc`.

## One-time configuration

1. Enable immutable releases and confirm the setting:

   ```sh
   gh api -X PUT repos/mkuznets/sqlc-d1-typescript/immutable-releases
   gh api repos/mkuznets/sqlc-d1-typescript/immutable-releases
   ```

2. Create the `release-publication` Environment with the ref rules and both secrets above.
3. Create the bucket-scoped R2 API token and store its values only in that Environment.
4. Confirm Actions artifact retention supports at least 30 days.
5. Run the dry run below and confirm it leaves nothing behind.

## Controlled dry run

A dry run exercises the real GitHub and R2 accounts without creating a tag, without consuming a version key, and without publishing anything. It writes to a `rehearsal/<run-id>/` object key and a draft named `dry-run-v<version>-<run-id>`, a name that can never become a real tag, then deletes both.

```sh
gh workflow run release.yml --ref main -f version=0.0.0-dryrun1
```

Then:

1. Rerun with the same `version`; the new run id produces a fresh rehearsal key.
2. Rerun the publish job of the **first** run. It writes the same rehearsal key again from the retained candidate and reports `"outcome": "created"`, because teardown removed the previous attempt's object and draft before the run ended. What this proves is repeatability from retained bytes; it is not the conflict path. Neither the create-only conflict nor the draft-reuse path can be rehearsed at all — a dry run never leaves a surface behind for the next attempt to collide with — and `verification/publication-conflict` and `verification/publication-retry` own them instead.
3. Download `release-publication-<run>-<attempt>` and validate it, once per attempt:

   ```sh
   make validate-publication-record RECORD=publication-record.json
   ```

4. Confirm the record shows `"mode": "dry-run"`, `"published": false`, and a `teardown` in which both surfaces are `deleted`.
5. Confirm in Cloudflare that no `rehearsal/` object remains and that `plugins/` is untouched, and on GitHub that no release and no tag exist.

To check the account configuration by hand, with the credentials exported in the shell:

```sh
make publication-preflight REPOSITORY=mkuznets/sqlc-d1-typescript VERSION=0.0.0-audit
```

Preflight reads only; it writes nothing to GitHub or R2.

## Recovery playbook

The version key is the boundary. Before it exists the version is free; after it exists the version is permanently bound to those bytes, because the public URL is served with `Cache-Control: immutable` and may already be cached anywhere.

| Situation                                  | What to do                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Failure before the R2 key exists           | Nothing permanent happened. Delete the tag, fix the cause, and recreate the tag at the same version.                                                   |
| Failure after the key exists               | Rerun the same workflow run so it resumes with the retained candidate. Only those bytes may ever occupy that key; changed bytes require a new version. |
| Retained candidate lost before publication | Abandon the version. The candidate job refuses to rebuild on a rerun, and a rebuilt artifact is a different artifact.                                  |
| Existing key with identical bytes          | Idempotent retry. Publication continues.                                                                                                               |
| Existing key with different bytes          | Publication halts without writing. This is an immutable-key conflict; investigate before doing anything else.                                          |
| Draft asset differs from the candidate     | Publication halts before touching R2. Inspect the draft by hand; a draft may be deleted manually only while no version key exists.                     |
| Public download fails                      | The release stays a draft. Retry with the same bytes.                                                                                                  |
| After publication                          | Never replace or delete the tag, the release, the assets, or the object. Add a superseded notice to the release notes and publish a corrected version. |

Every failure emits one `::error::` annotation naming the phase, plus the recovery sentence that applies to the side of the boundary the run reached.

## Release notes

The maintainer writes the changelog in the annotated tag message; nothing generates it. The publish job reads `%(contents:body)` from the tag and renders it as the `## Changelog` section of the release body. A tag with no message body renders a commit-history link instead.

The rest of the body is derived from the release manifest and is deterministic: the same manifest and tag message always produce the same Markdown, which is why a retry can byte-compare an existing draft instead of rewriting it. The body may quote no SHA-256 other than the artifact's and the manifest's.

## Manual audit checklist

1. Confirm the Environment ref rules, the absence of a reviewer, and the secret identifiers above.
2. Confirm the R2 token grants Object Read & Write on `sqlc` only, and that it is account-owned.
3. Confirm `gh api repos/mkuznets/sqlc-d1-typescript/immutable-releases` reports `enabled: true`. This is the only proof there is: the same call from inside a workflow answers `403`, and preflight records it as `not-verifiable`.
4. Confirm repository artifact retention supports 30 days.
5. Run a dry run; download its record and validate it with `make validate-publication-record`.
6. Confirm the record's `order` ends with the publish phase, and that on a dry run there is no publish phase at all.
7. Confirm no `rehearsal/` object and no dry-run draft release survive.
8. Inspect logs, the record, and the preflight artifact for credentials, tokens, signatures, authorization headers, and response bodies. The record schema rejects those fields structurally; the audit confirms the logs agree.
9. Confirm the published release body quotes exactly the artifact digest and the manifest digest and no other.
