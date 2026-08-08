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

### B. Fast path plus a public code tour and focused guides — selected

```text
README.md                         install and one end-to-end query in a Worker
examples/d1-worker/              runnable canonical example
docs/
├── generated-code-tour.md       simple annotations of the public TypeScript
├── sqlc-to-d1.md                general rules for how sqlc metadata maps to D1
├── runtime-and-errors.md        batches, sessions, values, errors, retry warning
├── compatibility.md             tested versions and D1 evidence
└── troubleshooting.md           generation diagnostics and common failures
```

Add `docs/migrating.md` only when a release has an actual migration to explain. Release-specific versions, hashes, compatibility evidence, and changes also live in that GitHub release.

**Feels like:** a complete fast path in the README with progressively deeper guides.

**Strength:** experienced users reach a working query without following another page. The code tour teaches only the generated public contract. `sqlc-to-d1.md` explains this Plugin's general translation rules while linking to sqlc for sqlc syntax and reference material.

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
| Understand sqlc-to-D1 mapping | Weak | **Best** | Fair |
| Keep release facts current | Weak | **Good** | Fair |
| Avoid duplicating explanations | Weak | **Good** | Good |

---

# Rendered sample of structure B

The following is a rough composite. The README contains the complete first-use path; headings marked with another file name would live in separate guides.

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

### Add one query

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  nickname TEXT
);

-- name: GetUser :one
SELECT id, name, nickname
FROM users
WHERE id = sqlc.arg(id);
```

`:one` and `sqlc.arg` are sqlc features. The Plugin uses sqlc's analyzed metadata to generate the D1-facing TypeScript shown below.

Run `sqlc generate`, then execute the generated query:

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

The returned value has type `GetUserRow | null`. A runnable version belongs in `examples/d1-worker/`; the README links there instead of maintaining a second full application.

- Learn the public generated API in [Generated-code tour](docs/generated-code-tour.md).
- Learn the Plugin's translation rules in [How sqlc maps to D1](docs/sqlc-to-d1.md).
- Look up operational behavior in [Runtime and errors](docs/runtime-and-errors.md).

---

## `docs/generated-code-tour.md`

# Generated-code tour

This page explains the public generated TypeScript in plain language. It documents only public types and calls; it does not show private descriptor fields, row-mapper code, or other generated internals. You do not need to edit generated files.

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

The descriptor is opaque: application code creates it through a generated factory and passes it to an executor. Human documentation does not show or describe its private fields.

Why separate construction from execution? The same checked descriptor can be executed directly, included in a heterogeneous batch, or executed through a session.

### 3. The query executor

```ts
const db = new DB(env.DB);                   // [1]
const user = await db.execute(query);        // [2]
```

1. `DB` is a **query executor** backed by the Worker's `D1Database` binding.
2. `execute` prepares and binds the descriptor, asks D1 to run it, then maps the native result into `GetUserRow | null`.

The executor does not become a repository object with methods such as `db.getUser()`. Generated query factories stay in query modules; execution stays in the shared runtime.

### 4. Checked results

```ts
const user = await db.execute(getUser({ id: 42 })); // [1]
```

1. The public result is a fresh `GetUserRow | null`. The Plugin checks required fields and their expected SQLite/D1 value shapes before returning it. If stored data contradicts the generated contract, execution rejects with `QueryResultError` instead of returning a value that violates the TypeScript type.

The private checking code is intentionally absent from human documentation; only its observable guarantee and errors are public.

### 5. Result types come from the command

```ts
await db.execute(getUser({ id: 42 })); // GetUserRow | null (:one)
await db.execute(listUsers());         // ListUsersRow[]    (:many)
await db.execute(deleteUser({ id: 42 })); // void           (:exec)
```

[How sqlc maps to D1](sqlc-to-d1.md) explains the general result-shaping rule and the Plugin's supported compatibility surface. It links to sqlc's documentation for command syntax.

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
sqlc-analyzed query
    ↓ generation
public types + query factory
    ↓ factory call (synchronous validation)
opaque query descriptor
    ↓ DB or session executor
public typed result
```

---

## `docs/sqlc-to-d1.md`

# How sqlc maps to D1

This is not a sqlc query reference. Link to sqlc's documentation for command and macro syntax. This page explains the general translation performed by this Plugin:

1. **sqlc owns analysis.** The Plugin consumes sqlc's SQLite query, parameter, column, command, nullability, and macro metadata; it does not parse SQL again.
2. **Commands choose the public result shape.** Row commands become a row-or-null or row-array result. Execution commands become `void`, affected rows, last inserted ID, or the complete native D1 result according to the sqlc annotation.
3. **Parameter metadata becomes checked factory input.** Named and nullable parameters become required object properties; slices become immutable array inputs. `null` is a SQL value, while omission and `undefined` are not.
4. **Column metadata becomes checked public rows.** The Plugin maps SQLite/D1 storage values into generated TypeScript values, preserves sqlc nullability, and builds nested objects for embedded results.
5. **The compatibility surface is explicit.** The six supported ordinary SQLite commands and four supported macros are named here so consumers know the boundary, but their syntax is not retaught. Unknown commands and ambiguous metadata fail generation rather than being approximated.

Use small contrastive examples to teach each rule:

```ts
getUser({ id: 42 });                  // required scalar
renameUser({ nickname: null });       // required nullable value
getUsers({ ids: [1, 2, 3] });         // slice
```

Then summarize the Plugin-specific outcomes in compact tables, with links out to sqlc for syntax and links inward to runtime behavior for D1 value checks, errors, batching, and sessions.

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
- sqlc owns command and macro syntax documentation; `sqlc-to-d1.md` owns only this Plugin's general translation rules and explicit compatibility boundary.
- The generated-code tour shows only public generated types and calls. Private descriptor and row-mapper machinery stays undocumented.
- Release-specific artifact hashes and tested versions come from the GitHub release; evergreen docs explain where to find them.
- Generated files remain marked “do not edit”; annotations are shown around excerpts, not added to generated output.
- A migration page exists only when an actual released API change needs one.

---

## Review questions

### Q1 — Which information architecture should the release use? — selected

**Selected:** a fast-path README containing the complete getting-started path, plus a public generated-code tour and focused guides. Example: an experienced user can copy the YAML, define one query, and run the first Worker snippet without leaving the README.

### Q2 — How should the generated-code walkthrough annotate TypeScript? — selected

**Selected:** valid code excerpts with a few numbered markers and plain-language notes below. Example:

```ts
const query = getUser({ id: 42 }); // [1]
const user = await db.execute(query); // [2]
```

1. Builds and checks a descriptor; no D1 call yet.
2. Calls D1 and maps the native result.

### Q3 — What should the runnable example optimize for? — selected

**Selected:** one small progressive `users` example for the teaching path, with focused fixtures for exhaustive verification. Example: `GetUser`, `ListUsers`, and `RenameUser` teach result shapes, batching, sessions, nullability, and errors without making readers learn a product domain.

### Q4 — How much private generated machinery should human docs show? — selected

**Selected:** none; document only public types, calls, guarantees, and errors. Example: say that `getUser({ id: 42 })` returns an opaque query descriptor which `db.execute(...)` accepts, without showing `{ kind, sql, params, parse }` or private row-mapper code.
