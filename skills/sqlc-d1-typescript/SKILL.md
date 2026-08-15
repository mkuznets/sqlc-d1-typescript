---
name: sqlc-d1-typescript
description: Generate typed TypeScript for SQLite queries executed through a Cloudflare Workers D1 binding, with the
  sqlc-d1-typescript sqlc Plugin. Use when adding sqlc generation to a Worker, pinning the Plugin's release URL
  and SHA-256, wiring a D1 binding to generated queries, or resolving a generation diagnostic printed as
  CATEGORY/REASON in brackets, or a SqlcD1Error thrown at run time.
---

# sqlc-d1-typescript

`sqlc-d1-typescript` is a sqlc code-generation Plugin. It translates sqlc's analyzed SQLite query metadata into
TypeScript query factories plus one shared runtime, executed through the Workers binding interface: a Worker's
`D1Database` or D1 session binding.

Run the seven steps below in order, and hold each one until its **Done when** state is true. The run ends at
**verified local behavior** — generation, compilation, and one passing local D1 test — and stops there.
Deployment, remote bindings, and Cloudflare credentials belong to the human, after this run.

When a step cannot reach its state, stop and report what was reached. `reference/failures.md` routes generation
diagnostics, runtime errors, and the fail-closed rule.

Two preconditions hold this whole run: `sqlc` is on `PATH`, and the project is a Cloudflare Worker. Confirm
both before step 1. When either is missing, stop and report the missing precondition — this run configures a
Worker that already exists, using a toolchain that is already installed.

## Step 1 — Bind this run to one release

The Plugin is distributed as one immutable artifact per version, identified by a permanent URL and a SHA-256.
Both values come from **one release record**, and releases before the first stable version may generate
different APIs, so this run is bound to exactly one release before anything is written.

1. **Find the version.** Read `plugins[].wasm.url` from the project's `sqlc.yaml`: the version is the
   `<version>` in `sqlc-gen-d1-typescript_<version>.wasm`. With no configuration yet, use the version the human
   names, or the newest on
   [the releases page](https://github.com/mkuznets/sqlc-d1-typescript/releases).
2. **Copy the two values together.** Open the release record for `v<version>` — the GitHub release for that tag
   and its release manifest, `sqlc-gen-d1-typescript_<version>.manifest.json` — and take the artifact URL and
   the lowercase SHA-256 from that one record. The digest is required configuration: sqlc verifies the fetched
   bytes against it before running the Plugin. It is 64 lowercase hexadecimal characters — when what you read
   is not, stop and report, because it is not the digest.

Version-specific facts — the supported sqlc range and the TypeScript versions the generated code compiles
under — come from that release record and from
[`docs/compatibility.md`](https://github.com/mkuznets/sqlc-d1-typescript/blob/v<version>/docs/compatibility.md)
at the same tag.

**Done when** you hold one version, one artifact URL, and one 64-lowercase-hexadecimal SHA-256, all read from
the same release record.

## Step 2 — Write the sqlc configuration

Point sqlc at the project's schema and queries, and at the artifact selected in step 1:

```yaml
version: "2"
plugins:
  - name: ts
    wasm:
      url: https://sqlc.mkuznets.com/plugins/sqlc-gen-d1-typescript_<version>.wasm
      sha256: <sha256-from-the-same-release-record>
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

`schema`, `queries`, and `out` follow the project's own layout. `engine` is `sqlite`, and `interface: workers`
is the entire option surface — any other key or value stops generation with an `OPTIONS` diagnostic.

**Done when** `sqlc.yaml` names the project's schema and queries, `engine: "sqlite"`, an `out` directory, the
step-1 URL and `sha256`, and `interface: workers` as its only option.

## Step 3 — Generate

```sh
sqlc generate
```

The Plugin groups query factories by SQL source file and emits one shared runtime, so the output directory
holds `runtime.ts` plus one `<source>_sql.ts` per SQL source file. They open with a do-not-edit notice, and
they stay byte-identical to what the Plugin wrote. When the output has to change, change the schema, the query,
or the configuration and generate again.

A `[CATEGORY/REASON]` line routes to `reference/failures.md`.

**Done when** `sqlc generate` exits zero and the output directory holds `runtime.ts` plus one `<source>_sql.ts`
per SQL source file, exactly as the run wrote them.

## Step 4 — Wire the Workers binding interface

Give the Worker a D1 binding in `wrangler.jsonc` — a `d1_databases` entry with the binding name, database name,
database id, and `migrations_dir` — then run `wrangler types` so `Env` carries the binding type.

The generated public API is two imports: the query executor from `runtime.ts`, and the query factories from
`<source>_sql.ts`. A factory validates and snapshots its bind values synchronously and returns a query
descriptor; the query executor performs the D1 call and the checked row mapping.

```ts
import { DB } from "./runtime";
import { getUser } from "./queries_sql";

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const user = await new DB(env.DB).execute(getUser({ id: 1 }));
    return Response.json({ user });
  },
};
```

`DB.batch()` takes a statically non-empty tuple of query descriptors and runs one native atomic D1 batch.
`DB.withSession()` returns a session executor, whose `getBookmark()` yields the session bookmark to carry into
a later request. Their rules are in
[`docs/runtime-and-errors.md`](https://github.com/mkuznets/sqlc-d1-typescript/blob/v<version>/docs/runtime-and-errors.md)
at the selected tag.

**Done when** the Worker's handler executes at least one query descriptor through `new DB(env.<BINDING>)`, and
`wrangler types` has produced the binding types.

## Step 5 — Compile

Run the project's typecheck — `tsc --noEmit`, and the test `tsconfig.json` when the project has one.

The generated declarations are the contract. When a value does not fit one, the SQL, the schema, or the
configuration is what changes; regenerate and typecheck again. Keep consumer code free of type assertions and
compiler suppressions, and generated files as the Plugin wrote them.

A type that only a cast would satisfy is a stop: report it with the change you propose, and route through
`reference/failures.md`.

**Done when** the project typechecks with no type assertion, no compiler suppression, and no edit to any
generated file.

## Step 6 — Run one focused local D1 test

Generation and compilation say nothing about execution. One test, against local D1, executes a generated query
descriptor through the query executor and asserts the mapped row it returns.

When the project has no `@cloudflare/vitest-pool-workers` harness, `reference/local-d1-test.md` carries the
wiring: dev dependencies, the binding, the config, per-test schema application, and the spec.

**Done when** one test executes a generated query descriptor against local D1, asserts the mapped row, and
passes.

## Step 7 — Report and stop

Report, in the run's own words:

- the selected **version**;
- that the artifact URL and the SHA-256 came from that one **release record**;
- the **generated files**, unedited;
- the **typecheck** result;
- the **local D1 test** result, and any warning generation reported.

Then stop. Deploying the Worker, pointing it at a live D1 database, and any Cloudflare credential are the
human's own step, outside this run.

**Done when** the report names the version, where the URL and digest came from, the generated files, the
typecheck result, and the local D1 test result.
