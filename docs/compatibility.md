# Compatibility and release evidence

This page separates the compatibility surface promised to consumers from the exact tools used to gather current release evidence. The source of truth is [`verification/compatibility.json`](../verification/compatibility.json).

## sqlc support policy

- Supported floor: **v1.18.0**.
- Tested ceiling: **v1.31.1**.
- Versions newer than the ceiling are not automatically rejected. They produce `[COMPATIBILITY/UNTESTED_SQLC_VERSION]` and continue generation unless another incompatibility is found.
- The strategic samples below are tested; this is not a claim that every intervening release has an individual test cell.

| sqlc    | Role        | Evidence rationale                                       |
| ------- | ----------- | -------------------------------------------------------- |
| v1.18.0 | floor       | Oldest supported Plugin protocol baseline.               |
| v1.20.0 | intervening | Includes the material `sqlc.slice` generation fix.       |
| v1.24.0 | intervening | Refactors the Plugin interface around `GenerateRequest`. |
| v1.31.1 | ceiling     | Newest release verified by the compatibility suite.      |

Known evidence exceptions:

1. sqlc v1.18.0 cannot parse the current `sqlc.arg`, `sqlc.narg`, `sqlc.slice`, or `sqlc.embed` fixture syntax; its matrix cell uses `test/sqlc-v1-18` to cover all six ordinary commands and positional binds.
2. sqlc v1.20.0 and v1.24.0 parse the current fixture syntax, but their legacy Plugin WASM runtimes cannot execute the publication candidate from the official release binaries on macOS arm64; their Ubuntu x64 CI cells run both current fixture corpora.

See [sqlc-to-D1 translation](sqlc-to-d1.md) for the commands, macros, metadata, and value representations included in the compatibility surface.

## TypeScript evidence

| Role                      | Version |
| ------------------------- | ------- |
| supported floor compiler  | 5.2.2   |
| current compiler evidence | 5.9.3   |

Generated public API and documentation excerpts compile against both versions for the same publication candidate.

## Cloudflare local evidence baseline

| Input               | Exact evidence value |
| ------------------- | -------------------- |
| Workers types       | 4.20260214.0         |
| Wrangler            | 4.63.0               |
| Vitest Pool Workers | 0.12.21              |
| Miniflare           | 4.20260310.0         |
| workerd             | 1.20260310.1         |
| compatibility date  | 2026-02-05           |
| compatibility flags | none (`[]`)          |

These versions describe the repository's exact local verification environment. They are **not** minimum consumer dependencies and do not require consumers to copy the repository lockfiles.

The exact build/evidence tools are Node 24.12.0, npm 11.6.2, Bun 1.3.10, Buf 1.65.0, and Javy 8.0.0. These likewise bind release evidence; they are not runtime installation requirements.

## Managed D1 status

Managed-D1 scenarios are a release gate and a weekly/default-branch smoke check. A fresh D1 database and ephemeral authenticated Scenario Worker exercise physical values and metadata, native batch rollback and error identity, session routing/bookmark transfer, and post-execution row mapping for the exact publication candidate. The closed managed evidence records candidate/configuration identity, scenario outcomes, exact resource identifiers, and primary cleanup facts for 30 days.

This is managed-runtime evidence, not a claim about a pinned D1 or SQLite engine version. Local Miniflare tests remain the exhaustive primary owner of the compatibility surface. See [managed D1 verification operations](managed-d1-verification.md) for the protected Environment, minimum Cloudflare token permissions, cleanup/reaper policy, and audit procedure.

## How a selected release binds evidence

A selected GitHub release and its release manifest identify:

- version and source commit;
- permanent artifact URL;
- lowercase SHA-256 and artifact size;
- exact publication candidate identity;
- compatibility evidence associated with those bytes;
- a managed-D1 pass date and numeric evidence artifact ID, after all scenarios and primary cleanup pass.

Those values are not copied by hand. Before a release is published, automation downloads the artifact from the GitHub release asset, from the R2 object directly, and from the public URL unauthenticated, and requires one identical SHA-256 from all three plus the manifest and the release body. Only then is the release published, so a release you can see is a release whose artifact was already proven downloadable at that digest.

The versioned URL is permanent. It is created once with a create-only write and served with `Cache-Control: immutable`; the bytes behind it never change. A correction is always a new version, never a replacement, so a digest you pinned stays valid.

Use URL and digest values from the same release record. Repository documentation stays evergreen and therefore does not invent a concrete first-release version or SHA. The immutable URL shape is:

```text
https://sqlc.mkuznets.com/plugins/sqlc-gen-d1-typescript_<version>.wasm
```

There is no moving `latest` artifact URL. Continue to [troubleshooting](troubleshooting.md) when a generation diagnostic or runtime error appears.
