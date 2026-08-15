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

The SHA-256 is part of the selected-release configuration, not a placeholder to omit. The release manifest binds the version, tag, source commit, artifact size, URL, and digest to the same published artifact, alongside the sqlc versions it was tested against.

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
- [Compatibility](docs/compatibility.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Complete runnable D1 Worker](examples/d1-worker/)

The canonical Worker is the repository's only complete application. It demonstrates list/get/rename routes, batching, a session executor, bookmarks, and an error boundary.

## Drive it with an agent skill

`skills/sqlc-d1-typescript/` is an agent-facing procedure for wiring this Plugin into your own Worker: select one release, write the sqlc configuration, generate, wire the D1 binding, typecheck, and prove it with one local D1 test. It stops there — it requests no Cloudflare credential and deploys nothing.

The skill ships inside the tagged tree, so there is no separate download. Install it from the Git tag matching the Plugin version configured in your `sqlc.yaml`:

```sh
VERSION=<selected-version>   # the same version configured in sqlc.yaml
git clone --depth 1 --branch "v$VERSION" https://github.com/mkuznets/sqlc-d1-typescript /tmp/sqlc-d1-typescript
mkdir -p .claude/skills
rm -rf .claude/skills/sqlc-d1-typescript
cp -R /tmp/sqlc-d1-typescript/skills/sqlc-d1-typescript .claude/skills/
rm -rf /tmp/sqlc-d1-typescript
```

Substitute your agent harness's skills directory for `.claude/skills` if it uses another one; the skill itself is plain Markdown.

The skill's guidance describes one Plugin version, so clone the tag that matches your `sqlc.yaml`. Upgrading the Plugin means re-running the command above with the new version; it removes the previous install before copying, so no stale file survives an upgrade.

## Known rough edges

- Pre-1.0 releases may break generated APIs. Pin the URL and SHA-256, then regenerate deliberately.
