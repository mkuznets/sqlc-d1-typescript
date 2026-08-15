# Compatibility

The source of truth is [`verification/compatibility.json`](../verification/compatibility.json). Everything on this page is derived from it.

## sqlc support policy

- Supported floor: **v1.18.0**.
- Tested ceiling: **v1.31.1**.
- Versions newer than the ceiling are not rejected. They produce `[COMPATIBILITY/UNTESTED_SQLC_VERSION]` and continue generation unless another incompatibility is found.
- sqlc is sampled strategically: the floor, the tested ceiling, and the intervening releases tied to a material protocol or metadata change. Every sample below is tested on every CI run; this is not a claim that each intervening release has its own cell.

| sqlc    | Role        | Why this sample                                          |
| ------- | ----------- | -------------------------------------------------------- |
| v1.18.0 | floor       | Oldest supported Plugin protocol baseline.               |
| v1.20.0 | intervening | Includes the material `sqlc.slice` generation fix.       |
| v1.24.0 | intervening | Refactors the Plugin interface around `GenerateRequest`. |
| v1.31.1 | ceiling     | Newest release verified by the compatibility suite.      |

Known exceptions:

1. sqlc v1.18.0 cannot parse the current `sqlc.arg`, `sqlc.narg`, `sqlc.slice`, or `sqlc.embed` fixture syntax; its matrix cell uses `test/sqlc-v1-18` to cover all six ordinary commands and positional binds.
2. sqlc v1.20.0 and v1.24.0 parse the current fixture syntax, but their legacy Plugin WASM runtimes cannot execute the plugin from the official release binaries on macOS arm64; their Ubuntu x64 CI cells run both current fixture corpora.

See [sqlc-to-D1 translation](sqlc-to-d1.md) for the commands, macros, metadata, and value representations in the compatibility surface.

## TypeScript

Generated code compiles under both the supported floor compiler (**5.2.2**) and the current one (**5.9.3**). Consumers need neither exact version; the floor is the oldest compiler the emitted types are known to satisfy.

## Cloudflare

Local verification runs the plugin's output under Miniflare and workerd, at the versions pinned in `test/miniflare/bun.lock` and the compatibility date in `test/miniflare/wrangler.jsonc`. Those are the repository's own test environment, **not** minimum consumer dependencies — nothing here asks you to copy the repository lockfiles.

## What a release binds

Each GitHub release ships the WASM plus a `sqlc-gen-d1-typescript_<version>.manifest.json` recording the version, tag, source commit, the artifact's permanent URL, its lowercase SHA-256 and size, and the tool versions it was tested against.

Before the release is cut, the artifact is written to its permanent R2 key with a create-only conditional write, then re-downloaded from the public URL unauthenticated and compared to the bytes just published. A release you can see is one whose artifact was already proven to serve at that digest.

The versioned URL is permanent: it is created once and never replaced, so a digest you pinned stays valid. A correction is always a new version. There is no moving `latest` URL.

```text
https://sqlc.mkuznets.com/plugins/sqlc-gen-d1-typescript_<version>.wasm
```

Take the URL and the digest from the same release record. Continue to [troubleshooting](troubleshooting.md) when a generation diagnostic or runtime error appears.
