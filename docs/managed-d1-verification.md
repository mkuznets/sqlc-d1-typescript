# Managed D1 verification operations

Managed verification deploys a short-lived Scenario Worker and fresh D1 database for one exact publication candidate. The Worker uses the Workers binding interface and accepts only authenticated, compiled-in scenario identifiers. It accepts no SQL, values, expected rows, bookmarks, or generic operation payloads.

## GitHub Environment

Create a protected Environment named **`managed-d1`** with selected deployment refs only:

- branch: `main`;
- tag: `v*`;
- no required reviewer;
- no wait timer.

The absence of a reviewer is deliberate: a validated release tag is release approval. Ordinary and fork pull requests never call the managed workflow or receive this Environment.

Configure these identifiers (never commit their values):

- Environment secret `CLOUDFLARE_API_TOKEN`;
- Environment variable `CLOUDFLARE_ACCOUNT_ID`.

Repository Actions artifact retention must permit at least 30 days.

## Cloudflare token

Restrict the token to the single verification account and grant only:

- Account / D1 / Edit;
- Account / Workers Scripts / Edit.

Workers Routes, Custom Domains, KV, R2, Queues, zone permissions, Global API keys, and browser login are not required. Rotate or revoke the token in Cloudflare and replace only the Environment secret value.

## Operation and recovery

`managed-d1.yml` runs weekly and by default-branch manual dispatch. `release.yml` calls the same reusable `_managed-d1.yml` after all uncredentialed gates. Each call downloads candidate bytes by numeric artifact ID and validates their full SHA-256 before the credentialed job.

Resources use the complete reserved grammar:

```text
sqlc-d1-ci-YYYYMMDDTHHMMSSZ-<run-id>-<attempt>-<8-lower-hex>
```

The D1 UUID and exact Worker script name are persisted immediately. Primary cleanup runs even after test failure and verifies exact deletion. Primary cleanup failure remains a failed release gate even if emergency recovery succeeds. A weekly independent reaper deletes only complete reserved names strictly older than 24 hours.

To run normal verification:

```sh
gh workflow run managed-d1.yml --ref main -f mode=normal
```

Maintainers may use `simulate-test-failure` or `simulate-cleanup-failure` only in this manual workflow. Release calls always use `normal`.

## Manual audit checklist

1. Confirm Environment branch/tag rules, no reviewer, and the secret/variable identifiers above.
2. Confirm token account restriction and only D1 Edit plus Workers Scripts Edit.
3. Confirm repository artifact retention supports 30 days.
4. Run `normal`; download `managed-d1-evidence-<run>-<attempt>` by numeric artifact ID.
5. Validate it with `make validate-managed-d1-evidence EVIDENCE=<path>`.
6. Confirm the exact Worker script name and D1 UUID are absent from Cloudflare inventory.
7. Inspect logs/evidence for prohibited SQL, values, rows, bookmarks, authorization, tokens, headers, stack traces, causes, and response bodies.
8. Exercise both simulated failure modes and confirm each workflow fails while retaining evidence and cleanup facts.
9. For hard interruption, allow the greater-than-24-hour reaper threshold, then confirm exact deletion and download its redacted report.

A force-killed runner cannot guarantee its `always()` step executes; immediate exact state persistence plus the independent reaper is the final recovery control.
