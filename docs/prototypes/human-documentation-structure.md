# PROTOTYPE — human documentation structure

> **Throwaway artifact.** This file tests a documentation structure; it is not release documentation and must not be merged as-is.
>
> Question: What human-facing documentation structure and annotated generated-code walkthrough will let an experienced sqlc/Cloudflare user install the Plugin quickly while teaching its TypeScript mechanisms in simple language?

## How to review this prototype

1. Compare the three structures below.
2. Read the rendered sample for the recommended structure.
3. Answer the four review questions at the end.

The examples reflect decisions already made by this release-planning effort. Artifact URLs, hashes, and exact tested versions remain placeholders until the release contract is decided.

---

## Three possible structures

### A. One linear README

```text
README.md
└── pitch → install → first query → generated code → commands → sessions → errors
```

**Feels like:** one tutorial from top to bottom.

**Strength:** everything is visible from the repository front page.

**Cost:** an experienced user must scroll through TypeScript teaching to find reference facts, while a maintainer must reconstruct one mechanism from examples scattered through a long page.

### B. Fast path plus a code tour and reference — recommended

```text
README.md                         2-minute orientation and copy/paste install
examples/d1-worker/              runnable canonical example
docs/
├── getting-started.md           one end-to-end query in a Worker
├── generated-code-tour.md       simple, annotated TypeScript mechanisms
├── query-reference.md           six commands and four macros
├── runtime-and-errors.md        batches, sessions, values, errors, retry warning
├── compatibility.md             tested versions and D1 evidence
└── troubleshooting.md           generation diagnostics and common failures
```

Add `docs/migrating.md` only when a release has an actual migration to explain. Release-specific versions, hashes, compatibility evidence, and changes also live in that GitHub release.

**Feels like:** a short on-ramp with progressively deeper layers.

**Strength:** experienced users can install without reading a lesson. The generated-code tour gives maintainers one stable teaching path through the TypeScript mechanisms. Reference facts have obvious homes.

**Cost:** concepts link across several small pages, so navigation and terminology must stay consistent.

### C. Generated-code-first handbook

```text
README.md
handbook/
├── 01-plugin-input.md
├── 02-query-factories.md
├── 03-query-descriptors.md
├── 04-query-executors.md
├── 05-row-mapping.md
├── 06-batches-and-sessions.md
└── 07-errors.md
```

**Feels like:** reading the implementation model in dependency order.

**Strength:** excellent for maintainers studying how the Plugin works.

**Cost:** installation and everyday lookup become secondary. It teaches concepts before giving an experienced user a working result.

### Comparison

| Need | A: linear README | B: fast path + tour | C: handbook |
|---|---:|---:|---:|
| Install quickly | Good | **Best** | Weak |
| Learn the TypeScript | Fair | **Good** | Best |
| Look up one command | Weak | **Best** | Fair |
| Keep release facts current | Weak | **Good** | Fair |
| Avoid duplicating explanations | Weak | **Good** | Good |

---

# Rendered sample of structure B

The following is a rough composite. Headings marked with a file name would live in separate documents.

## `README.md`

# sqlc-d1-typescript

Generate type-safe TypeScript from sqlc-analyzed SQLite queries and execute them through a Cloudflare Workers D1 binding.

The Plugin generates:

- a factory for each named query;
- TypeScript types for its arguments and rows;
- a shared runtime for direct execution, atomic batches, and D1 sessions.

It supports sqlc `>=1.18.0` through a named tested ceiling. It targets the Workers binding interface (`D1Database` and D1 sessions), not the D1 HTTP API or Node.js SQLite clients.

### Install the Plugin

Copy the immutable URL and SHA-256 from the release you want to use:

```yaml
version: "2"

plugins:
  - name: d1ts
    wasm:
      url: https://<release-artifact-host>/<version>/plugin.wasm
      sha256: <sha256-from-the-same-github-release>

sql:
  - engine: sqlite
    schema: schema.sql
    queries: queries.sql
    codegen:
      - plugin: d1ts
        out: generated
        options:
          interface: workers
```

Then run:

```sh
sqlc generate
```

The output has one shared runtime and one module per SQL input file:

```text
generated/
├── runtime.ts
└── users_sql.ts
```

### Use one generated query

```ts
import { DB } from "./generated/runtime";
import { getUser } from "./generated/users_sql";

type Env = { DB: D1Database };

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const db = new DB(env.DB);
    const user = await db.execute(getUser({ id: 42 }));
    return Response.json(user);
  },
};
```

`getUser(...)` builds a **query descriptor**. It does not contact D1. `db.execute(...)` executes that descriptor and returns the mapped result.

- Continue with [Getting started](docs/getting-started.md).
- Understand the output in [Generated-code tour](docs/generated-code-tour.md).
- Look up commands and macros in [Query reference](docs/query-reference.md).

---

## `docs/getting-started.md`

# Getting started

This page makes one query work end to end. It assumes the reader already knows how to create a Worker with a D1 binding.

### 1. Describe the table

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  nickname TEXT
);
```

### 2. Name the query

```sql
-- name: GetUser :one
SELECT id, name, nickname
FROM users
WHERE id = sqlc.arg(id);
```

`:one` means “return the first row, or `null` when there is no row.” `sqlc.arg(id)` gives the generated argument its name.

### 3. Generate TypeScript

```sh
sqlc generate
```

### 4. Execute the query descriptor

```ts
const db = new DB(env.DB);
const query = getUser({ id: 42 }); // Builds data. No D1 call yet.
const user = await db.execute(query); // Calls D1 here.

if (user === null) {
  return new Response("Not found", { status: 404 });
}

return Response.json(user);
```

TypeScript knows the result is:

```ts
GetUserRow | null
```

A runnable version belongs in `examples/d1-worker/`. The guide should link to that example rather than grow a second, slightly different application.

---

## `docs/generated-code-tour.md`

# Generated-code tour

This page explains the generated TypeScript in plain language. You do not need to edit generated files.

The tour uses one query all the way through:

```sql
-- name: GetUser :one
SELECT id, name
FROM users
WHERE id = sqlc.arg(id);
```

### 1. Public argument and row types

```ts
export interface GetUserArgs { // [1]
  id: number;                  // [2]
}

export interface GetUserRow {  // [3]
  id: number;
  name: string;
}
```

1. `GetUserArgs` describes the object accepted by `getUser(...)`.
2. `id` is a safe integer because sqlc analyzed it as a SQLite integer.
3. `GetUserRow` describes the public object returned after row mapping.

Simple rule: **sqlc supplies the database facts; the Plugin turns those facts into TypeScript promises.**

### 2. The query factory

```ts
const query = getUser({ id: 42 }); // [1]
```

1. The factory checks the argument and returns an immutable **query descriptor**. It does not execute SQL.

Conceptually, the private descriptor contains:

```ts
{
  kind: "one",                              // How to shape the result.
  sql: "SELECT id, name FROM users ...",   // Exact SQL data, safely escaped.
  params: [42],                             // A snapshot of bind values.
  parse: parseGetUserRow,                   // The private row mapper.
}
```

This object is a teaching picture, not a public type. Application code creates descriptors only through generated factories and should not inspect their private shape.

Why separate construction from execution? The same checked descriptor can be executed directly, included in a heterogeneous batch, or executed through a session.

### 3. The query executor

```ts
const db = new DB(env.DB);                   // [1]
const user = await db.execute(query);        // [2]
```

1. `DB` is a **query executor** backed by the Worker's `D1Database` binding.
2. `execute` prepares and binds the descriptor, asks D1 to run it, then maps the native result into `GetUserRow | null`.

The executor does not become a repository object with methods such as `db.getUser()`. Generated query factories stay in query modules; execution stays in the shared runtime.

### 4. Row mapping

Suppose D1 returns:

```ts
{ id: 42, name: "Ada", ignored_extra_field: true }
```

The private mapper:

1. requires `id` and `name` to exist;
2. checks that `id` is a safe integer and `name` is a string;
3. ignores unexpected physical fields;
4. creates a fresh public object:

```ts
{ id: 42, name: "Ada" }
```

This is **row mapping**, not a TypeScript type assertion. Bad stored data can therefore produce a `QueryResultError` instead of silently violating the generated type.

### 5. Result types come from the command

```ts
await db.execute(getUser({ id: 42 })); // GetUserRow | null (:one)
await db.execute(listUsers());         // ListUsersRow[]    (:many)
await db.execute(deleteUser({ id: 42 })); // void           (:exec)
```

The query reference holds the complete six-command table. The tour shows only enough examples to explain the mechanism.

### 6. A heterogeneous batch

```ts
const [user, users, changes] = await db.batch(
  getUser({ id: 42 }),
  listUsers(),
  renameUser({ id: 42, name: "Ada" }),
);
```

TypeScript keeps the result type for each position. One call maps to one atomic native D1 batch. If native D1 execution succeeds but generated row mapping later fails, writes may already be committed and no partial public tuple is returned.

### 7. A session and transferable bookmark

```ts
const session = db.withSession("first-primary");
await session.execute(renameUser({ id: 42, name: "Ada" }));
const bookmark = session.getBookmark();
```

The **session executor** belongs to one request flow. Transfer the opaque **session bookmark** across requests; do not store the live executor in module-global state.

### 8. Where errors happen

```text
getUser({ id: unsafeNumber })
└── QueryArgumentError (synchronous; D1 was not called)

await db.execute(getUser({ id: 42 }))
├── native D1 rejection (passed through unchanged)
└── QueryResultError (D1 succeeded; local result mapping failed)
```

A `QueryResultError` after a write does not mean the write rolled back. Do not retry only because result mapping failed.

### End-of-tour mental model

```text
sqlc metadata
    ↓ generation
public types + query factory + private mapper
    ↓ factory call (synchronous validation)
immutable query descriptor
    ↓ DB or session executor
native D1 result
    ↓ checked row mapping
public typed result
```

---

## `docs/query-reference.md`

# Query reference

Keep lookup facts compact. Link to focused examples instead of reteaching the generated-code model.

### Commands

| Command | `execute(...)` result |
|---|---|
| `:one` | generated row or `null` |
| `:many` | generated row array |
| `:exec` | `void` |
| `:execrows` | affected-row count |
| `:execlastid` | last inserted safe integer ID |
| `:execresult` | complete native `D1Result<Record<string, unknown>>` |

Unsupported commands fail generation; the Plugin never silently approximates or omits them.

### Macros

| Macro | Public shape | Important edge |
|---|---|---|
| `sqlc.arg(name)` | required scalar property | repeated uses remain one property |
| `sqlc.narg(name)` | required `T | null` property | `undefined` and omission are invalid |
| `sqlc.slice(name)` | `ReadonlyArray<T>` property | an empty slice throws synchronously |
| `sqlc.embed(table)` | nested table-shaped row object | outer-join embeds stay objects with nullable fields |

Each row links to one minimal SQL → generated type → invocation example.

---

## `docs/runtime-and-errors.md`

# Runtime and errors

Organize this page by operational question:

1. Which values can I bind?
2. How are SQLite values mapped?
3. How do atomic heterogeneous batches behave?
4. How do D1 sessions and bookmarks behave?
5. Which generated error can happen at each phase?
6. When might a write already be committed?

Keep security-sensitive logging guidance beside the errors: generated diagnostics do not include complete SQL, bound values, rows, or session bookmarks by default.

---

## `docs/compatibility.md`

# Compatibility

Separate consumer support from release evidence:

| Component | Published statement |
|---|---|
| sqlc | supported floor, tested versions, named tested ceiling |
| Workers types | exact version used by release tests; not a consumer runtime dependency |
| Wrangler / Miniflare | exact locked test versions; not consumer constraints |
| Workers runtime | tested compatibility date and flags |
| managed D1 | remote-test date, covered behaviors, and known exceptions |

Do not claim that a managed D1 service or SQLite engine version is pinned.

---

## `docs/troubleshooting.md`

# Troubleshooting

Lead with stable diagnostic identifiers so readers can search the page:

```text
[OPTIONS/UNKNOWN_OPTION]
[COMPATIBILITY/UNTESTED_SQLC_VERSION]
[QUERY/UNSUPPORTED_COMMAND]
[EMISSION/OUTPUT_PATH_COLLISION]
```

Each entry has:

1. what the identifier means;
2. one small failing input;
3. one corrected input;
4. whether generation stopped or continued with a warning.

---

## Rules against documentation drift

- One canonical runnable Worker lives in `examples/d1-worker/`.
- README and guides use small excerpts; they link to the canonical example for the full application.
- The six-command and four-macro tables have one canonical home in `query-reference.md`.
- The generated-code tour owns the conceptual descriptor picture and execution pipeline.
- Release-specific artifact hashes and tested versions come from the GitHub release; evergreen docs explain where to find them.
- Generated files remain marked “do not edit”; annotations are shown around excerpts, not added to generated output.
- A migration page exists only when an actual released API change needs one.

---

## Review questions

### Q1 — Which information architecture should the release use?

- **A:** one linear README;
- **B:** a fast-path README plus getting-started guide, generated-code tour, and focused references;
- **C:** a generated-code-first handbook.

**Recommendation: B.** Example: an experienced user can copy the YAML and first Worker snippet from the README, while a maintainer follows the separate `sqlc metadata → descriptor → executor → row mapper` tour.

### Q2 — How should the generated-code walkthrough annotate TypeScript?

- **A:** comments on nearly every line;
- **B:** valid code excerpts with a few numbered markers and plain-language notes below;
- **C:** prose first, followed by unannotated code.

**Recommendation: B.** Example:

```ts
const query = getUser({ id: 42 }); // [1]
const user = await db.execute(query); // [2]
```

1. Builds and checks a descriptor; no D1 call yet.
2. Calls D1 and maps the native result.

### Q3 — What should the runnable example optimize for?

- **A:** one small progressive `users` example used throughout the docs;
- **B:** a feature matrix with one isolated example per command, macro, batch, and session;
- **C:** a realistic multi-table application that demonstrates everything together.

**Recommendation: A for the teaching path, with focused fixtures for exhaustive verification.** Example: `GetUser`, `ListUsers`, and `RenameUser` are enough to teach `:one`, `:many`, `:execrows`, batching, sessions, nullability, and errors without making readers learn a product domain.

### Q4 — How much private generated machinery should human docs show?

- **A:** none; document only public calls;
- **B:** one clearly labelled conceptual descriptor plus the mapping pipeline;
- **C:** exact generated private interfaces and mapper implementations.

**Recommendation: B.** Example: show `{ kind, sql, params, parse }` as a teaching picture and state that its exact representation is private. This explains why factories, batches, and checked row mapping work without turning private code into an accidental compatibility promise.
