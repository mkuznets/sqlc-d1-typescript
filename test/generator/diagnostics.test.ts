import assert from "node:assert/strict";
import test from "node:test";
import {
  internalPluginFailure,
  quoteDiagnosticValue,
  renderFailureDiagnostics,
  renderWarningDiagnostics,
  sortDiagnostics,
  type Diagnostic,
} from "../../src/diagnostics";

test("diagnostic values are quoted on one safe line", () => {
  assert.equal(
    quoteDiagnosticValue('a"b\\c\n\r\t\u0000\u001b\u0085\u2028\u2029'),
    '"a\\"b\\\\c\\n\\r\\t\\u0000\\u001b\\u0085\\u2028\\u2029"',
  );
});

test("failure diagnostics are deterministically sorted and formatted", () => {
  const findings: Diagnostic[] = [
    { severity: "warning", category: "COMPATIBILITY", reason: "UNTESTED_SQLC_VERSION", message: "future" },
    { severity: "error", category: "QUERY", reason: "MISSING_NAME", message: "second", filename: "b.sql", queryIndex: 1 },
    { severity: "error", category: "OPTIONS", reason: "UNKNOWN_OPTION", message: "first" },
  ];
  assert.deepEqual(sortDiagnostics(findings).map((finding) => finding.reason), [
    "UNKNOWN_OPTION", "UNTESTED_SQLC_VERSION", "MISSING_NAME",
  ]);
  assert.equal(renderFailureDiagnostics(findings), `sqlc-d1-typescript: generation failed with 2 errors and 1 warning

Errors:
[OPTIONS/UNKNOWN_OPTION]
first

[QUERY/MISSING_NAME] file "b.sql", query position 2:
second

Warnings:
[COMPATIBILITY/UNTESTED_SQLC_VERSION]
future
`);
});

test("warning-only and internal diagnostics are safe", () => {
  const warning: Diagnostic = { severity: "warning", category: "COMPATIBILITY", reason: "UNTESTED_SQLC_VERSION", message: "future" };
  assert.equal(renderWarningDiagnostics([warning]), `sqlc-d1-typescript: generation completed with 1 warning

Warnings:
[COMPATIBILITY/UNTESTED_SQLC_VERSION]
future
`);
  const internal = internalPluginFailure(new Error("secret\nstack"));
  assert.equal(internal.category, "INTERNAL");
  assert.equal(internal.reason, "PLUGIN_FAILURE");
  assert.doesNotMatch(internal.message, /secret|stack/);
  assert.match(internal.message, /development/);
});
