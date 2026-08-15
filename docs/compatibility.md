# Compatibility

## sqlc support policy

- Supported floor: **v1.25.0**. Older versions are rejected with `[COMPATIBILITY/UNSUPPORTED_SQLC_VERSION]`.
- Tested ceiling: **v1.31.1**. Every CI run generates and type-checks the repository's fixtures with both the floor and the ceiling.
- Versions newer than the ceiling are not rejected. They produce `[COMPATIBILITY/UNTESTED_SQLC_VERSION]` and continue generation unless another incompatibility is found.

See [sqlc-to-D1 translation](sqlc-to-d1.md) for the commands, macros, metadata, and value representations in the compatibility surface.

## TypeScript

Generated code is strict-mode TypeScript, compiled and verified against a current TypeScript on every CI run. No particular compiler version is required of consumers.

## Cloudflare

Local verification runs the plugin's output under Miniflare and workerd, at the versions pinned in `test/miniflare/bun.lock` and the compatibility date in `test/miniflare/wrangler.jsonc`. Those are the repository's own test environment, **not** minimum consumer dependencies — nothing here asks you to copy the repository lockfiles.

## What a release binds

Each GitHub release ships the WASM plus a `sqlc-gen-d1-typescript_<version>.manifest.json` recording the version, tag, source commit, the artifact's permanent URL, its lowercase SHA-256 and size, and the sqlc floor and ceiling it was tested against.

Before the release is cut, the artifact is written to its permanent R2 key with a create-only conditional write, then re-downloaded from the public URL unauthenticated and compared to the bytes just published. A release you can see is one whose artifact was already proven to serve at that digest.

The versioned URL is permanent: it is created once and never replaced, so a digest you pinned stays valid. A correction is always a new version. There is no moving `latest` URL.

```text
https://sqlc.mkuznets.com/plugins/sqlc-gen-d1-typescript_<version>.wasm
```

Take the URL and the digest from the same release record. Continue to [troubleshooting](troubleshooting.md) when a generation diagnostic or runtime error appears.
