# Wiring a local D1 test

Reached from step 6 of `SKILL.md` when the project has no `@cloudflare/vitest-pool-workers` harness. A project
that already runs Worker tests keeps its own harness and only adds the one spec at the end of this page.

Everything here runs locally against Miniflare-backed D1 with isolated storage per test. No Cloudflare account,
credential, or live database is involved.

This page uses one worked example, the same schema and queries as the canonical Worker in the repository:

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  nickname TEXT
) STRICT;

-- name: GetUser :one
SELECT id, name, nickname FROM users WHERE id = ?;
```

Substitute the project's own schema, query, and generated factory throughout.

## 1. Dev dependencies

```sh
npm install --save-dev @cloudflare/vitest-pool-workers vitest wrangler
```

The exact versions this Plugin version was verified against are in
[`docs/compatibility.md`](https://github.com/mkuznets/sqlc-d1-typescript/blob/v<version>/docs/compatibility.md)
at the installed tag. Match them when a test fails in a way the project's own code does not explain.

## 2. `wrangler.jsonc`

The D1 binding the Worker and the tests share, plus the compatibility date the release's evidence names:

```jsonc
{
  "name": "<worker-name>",
  "main": "src/index.ts",
  "compatibility_date": "<compatibility-date>",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "<database-name>",
      "database_id": "<database-id>",
      "migrations_dir": "migrations",
    },
  ],
}
```

Run `wrangler types` after editing this file so `Env` carries the binding.

## 3. `vitest.config.ts`

`defineWorkersConfig` reads the same `wrangler.jsonc`. The schema is split into statements at config time and
handed to the test environment as a binding, so each test can apply it to its own isolated storage.
`remoteBindings: false` keeps every run local.

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { unstable_splitSqlQuery } from "wrangler";

const migration = fileURLToPath(new URL("./migrations/0001_init.sql", import.meta.url));
const statements = unstable_splitSqlQuery(readFileSync(migration, "utf8"));

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        remoteBindings: false,
        miniflare: { bindings: { TEST_SCHEMA_QUERIES: JSON.stringify(statements) } },
      },
    },
  },
});
```

## 4. Typecheck configuration

`vitest.config.ts` reads the migration with Node built-ins, and the test files use the `cloudflare:test`
module, so neither belongs in the Worker's own typecheck. Keep the Worker's `tsconfig.json` to `src/` and the
binding types:

```jsonc
{
  "exclude": ["test", "vitest.config.ts"],
  "include": ["worker-configuration.d.ts", "src/**/*.ts"],
}
```

Give the tests their own `test/tsconfig.json`, which extends it and adds the pool's types:

```jsonc
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "types": ["@cloudflare/vitest-pool-workers"] },
  "include": ["./**/*.ts", "../worker-configuration.d.ts"],
  "exclude": [],
}
```

Step 5 of `SKILL.md` runs both: `tsc --noEmit` and `tsc -p test/tsconfig.json --noEmit`.

## 5. Schema per test

`test/env.d.ts` declares the extra binding:

```ts
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_SCHEMA_QUERIES: string;
  }
}
```

`test/setup.ts` applies the schema before each test, into storage that starts empty:

```ts
import { env } from "cloudflare:test";
import { beforeEach } from "vitest";

beforeEach(async () => {
  for (const statement of JSON.parse(env.TEST_SCHEMA_QUERIES) as string[]) await env.DB.prepare(statement).run();
});
```

## 6. One round-trip spec

Seed a row through the D1 binding, build a query descriptor with a generated factory, execute it through the
query executor, and assert the mapped row object:

```ts
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { DB } from "../src/runtime";
import { getUser } from "../src/queries_sql";

it("maps a row through the generated query executor", async () => {
  await env.DB.prepare("INSERT INTO users (id, name, nickname) VALUES (?, ?, ?)").bind(1, "Ada", "ada").run();

  const user = await new DB(env.DB).execute(getUser({ id: 1 }));

  expect(user).toEqual({ id: 1, name: "Ada", nickname: "ada" });
});
```

The assertion is on the mapped row object, not on a row count or on the absence of a throw: the mapping is what
the Plugin generated and what the test is here to show.

## 7. Run it

```sh
npx vitest --run
```

A pass is step 6's completion criterion. A failure routes to `reference/failures.md`.
