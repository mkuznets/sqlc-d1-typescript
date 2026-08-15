# Release publication operations

A release is a SemVer `v*` tag pushed on default-branch lineage. That tag is the approval, and it is the only one. There is no dry-run mode: to rehearse a release, cut the next patch version.

Everything below is executed by the `publish` job in [`.github/workflows/release.yml`](../.github/workflows/release.yml). Nothing here is a manual procedure except the one-time configuration and the audit.

## What publication does, in order

The `verify` job validates the tag, builds the plugin once, and runs every uncredentialed check against it. The `sqlc-compatibility` matrix tests those same bytes across the sampled sqlc versions. Only then does `publish` run:

1. **Manifest** — the wasm is renamed to its canonical filename and `scripts/release.ts manifest` records its digest, size, permanent URL, and the tested sqlc range.
2. **Version key** — `aws s3api put-object` with `--if-none-match '*'` and `--content-md5`. The conditional write is what makes the key immutable: if it already holds bytes, R2 answers `412` and the step fails rather than replacing what is already advertised.
3. **Public verification** — the public URL is fetched unauthenticated, exactly as a consumer does, and its SHA-256 compared to the bytes just published. The release notes may only advertise a URL that already serves the right bytes.
4. **Publish** — `gh release create` attaches the wasm and its manifest. This is the last write of the run.

## GitHub Environment

Create a protected Environment named **`release-publication`** with selected deployment refs only:

- tag: `v*`;
- no required reviewer;
- no wait timer.

The absence of a reviewer is deliberate: a validated release tag is the approval, and there is no second click. Because `release.yml` triggers only on tag push and `publish` sits behind this Environment, no pull request can reach these secrets.

Configure these identifiers (never commit their values):

- Environment secret `R2_ACCESS_KEY_ID`;
- Environment secret `R2_SECRET_ACCESS_KEY`;
- Environment variable `CLOUDFLARE_ACCOUNT_ID`, the same account that carries the `sqlc` bucket.

The `v*` rule must be created as a **tag** rule; created as a branch rule it matches no tag, and every tag push is then refused the Environment.

GitHub credentials are the job-scoped `GITHUB_TOKEN` only. `contents: write` appears on the publish job and nowhere else.

## How R2 is reached

Uploads go through the AWS CLI (`aws s3api`), which GitHub runners preinstall and which already speaks S3 conditional writes. Credentials reach it through the step environment, never through argv, so they cannot appear in a process listing or a log.

Two settings matter: `AWS_ENDPOINT_URL` points at the account's R2 S3 endpoint, and `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` stops aws-cli v2 adding the CRC32 checksum R2 rejects. The integrity check that matters is the `Content-MD5` sent with the object.

Create an account-owned R2 API token — not one tied to a maintainer's user account — granting only **Object Read & Write on the `sqlc` bucket**. Workers, D1, KV, Queues, and zone permissions are not required.

## One-time configuration

1. Enable immutable releases and confirm the setting:

   ```sh
   gh api -X PUT repos/mkuznets/sqlc-d1-typescript/immutable-releases
   gh api repos/mkuznets/sqlc-d1-typescript/immutable-releases
   ```

2. Create the `release-publication` Environment with the tag rule and both secrets above.
3. Create the bucket-scoped R2 API token and store its values only in that Environment.

## Recovery playbook

The version key is the boundary. Before it exists the version is free; after it exists the version is permanently bound to those bytes, because the public URL may already be cached anywhere.

| Situation                         | What to do                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Failure before the R2 key exists  | Nothing permanent happened. Delete the tag, fix the cause, recreate the tag at the same version.                                                       |
| Failure after the key exists      | The bytes at that key are final. Cut the next version.                                                                                                 |
| Existing key with different bytes | The conditional write halts with a `412` before anything is replaced. Investigate before doing anything else.                                          |
| Public download fails or differs  | The release is not cut. Investigate the custom domain before retrying.                                                                                 |
| After publication                 | Never replace or delete the tag, the release, the assets, or the object. Add a superseded notice to the release notes and publish a corrected version. |

## Release notes

The maintainer writes the changelog in the annotated tag message; nothing generates it. The publish job reads `%(contents:body)` from the tag and passes it to `gh release create --notes-file`.

## Manual audit checklist

1. Confirm the Environment tag rule, the absence of a reviewer, and the secret identifiers above.
2. Confirm the R2 token grants Object Read & Write on `sqlc` only, and that it is account-owned.
3. Confirm `gh api repos/mkuznets/sqlc-d1-typescript/immutable-releases` reports `enabled: true`. The same call from inside a workflow answers `403`, so this is the only proof there is.
4. After a release, confirm the published release body quotes exactly the artifact digest and no other, and that the public URL serves the SHA-256 the manifest records.
