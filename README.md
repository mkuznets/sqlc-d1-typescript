# sqlc D1 TypeScript

`sqlc-d1-typescript` is a sqlc code-generation Plugin for SQLite queries executed through Cloudflare Workers D1 bindings. It generates typed query factories, opaque query descriptors, and a shared TypeScript query executor. It is not a database driver and does not target D1's HTTP API or Node SQLite interfaces.

> **Pre-1.0:** releases may contain breaking changes. Pin one immutable Plugin release and review its release notes before regenerating or upgrading.

## Select and configure a release

Open the [GitHub Releases page](https://github.com/mkuznets/sqlc-d1-typescript/releases), select one release, and copy **both** its permanent artifact URL and matching lowercase SHA-256 from that release's manifest. The values must come from the same release record; do not use a moving `latest` URL.

In the configuration below, replace `<selected-version>` and `<selected-sha256>` with those matching release values. The canonical artifact URL is `https://sqlc.mkuznets.com/plugins/sqlc-gen-d1-typescript_<version>.wasm`.

```yaml
version: "2"
plugins:
  - name: ts
    wasm:
      url: https://sqlc.mkuznets.com/plugins/sqlc-gen-d1-typescript_<selected-version>.wasm
      sha256: <selected-sha256>
sql:
  - schema: "migrations/0001_init.sql"
    queries: "queries.sql"
    engine: "sqlite"
    codegen:
      - plugin: ts
        out: src
        options:
          interface: workers
```

The SHA-256 is part of the selected-release configuration, not a placeholder to omit. The release manifest also binds the version, source commit, artifact size, compatibility evidence, URL, and digest to the same published artifact.

## Generate your first query

Create `migrations/0001_init.sql`:

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  nickname TEXT
) STRICT;
```

Create `queries.sql`:

```sql
-- name: GetUser :one
SELECT id, name, nickname FROM users WHERE id = ?;
```

Run:

```sh
sqlc generate
```

The Plugin groups factories by SQL source file and emits one shared runtime:

```text
src/
├── queries_sql.ts
└── runtime.ts
```

Both files are generated. Do not edit them: change the schema, query, or sqlc configuration and run `sqlc generate` again.

Use the generated public API in a Worker:

<!-- compile: first-query -->

```ts
import { DB } from "./runtime";
import { getUser } from "./queries_sql";

interface Env {
  DB: D1Database;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const user = await new DB(env.DB).execute(getUser({ id: 1 }));
    return Response.json({ user });
  },
};
```

Calling `getUser` validates and snapshots bind values synchronously, then returns a query descriptor; `execute` performs the D1 call and checked row mapping. Here the result is `GetUserRow | null`.

## Learn the public surface

- [Generated-code tour](docs/generated-code-tour.md)
- [sqlc-to-D1 translation](docs/sqlc-to-d1.md)
- [Runtime, batches, sessions, and errors](docs/runtime-and-errors.md)
- [Compatibility and release evidence](docs/compatibility.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Complete runnable D1 Worker](examples/d1-worker/)

The canonical Worker is the repository's only complete application. It demonstrates list/get/rename routes, batching, a session executor, bookmarks, and an error boundary.

## Known rough edges

- Pre-1.0 releases may break generated APIs. Pin the URL and SHA-256, then regenerate deliberately.
