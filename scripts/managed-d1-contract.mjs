#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";

export const MANAGED_SCENARIO_IDS = Object.freeze([
  "managed-d1/value-command-metadata",
  "managed-d1/macro-smoke",
  "managed-d1/batch-success",
  "managed-d1/batch-rollback",
  "managed-d1/direct-session",
  "managed-d1/bookmark-transfer",
  "managed-d1/native-error-identity",
  "managed-d1/post-execution-result-error",
]);
export const RESOURCE_NAME_PATTERN = /^sqlc-d1-ci-(\d{8}[Tt]\d{6}[Zz])-([1-9]\d*)-([1-9]\d*)-([0-9a-f]{8})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_KEYS =
  /^(?:sql|sqlSource|params|values|rows|bookmark|authorization|token|credentials|headers|stack|cause|responseBody)$/i;

function fail(message) {
  const error = new Error(message);
  error.exitCode = 2;
  throw error;
}

function exactUtc(text) {
  if (!/^\d{8}[Tt]\d{6}[Zz]$/.test(text)) return null;
  const normalized = text.toUpperCase();
  const iso = `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}T${normalized.slice(9, 11)}:${normalized.slice(11, 13)}:${normalized.slice(13, 15)}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.valueOf()) || compactTimestamp(date) !== text.toLowerCase() ? null : date;
}

export function compactTimestamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .toLowerCase();
}

export function formatManagedResourceName({
  now = new Date(),
  runId,
  attempt,
  randomHex = randomBytes(4).toString("hex"),
}) {
  const name = `sqlc-d1-ci-${compactTimestamp(now)}-${runId}-${attempt}-${randomHex}`;
  if (!parseManagedResourceName(name) || name.length > 63)
    fail("managed resource name is invalid or exceeds 63 characters");
  return name;
}

export function parseManagedResourceName(name) {
  const match = typeof name === "string" ? RESOURCE_NAME_PATTERN.exec(name) : null;
  if (!match || name.length > 63) return null;
  const createdAt = exactUtc(match[1]);
  if (!createdAt) return null;
  return { name, createdAt, runId: match[2], attempt: match[3], randomHex: match[4], grammarVersion: 1 };
}

export function initialResourceState({ name, candidateSha256, createdAt = new Date().toISOString() }) {
  if (!parseManagedResourceName(name)) fail("resource state name does not match reserved grammar");
  return {
    grammarVersion: 1,
    candidateSha256,
    createdAt,
    database: { status: "not-created", name },
    worker: { status: "not-created", name },
  };
}

export function stableJson(value) {
  const sort = (item) =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sort(item[key])]),
          )
        : item;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export async function writePrivateJson(path, value) {
  await writeFile(resolve(path), stableJson(value), { mode: 0o600 });
  await chmod(resolve(path), 0o600);
}

function inspectKeys(value, path = "$") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) fail(`managed evidence contains prohibited field ${path}.${key}`);
    inspectKeys(child, `${path}.${key}`);
  }
}

function same(field, expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    fail(`${field} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

export async function validateManagedD1Evidence({
  evidence,
  path,
  candidateSha256,
  sourceCommit,
  runId,
  runUrl,
  trigger,
  config,
  root = process.cwd(),
  requirePassing = false,
}) {
  let value = evidence;
  if (path) {
    try {
      value = JSON.parse(await readFile(resolve(path), "utf8"));
    } catch {
      fail(`managed evidence ${path} is malformed or unreadable`);
    }
  }
  inspectKeys(value);

  const schema = JSON.parse(await readFile(resolve(root, "verification/managed-d1-evidence.schema.json"), "utf8"));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  if (!validate(value)) fail(`managed evidence schema mismatch: ${JSON.stringify(validate.errors)}`);

  same(
    "managed scenario set",
    MANAGED_SCENARIO_IDS,
    value.scenarios.map(({ id }) => id),
  );
  if (new Set(value.scenarios.map(({ id }) => id)).size !== MANAGED_SCENARIO_IDS.length)
    fail("managed scenario IDs must be unique");
  const testStatus = value.scenarios.some(({ status }) => status === "ambiguous")
    ? "ambiguous"
    : value.scenarios.every(({ status }) => status === "passed")
      ? "passed"
      : "failed";
  same("managed test.status", testStatus, value.test.status);

  const cleanupConfirmed = [value.cleanup.worker, value.cleanup.database].every(
    (status) => status === "deleted" || status === "not-created",
  );
  same("managed cleanup.status", cleanupConfirmed ? "confirmed" : "failed", value.cleanup.status);
  for (const kind of ["worker", "database"]) {
    if (value.resources[kind].status === "not-created")
      same(`managed cleanup.${kind}`, "not-created", value.cleanup[kind]);
    else if (!["deleted", "failed"].includes(value.cleanup[kind]))
      fail(`managed cleanup.${kind} is inconsistent with a created resource`);
  }

  same("managed run.remoteDate", value.run.completedAt.slice(0, 10), value.run.remoteDate);
  if (Date.parse(value.run.startedAt) > Date.parse(value.run.completedAt))
    fail("managed run completion precedes start");

  for (const [kind, resource] of Object.entries(value.resources)) {
    if (!parseManagedResourceName(resource.name)) fail(`managed ${kind} name is invalid`);
    if (kind === "worker" && resource.status === "created" && resource.id !== resource.name)
      fail("managed Worker id must equal exact script name");
    if (kind === "database" && resource.status === "created" && !UUID.test(resource.id))
      fail("managed database id must be a UUID");
  }

  if (candidateSha256) same("managed candidateSha256", candidateSha256, value.candidateSha256);
  if (sourceCommit) same("managed sourceCommit", sourceCommit, value.sourceCommit);
  if (runId) same("managed run.id", runId, value.run.id);
  if (runUrl) same("managed run.url", runUrl, value.run.url);
  if (trigger) same("managed run.trigger", trigger, value.run.trigger);
  if (config) {
    same(
      "managed configuration",
      {
        compatibilityDate: config.cloudflare.compatibilityDate,
        compatibilityFlags: config.cloudflare.compatibilityFlags,
        wranglerVersion: config.cloudflare.wrangler,
      },
      value.configuration,
    );
  }

  if (value.failure && value.test.status === "passed")
    fail("managed evidence records a failure but reports passing scenarios");

  if (requirePassing && (value.test.status !== "passed" || value.cleanup.status !== "confirmed"))
    fail(
      value.failure
        ? `managed evidence records a failure during ${value.failure.phase}: ${value.failure.detail}`
        : `managed evidence does not record passed scenarios and confirmed primary cleanup (scenarios: ${value.test.status}, cleanup: ${value.cleanup.status})`,
    );
  return value;
}

async function cli() {
  const [command, ...rest] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, "")] = rest[i + 1];
  if (command !== "validate-evidence")
    fail("usage: managed-d1-contract.mjs validate-evidence --path FILE [--sha256 SHA]");

  const config = JSON.parse(await readFile(resolve("verification/compatibility.json"), "utf8"));
  let evidence;
  try {
    evidence = JSON.parse(await readFile(resolve(args.path), "utf8"));
  } catch {
    evidence = undefined;
  }
  if (evidence) {
    process.stdout.write(`    scenarios: ${evidence.test?.status}, cleanup: ${evidence.cleanup?.status}\n`);
    for (const scenario of evidence.scenarios ?? [])
      process.stdout.write(`    ${String(scenario.status).padEnd(9)} ${scenario.id}\n`);
    if (evidence.failure)
      process.stdout.write(`    reported failure during ${evidence.failure.phase}: ${evidence.failure.detail}\n`);
  }

  await validateManagedD1Evidence({
    path: args.path,
    candidateSha256: args.sha256,
    sourceCommit: args["source-commit"],
    runId: args["run-id"],
    config,
    requirePassing: args.passing === "true",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void cli().catch((error) => {
    const message = String(error?.message ?? error);
    process.stdout.write(
      process.env.GITHUB_ACTIONS ? `::error::${message.replace(/\r?\n/g, "%0A")}\n` : `${message}\n`,
    );
    process.exitCode = error.exitCode ?? 1;
  });
