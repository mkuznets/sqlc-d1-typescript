# Release publication operations

Publication turns one proven publication candidate into a published artifact. It runs only after every release gate has passed for that exact candidate, it writes the immutable R2 version key before it advertises anything, and it publishes the GitHub Release last.

Everything below is executed by the `publish` job in `.github/workflows/release.yml`. Nothing here is a manual procedure except the one-time configuration and the audit.

## What publication does, in order

1. **Revalidate** — the retained candidate bundle and the release manifest are validated once more against the release intent and the managed-D1 evidence, before anything is written.
2. **Version key** — `aws s3api put-object` with `--if-none-match '*'` and `--content-md5`. The conditional write is what makes a version key immutable: if the key already holds bytes, R2 answers `412` and the step fails rather than replacing what is already advertised.
3. **Public verification** — the public URL is fetched unauthenticated, exactly as a consumer does, and its SHA-256 compared to the candidate. The release notes may only advertise a URL that already serves the right bytes.
4. **Publish** — `gh release create` attaches the WASM and its manifest and publishes the release. This is the moment the version becomes publicly advertised, and it is the last write of the run.

There is no dry-run mode. To rehearse a release, cut the next patch version — at pre-1.0 that is cheap, and it avoids a whole rehearsal-and-teardown apparatus that can only ever exercise a path the real release does not take.

## GitHub Environment

Create a protected Environment named **`release-publication`** with selected deployment refs only:

- tag: `v*`;
- no required reviewer;
- no wait timer.

The absence of a reviewer is deliberate: a validated release tag is release approval, and there is no second click. Because `release.yml` triggers only on tag push and the publish job sits behind this Environment, no pull request can reach these secrets.

Configure these identifiers (never commit their values):

- Environment secret `R2_ACCESS_KEY_ID`;
- Environment secret `R2_SECRET_ACCESS_KEY`;
- Environment variable `CLOUDFLARE_ACCOUNT_ID`, the same account that carries the `sqlc` bucket.

The `v*` rule must be created as a **tag** rule; created as a branch rule it matches no tag, and every tag push is then refused the Environment.

GitHub credentials are the job-scoped `GITHUB_TOKEN` only. `contents: write` appears on the publish job and nowhere else; there is no PAT and no OIDC token.

Repository Actions artifact retention must permit at least 30 days.

## How R2 is reached

Uploads go through the **AWS CLI** (`aws s3api`), which GitHub runners preinstall and which already speaks S3 conditional writes. Credentials reach it through the step environment, never through argv, so they cannot appear in a process listing or a log.

Two environment settings matter and are set in the step: `AWS_ENDPOINT_URL` points at the account's R2 S3 endpoint, and `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` stops aws-cli v2 adding the CRC32 checksum that R2 rejects. The integrity check that matters is the `Content-MD5` sent with the object.

The CLI version is not pinned; it is whatever the runner image carries.

## R2 API token

Create an account-owned R2 API token, not one tied to a maintainer's user account, and grant only:

- Object Read & Write on the `sqlc` bucket.

Workers, D1, KV, Queues, and zone permissions are not required. The managed-D1 token is a separate credential and must never gain R2 permissions.

## One-time configuration

1. Enable immutable releases and confirm the setting:

   ```sh
   gh api -X PUT repos/mkuznets/sqlc-d1-typescript/immutable-releases
   gh api repos/mkuznets/sqlc-d1-typescript/immutable-releases
   ```

2. Create the `release-publication` Environment with the tag rule and both secrets above.
3. Create the bucket-scoped R2 API token and store its values only in that Environment.
4. Confirm Actions artifact retention supports at least 30 days.

## Recovery playbook

The version key is the boundary. Before it exists the version is free; after it exists the version is permanently bound to those bytes, because the public URL may already be cached anywhere.

| Situation                                  | What to do                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Failure before the R2 key exists           | Nothing permanent happened. Delete the tag, fix the cause, and recreate the tag at the same version.                                                   |
| Failure after the key exists               | The bytes at that key are final. Rerun the workflow only if the retained candidate is still available; otherwise cut the next version.                 |
| Retained candidate lost before publication | Abandon the version. A rebuilt artifact is a different artifact.                                                                                       |
| Existing key with different bytes          | The conditional write halts with a `412` before anything is replaced. Investigate before doing anything else.                                          |
| Public download fails or differs           | The release is not cut. Investigate the custom domain before retrying.                                                                                 |
| After publication                          | Never replace or delete the tag, the release, the assets, or the object. Add a superseded notice to the release notes and publish a corrected version. |

## Release notes

The maintainer writes the changelog in the annotated tag message; nothing generates it. `scripts/workflows/read-tag-notes.sh` reads `%(contents:body)` from the tag and the publish job passes it to `gh release create --notes-file`. A tag with no message body renders a commit-history link instead.

## Manual audit checklist

1. Confirm the Environment tag rule, the absence of a reviewer, and the secret identifiers above.
2. Confirm the R2 token grants Object Read & Write on `sqlc` only, and that it is account-owned.
3. Confirm `gh api repos/mkuznets/sqlc-d1-typescript/immutable-releases` reports `enabled: true`. The same call from inside a workflow answers `403`, so this is the only proof there is.
4. Confirm repository artifact retention supports 30 days.
5. After a release, confirm the published release body quotes exactly the artifact digest and no other, and that the public URL serves the same SHA-256 the manifest records.
