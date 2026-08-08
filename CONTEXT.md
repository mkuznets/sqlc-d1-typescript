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

**Compatibility surface**:
The sqlc SQLite commands, macros, metadata shapes, and D1 value representations that the plugin promises to translate correctly.
_Avoid_: Every SQLite feature

**Release gate**:
The explicit evidence and checks required before publishing a plugin release as trustworthy for experienced sqlc and Cloudflare users.
_Avoid_: Done, production-ready
