# Runtime, batches, sessions, and errors

The generated runtime executes opaque query descriptors through a Cloudflare Workers `D1Database` or D1 session binding. Its public surface is generated alongside your queries; there is no separate JavaScript runtime package.

## Construct and reuse descriptors

A generated factory validates bind values synchronously and returns a query descriptor. D1 is not called during construction. Mutable BLOB and slice input is copied, so a successfully constructed descriptor can be reused without observing later mutations of caller-owned inputs.

Do not inspect, forge, serialize, or persist descriptors. Regenerate rather than depending on their representation.

## Bind and row values

| Kind | Accepted bind | Checked row mapping |
|---|---|---|
| integer | safe-integer `number` | safe-integer `number` |
| real/numeric | finite `number` | finite `number` |
| text/date/time | `string` | `string` |
| boolean | `boolean` | physical integer `0` or `1` only |
| BLOB | `Uint8Array` (copied) | copied `Uint8Array` from D1 byte representations |
| JSON | `JsonValue`, serialized | parsed `unknown` |
| unknown | `D1NonNullValue` / `D1Value` | `unknown` |

Rows are fresh public objects. Missing fields, malformed JSON, unsafe metadata numbers, and contradictory physical values fail closed with `QueryResultError`.

## Direct execution and side effects

`execute()` performs one native D1 operation, then maps the native result. A native rejection happens before successful local result mapping. A local mapping failure happens **after D1 returned successfully**, so writes may already have effects.

## Batch shapes

`batch()` requires a statically non-empty tuple and uses one native atomic D1 batch call.

### Static heterogeneous shape

<!-- compile: runtime-static-batch -->
```ts
import { DB } from "./runtime";
import {
  getUser,
  listUsers,
  renameUser,
  type GetUserRow,
  type ListUsersRow,
  type RenameUserRow,
} from "./queries_sql";

declare const binding: D1Database;
const result: [GetUserRow | null, ListUsersRow[], RenameUserRow | null] =
  await new DB(binding).batch(
    getUser({ id: 1 }),
    listUsers(),
    renameUser({ name: "Ada", id: 1 }),
  );
```

Use this when each position is statically known; the result tuple preserves exact positional types.

### Meaningful head with a dynamic homogeneous side-effect tail

<!-- compile: runtime-dynamic-tail -->
```ts
import { DB, type QueryDescriptor } from "./runtime";
import { getUser, type GetUserRow } from "./queries_sql";

declare const binding: D1Database;
declare const updateUsers: QueryDescriptor<void>[];

const [user]: [GetUserRow | null, ...void[]] =
  await new DB(binding).batch(getUser({ id: 1 }), ...updateUsers);

void user;
```

The stable head satisfies non-emptiness and preserves its meaningful result. Explicitly annotate the tail as `QueryDescriptor<void>[]`; this pattern is for dynamic homogeneous side effects.

### Dynamic heterogeneous results

A fully dynamic `QueryDescriptor<unknown>[]` has neither a statically known non-empty head nor precise positional types. If callers consume different result positions, branch into statically typed batch calls. Do not cast an arbitrary array into a tuple.

## Native atomicity and local mapping

D1 defines native batch atomicity: if a native statement fails, the native batch rejects. Only after native success does the generated runtime map all results. If any mapping fails, the public promise rejects and no partial result tuple is exposed, but local TypeScript code cannot undo native effects.

**Never retry a write or batch solely because `QueryResultError` occurred.** Determine whether the operation is idempotent or reconcile state using an application-specific key first.

## Sessions and bookmarks

<!-- compile: runtime-session -->
```ts
import { DB } from "./runtime";
import { getUser } from "./queries_sql";

declare const binding: D1Database;
declare const bookmarkFromPreviousRequest: string | undefined;

const session = new DB(binding).withSession(bookmarkFromPreviousRequest);
const user = await session.execute(getUser({ id: 1 }));
const bookmarkForNextRequest: string | null = session.getBookmark();
void [user, bookmarkForNextRequest];
```

`withSession()` accepts no argument, `"first-primary"`, `"first-unconstrained"`, or an opaque bookmark string. The Plugin delegates routing and bookmark behavior to D1; it does not parse or retain bookmarks.

Keep a session executor request-flow-local. Await operations in the order your flow requires. The runtime does not serialize concurrent calls. Transfer only the opaque bookmark string across requests, and do not describe a session as a transaction or infer commit/rollback guarantees.

## Public error classes

| Error | Phase | Meaning | Was D1 called? |
|---|---|---|---|
| `SqlcD1Error` | base class | common stable context and `Error` identity | depends on subclass |
| `QueryArgumentError` | descriptor construction | a bind value or required argument shape is invalid | no |
| `QueryUsageError` | construction/executor use | invalid descriptor, empty batch, or invalid session input | normally no native operation; see context |
| `QueryResultError` | post-native mapping | D1 returned successfully but rows or metadata contradicted the generated contract | yes |
| native D1 error | native execution | D1 rejected prepare/bind/run/batch behavior | attempted; unchanged identity |

`SqlcD1Error` exposes safe structural context where applicable: `operation`, `queryName`, `batchIndex`, `rowIndex`, `path`, `expected`, `received`, and `cause`. A native D1 error is not wrapped and does not become `SqlcD1Error`.

## Diagnostics and logging

Log the selected Plugin/release version and SHA-256, sqlc version, public error class, and safe context fields. Do not automatically log SQL, bind values, returned rows, bookmarks, credentials, authorization headers, or production identifiers. Treat `cause` as untrusted and potentially sensitive before logging it.

See [troubleshooting](troubleshooting.md) for phase-based triage and [compatibility](compatibility.md) for evidence boundaries.
