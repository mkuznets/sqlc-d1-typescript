#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { readCandidate } from "./candidate-utils.mjs";
import { generateCandidate } from "./generate-candidate.mjs";
import { loadCompatibilityConfig } from "./compatibility-config.mjs";
import {
  MANAGED_SCENARIO_IDS,
  formatManagedResourceName,
  initialResourceState,
  validateManagedD1Evidence,
  writePrivateJson,
} from "./managed-d1-contract.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function commandRunner(command, args, options = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      input: undefined,
      stdio: options.stdin === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (v) => (stdout += v));
    child.stderr.on("data", (v) => (stderr += v));
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    }
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? ok({ stdout, stderr }) : fail(new Error(`${command} operation failed with exit ${code}`)),
    );
  });
}

function testStatus(scenarios) {
  return scenarios.some(({ status }) => status === "ambiguous")
    ? "ambiguous"
    : scenarios.every(({ status }) => status === "passed")
      ? "passed"
      : "failed";
}

export function parseD1CreateJson(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("D1 create returned malformed JSON");
  }
  const id = value.uuid ?? value.result?.uuid;
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("D1 create JSON did not contain a valid UUID");
  return id;
}

async function createManagedD1Database({ accountId, token, name, fetchImpl }) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(`D1 create failed with HTTP ${response.status}`);
  return parseD1CreateJson(await response.text());
}

async function initializeManagedD1Database({ accountId, token, databaseId, schema, fetchImpl }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const statements = schema
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const sql of statements) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    if (!response.ok) throw new Error(`D1 schema setup failed with HTTP ${response.status}`);
    const body = await response.json();
    if (!body.success || !Array.isArray(body.result) || body.result.some((result) => result?.success !== true))
      throw new Error("D1 schema setup did not succeed");
  }
}

export async function stageManagedD1({
  candidate,
  sha256,
  sqlc = "sqlc",
  output,
  root = process.cwd(),
  run = commandRunner,
}) {
  await readCandidate(candidate, sha256);
  const stage = resolve(output);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await cp(resolve(root, "test/miniflare"), resolve(stage, "test/miniflare"), {
    recursive: true,
    filter: (source) => !/[\\/](?:node_modules|\.wrangler)(?:[\\/]|$)/.test(source),
  });
  await cp(resolve(root, "test/managed-d1"), resolve(stage, "test/managed-d1"), { recursive: true });
  await mkdir(resolve(stage, "scripts"));
  await cp(resolve(root, "scripts/managed-d1-contract.d.mts"), resolve(stage, "scripts/managed-d1-contract.d.mts"));
  await cp(resolve(root, "tsconfig.json"), resolve(stage, "tsconfig.json"));
  await symlink(resolve(root, "node_modules"), resolve(stage, "node_modules"));
  await generateCandidate({ candidate, sha256, config: "sqlc.yaml", cwd: resolve(stage, "test/miniflare"), sqlc });
  const tsc = resolve(root, "node_modules/typescript/bin/tsc");
  await run(process.execPath, [tsc, "-p", resolve(stage, "test/managed-d1/tsconfig.json"), "--noEmit"], { cwd: stage });
  return stage;
}

async function cleanupExact({ state, accountId, token, fetchImpl }) {
  const result = {
    worker: state.worker.status === "created" ? "failed" : "not-created",
    database: state.database.status === "created" ? "failed" : "not-created",
    emergencyRecovery: "not-needed",
  };
  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const headers = { authorization: `Bearer ${token}` };
  if (state.worker.status === "created")
    try {
      const url = `${api}/workers/scripts/${encodeURIComponent(state.worker.id)}`;
      const response = await fetchImpl(url, { method: "DELETE", headers });
      if (!response.ok) throw new Error();
      const absent = await fetchImpl(`${url}/settings`, { headers });
      if (absent.status !== 404) throw new Error();
      result.worker = "deleted";
    } catch {}

  if (state.database.status === "created")
    try {
      const url = `${api}/d1/database/${state.database.id}`;
      const response = await fetchImpl(url, { method: "DELETE", headers });
      if (!response.ok) throw new Error();
      const absent = await fetchImpl(url, { headers });
      if (absent.status !== 404) throw new Error();
      result.database = "deleted";
    } catch {}

  return {
    status: [result.worker, result.database].every((v) => v === "deleted" || v === "not-created")
      ? "confirmed"
      : "failed",
    ...result,
  };
}

export async function cleanupManagedD1State({
  statePath,
  reportPath,
  accountId,
  token,
  root = process.cwd(),
  fetchImpl = fetch,
  run = commandRunner,
}) {
  const state = JSON.parse(await readFile(resolve(statePath), "utf8"));
  const cleanup = await cleanupExact({ state, accountId, token, fetchImpl });
  const report = {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    resources: { worker: state.worker, database: state.database },
    cleanup,
  };
  await writePrivateJson(reportPath, report);
  return report;
}

function defaultRegisterSignal(handler) {
  const wrapped = () => {
    void handler();
  };
  process.on("SIGTERM", wrapped);
  process.on("SIGINT", wrapped);
  return () => {
    process.off("SIGTERM", wrapped);
    process.off("SIGINT", wrapped);
  };
}

export async function verifyManagedD1(options) {
  const {
    candidate,
    sha256,
    sourceCommit,
    runId,
    runAttempt,
    runUrl,
    trigger,
    accountId,
    token,
    evidencePath,
    statePath,
    sqlc = "sqlc",
    mode = "normal",
    root = process.cwd(),
    fetchImpl = fetch,
    run = commandRunner,
    now = () => new Date(),
    stageImpl = stageManagedD1,
    createDatabaseImpl = createManagedD1Database,
    initializeDatabaseImpl = initializeManagedD1Database,
    registerSignal = defaultRegisterSignal,
    authToken = () => randomBytes(32).toString("base64url"),
    maskSecret = (secret) => {
      if (process.env.GITHUB_ACTIONS) process.stdout.write(`::add-mask::${secret}\n`);
    },
    scenarioTimeoutMs = 30_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;

  const config = await loadCompatibilityConfig({ root });
  await readCandidate(candidate, sha256);
  const wranglerBin = resolve(root, "test/miniflare/node_modules/.bin/wrangler");
  const startedAt = now();
  const name = formatManagedResourceName({ now: startedAt, runId, attempt: runAttempt });
  let state = initialResourceState({ name, candidateSha256: sha256, createdAt: startedAt.toISOString() });
  await writePrivateJson(statePath, state);
  const scenarios = MANAGED_SCENARIO_IDS.map((id) => ({ id, status: "not-run", attempts: 0 }));

  let stage, databaseId;
  let scenarioStarted = false,
    interrupted = false,
    signalCleanupPromise,
    lifecycleTail = Promise.resolve();
  const provision = async (operation) => {
    const current = lifecycleTail.then(operation);
    lifecycleTail = current.then(
      () => {},
      () => {},
    );
    return current;
  };
  const disposeSignals = registerSignal(async () => {
    if (interrupted) return;
    interrupted = true;
    signalCleanupPromise = lifecycleTail.then(async () =>
      cleanupExact({ state: JSON.parse(await readFile(resolve(statePath), "utf8")), accountId, token, fetchImpl }),
    );
    await signalCleanupPromise;
  });
  const checkpoint = () => {
    if (interrupted) throw new Error("managed verification interrupted");
  };

  try {
    stage = await stageImpl({
      candidate,
      sha256,
      sqlc,
      output: await mkdtemp(resolve(tmpdir(), "sqlc-d1-managed-stage-")),
      root,
      run,
    });
    checkpoint();

    await provision(async () => {
      databaseId = await createDatabaseImpl({ accountId, token, name, fetchImpl });
      state = { ...state, database: { status: "created", name, id: databaseId } };
      await writePrivateJson(statePath, state);
    });
    checkpoint();

    const templatePath = resolve(stage, "test/managed-d1/wrangler.template.jsonc");
    let wrangler = await readFile(templatePath, "utf8");
    wrangler = wrangler
      .replaceAll("__RESOURCE_NAME__", name)
      .replace("__DATABASE_ID__", databaseId)
      .replace("__COMPATIBILITY_DATE__", config.cloudflare.compatibilityDate)
      .replace("__COMPATIBILITY_FLAGS__", JSON.stringify(config.cloudflare.compatibilityFlags));
    const configPath = resolve(stage, "test/managed-d1/wrangler.jsonc");
    await writeFile(configPath, wrangler, { mode: 0o600 });
    const schema = await readFile(resolve(stage, "test/miniflare/schema.sql"), "utf8");
    await initializeDatabaseImpl({ accountId, token, databaseId, schema, fetchImpl });
    checkpoint();

    await provision(async () => {
      await run(wranglerBin, ["deploy", "--config", configPath], { cwd: stage });
      state = { ...state, worker: { status: "created", name, id: name } };
      await writePrivateJson(statePath, state);
    });
    checkpoint();
    const auth = authToken();
    maskSecret(auth);
    await run(wranglerBin, ["secret", "put", "SCENARIO_AUTH_TOKEN", "--config", configPath], {
      cwd: stage,
      stdin: auth,
    });
    checkpoint();

    const subdomainResponse = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const subdomainBody = await subdomainResponse.json();
    if (!subdomainResponse.ok || typeof subdomainBody.result?.subdomain !== "string")
      throw new Error("Workers subdomain discovery failed");
    const endpoint = `https://${name}.${subdomainBody.result.subdomain}.workers.dev/scenario`;
    for (const probe of [
      { headers: {} },
      {
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: '{"scenario":"unknown"}',
      },
      {
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: '{"scenario":"managed-d1/batch-success","sql":"x"}',
      },
    ]) {
      const response = await fetchImpl(endpoint, { method: "POST", ...probe });
      if (response.ok) throw new Error("scenario protocol probe was accepted");
    }

    scenarioStarted = true;
    for (const scenario of scenarios) {
      scenario.attempts = 1;
      const controller = new AbortController();
      const timeout = setTimer(() => controller.abort(), scenarioTimeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
          body: JSON.stringify({ scenario: scenario.id }),
          signal: controller.signal,
        });
        const body = await response.json();
        scenario.status = response.ok && body.status === "passed" ? "passed" : "failed";
      } catch {
        scenario.status = "ambiguous";
        break;
      } finally {
        clearTimer(timeout);
      }
      if (scenario.status !== "passed") break;
    }
    if (mode === "simulate-test-failure" && scenarios.every(({ status }) => status === "passed"))
      scenarios[scenarios.length - 1].status = "failed";
  } catch {
    const pending = scenarios.find(({ attempts }) => attempts === 0);
    if (scenarioStarted && pending) {
      pending.attempts = 1;
      pending.status = "ambiguous";
    }
  }

  let evidence;
  await provision(async () => {
    let cleanup = signalCleanupPromise
      ? await signalCleanupPromise
      : mode === "simulate-cleanup-failure"
        ? {
            status: "failed",
            worker: state.worker.status === "created" ? "failed" : "not-created",
            database: state.database.status === "created" ? "failed" : "not-created",
            emergencyRecovery: "not-needed",
          }
        : await cleanupExact({ state, accountId, token, fetchImpl });
    if (cleanup.status === "failed" && mode === "simulate-cleanup-failure") {
      const recovered = await cleanupExact({ state, accountId, token, fetchImpl });
      cleanup.emergencyRecovery = recovered.status === "confirmed" ? "confirmed" : "failed";
    }
    const completedAt = now();
    evidence = {
      schemaVersion: 1,
      candidateSha256: sha256,
      sourceCommit,
      run: {
        id: runId,
        url: runUrl,
        trigger,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        remoteDate: completedAt.toISOString().slice(0, 10),
      },
      configuration: {
        compatibilityDate: config.cloudflare.compatibilityDate,
        compatibilityFlags: config.cloudflare.compatibilityFlags,
        wranglerVersion: config.cloudflare.wrangler,
      },
      resources: { worker: state.worker, database: state.database },
      scenarios,
      test: { status: testStatus(scenarios) },
      cleanup,
    };
    await validateManagedD1Evidence({ evidence, config });
    await writePrivateJson(evidencePath, evidence);
    if (stage) await rm(stage, { recursive: true, force: true });
  });

  if (signalCleanupPromise) await signalCleanupPromise;
  disposeSignals();
  return evidence;
}

async function cli() {
  const [command, ...rest] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, "")] = rest[i + 1];
  if (command === "stage") await stageManagedD1(args);
  else if (command === "verify") {
    const evidence = await verifyManagedD1({
      candidate: args.candidate,
      sha256: args.sha256,
      sourceCommit: args["source-commit"],
      runId: args["run-id"],
      runAttempt: args["run-attempt"],
      runUrl: args["run-url"],
      trigger: args.trigger,
      mode: args.mode,
      evidencePath: args["evidence-path"],
      statePath: args["state-path"],
      sqlc: args.sqlc,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    });
    if (evidence.test.status !== "passed" || evidence.cleanup.status !== "confirmed") process.exitCode = 1;
  } else if (command === "cleanup")
    await cleanupManagedD1State({
      statePath: args["state-path"],
      reportPath: args.report,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    });
  else throw new Error("usage: managed-d1.mjs stage|verify|cleanup [options]");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void cli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
