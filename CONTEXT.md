# sqlc D1 TypeScript

A sqlc code-generation plugin that produces type-safe TypeScript for executing analyzed SQLite queries through Cloudflare Workers D1 bindings.

## Language

**Plugin**:
The sqlc WASM component that translates sqlc’s analyzed SQLite query metadata into D1-oriented TypeScript.
_Avoid_: Extension, driver

**Workers binding interface**:
The supported integration boundary in which generated code executes through a Cloudflare Worker’s `D1Database` or D1 session binding.
_Avoid_: D1 HTTP API, Node SQLite interface

**Query descriptor**:
A typed description of one generated query invocation that can be passed to a query executor individually or in a batch.
_Avoid_: Executed query, prepared statement

**Query executor**:
The generated runtime-facing API that executes query descriptors through a D1 database or session binding.
_Avoid_: Database driver

**Session executor**:
A request-flow-local query executor backed by a D1 session, providing D1 session consistency and access to the latest session bookmark.
_Avoid_: Persistent session, transaction

**Session bookmark**:
An opaque D1 string transferred between session executors to continue a consistency constraint across requests.
_Avoid_: Session executor, authentication token

**Compatibility surface**:
The sqlc SQLite commands, macros, metadata shapes, and D1 value representations that the plugin promises to translate correctly.
_Avoid_: Every SQLite feature

**Bind value**:
A TypeScript value accepted by a query factory for conversion to a parameter representation supported by the Workers binding interface.
_Avoid_: Arbitrary JavaScript value

**Row mapping**:
The compatibility-surface conversion from a D1 result object's physical fields into a generated public query row.
_Avoid_: Type assertion

**Release gate**:
The explicit evidence and checks required before publishing a plugin release as trustworthy for experienced sqlc and Cloudflare users.
_Avoid_: Done, production-ready

**Publication candidate**:
The exact plugin WASM bytes selected for a version and evaluated by the release gate before becoming publicly advertised.
_Avoid_: Rebuild, latest build

**Published artifact**:
A publication candidate made available at its permanent versioned URL and identified by its SHA-256.
_Avoid_: Latest artifact, replaceable release

**Version key**:
The permanent object-storage key assigned to one plugin version; retries may confirm its bytes but never replace them.
_Avoid_: Latest key, release channel

**Release record**:
The public metadata that connects a version and source commit to the published artifact's URL and SHA-256.
_Avoid_: Artifact, changelog alone
