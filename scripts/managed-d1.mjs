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
const OUTPUT_TAIL_LINES = 40;
const BODY_EXCERPT_BYTES = 500;
const FAILURE_DETAIL_LIMIT = 2000;
const PROPAGATION_ATTEMPTS = 10;
const PROPAGATION_DELAY_MS = 1_000;

export function tailLines(text, limit = OUTPUT_TAIL_LINES) {
  const trimmed = String(text ?? "").trimEnd();
  if (!trimmed) return "";
  const lines = trimmed.split(/\r?\n/);
  return lines.length > limit
    ? [`… ${lines.length - limit} earlier lines omitted`, ...lines.slice(-limit)].join("\n")
    : trimmed;
}

function describeCommandFailure(command, args, code, stdout, stderr) {
  const parts = [`${command} ${args.join(" ")} failed with exit ${code}`];
  const err = tailLines(stderr),
    out = tailLines(stdout);
  parts.push(err ? `stderr:\n${err}` : "stderr was empty");
  if (out) parts.push(`stdout:\n${out}`);
  return parts.join("\n");
}

async function excerptResponse(response) {
  try {
    const text = await response.text();
    const trimmed = text.trim().replace(/\s+/g, " ");
    return trimmed.length > BODY_EXCERPT_BYTES ? `${trimmed.slice(0, BODY_EXCERPT_BYTES)}…` : trimmed;
  } catch {
    return "<response body unavailable>";
  }
}

export function commandRunner(command, args, options = {}) {
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
    child.on("error", (error) => fail(new Error(`${command} could not be started: ${error.message}`)));
    child.on("exit", (code) => {
      if (code === 0) return ok({ stdout, stderr });
      fail(new Error(describeCommandFailure(command, args, code, stdout, stderr)));
    });
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
  if (!response.ok)
    throw new Error(`D1 create failed with HTTP ${response.status}: ${await excerptResponse(response)}`);
  return parseD1CreateJson(await response.text());
}

async function initializeManagedD1Database({ accountId, token, databaseId, schema, fetchImpl }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const statements = schema
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const [index, sql] of statements.entries()) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    if (!response.ok) {
      const error = new Error(
        `D1 schema setup failed with HTTP ${response.status}: ${await excerptResponse(response)}`,
      );
      error.managedPhase = `database-schema-${index + 1}`;
      throw error;
    }
    const body = await response.json();
    if (!body.success || !Array.isArray(body.result) || body.result.some((result) => result?.success !== true)) {
      const error = new Error(
        `D1 schema setup did not succeed: ${JSON.stringify(body.errors ?? body).slice(0, BODY_EXCERPT_BYTES)}`,
      );
      error.managedPhase = `database-schema-${index + 1}`;
      throw error;
    }
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
    delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
    logger = (line) => process.stdout.write(`${line}\n`),
  } = options;

  const say = (message) => logger(`==> ${message}`);
  const note = (message) => {
    for (const line of String(message).split("\n")) logger(`    ${line}`);
  };
  const annotate = (message) =>
    logger(process.env.GITHUB_ACTIONS ? `::error::${message.replace(/\r?\n/g, "%0A")}` : message);

  let phase = "startup";
  const enter = (next, message) => {
    phase = next;
    say(`[${next}] ${message}`);
  };

  const config = await loadCompatibilityConfig({ root });
  await readCandidate(candidate, sha256);
  const wranglerBin = resolve(root, "test/miniflare/node_modules/.bin/wrangler");
  const startedAt = now();
  const name = formatManagedResourceName({ now: startedAt, runId, attempt: runAttempt });
  let state = initialResourceState({ name, candidateSha256: sha256, createdAt: startedAt.toISOString() });
  await writePrivateJson(statePath, state);
  const scenarios = MANAGED_SCENARIO_IDS.map((id) => ({ id, status: "not-run", attempts: 0 }));

  let stage, databaseId, failure;
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
    enter("stage", "Staging the candidate: sqlc generate against the fixture, then a tsc typecheck");
    stage = await stageImpl({
      candidate,
      sha256,
      sqlc,
      output: await mkdtemp(resolve(tmpdir(), "sqlc-d1-managed-stage-")),
      root,
      run,
    });
    note(`stage ready at ${stage}`);
    checkpoint();

    enter("database-create", `Creating disposable D1 database ${name}`);
    await provision(async () => {
      databaseId = await createDatabaseImpl({ accountId, token, name, fetchImpl });
      state = { ...state, database: { status: "created", name, id: databaseId } };
      await writePrivateJson(statePath, state);
    });
    note(`database id: ${databaseId}`);
    checkpoint();

    enter("wrangler-config", "Rendering the disposable wrangler config from the template");
    const templatePath = resolve(stage, "test/managed-d1/wrangler.template.jsonc");
    let wrangler = await readFile(templatePath, "utf8");
    wrangler = wrangler
      .replaceAll("__RESOURCE_NAME__", name)
      .replace("__DATABASE_ID__", databaseId)
      .replace("__COMPATIBILITY_DATE__", config.cloudflare.compatibilityDate)
      .replace("__COMPATIBILITY_FLAGS__", JSON.stringify(config.cloudflare.compatibilityFlags));
    const configPath = resolve(stage, "test/managed-d1/wrangler.jsonc");
    await writeFile(configPath, wrangler, { mode: 0o600 });
    note(
      `compatibility date ${config.cloudflare.compatibilityDate}, flags ${JSON.stringify(config.cloudflare.compatibilityFlags)}, wrangler ${config.cloudflare.wrangler}`,
    );

    enter("database-schema", "Applying the fixture schema to the disposable database");
    const schema = await readFile(resolve(stage, "test/miniflare/schema.sql"), "utf8");
    await initializeDatabaseImpl({ accountId, token, databaseId, schema, fetchImpl });
    checkpoint();

    enter("worker-deploy", `Deploying the scenario Worker ${name}`);
    await provision(async () => {
      const deployed = await run(wranglerBin, ["deploy", "--config", configPath], { cwd: stage });
      note(tailLines(`${deployed.stdout}${deployed.stderr}`) || "wrangler deploy produced no output");
      state = { ...state, worker: { status: "created", name, id: name } };
      await writePrivateJson(statePath, state);
    });
    checkpoint();

    enter("worker-secret", "Uploading the scenario auth token as a Worker secret");
    const auth = authToken();
    maskSecret(auth);
    await run(wranglerBin, ["secret", "put", "SCENARIO_AUTH_TOKEN", "--config", configPath], {
      cwd: stage,
      stdin: auth,
    });
    checkpoint();

    enter("subdomain-discovery", "Discovering the account workers.dev subdomain");
    const subdomainResponse = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const subdomainBody = await subdomainResponse.json();
    if (!subdomainResponse.ok || typeof subdomainBody.result?.subdomain !== "string")
      throw new Error(
        `Workers subdomain discovery failed with HTTP ${subdomainResponse.status}: ${JSON.stringify(subdomainBody).slice(0, BODY_EXCERPT_BYTES)}`,
      );
    const endpoint = `https://${name}.${subdomainBody.result.subdomain}.workers.dev/scenario`;
    note(`scenario endpoint: ${endpoint}`);

    enter(
      "authorization-probe",
      `Probing the endpoint without credentials until the route is live; it must answer 401 within ${PROPAGATION_ATTEMPTS} attempts`,
    );
    let authorized = false,
      lastUnauthorizedStatus = "none",
      lastUnauthorizedBody = "";
    for (let attempt = 0; attempt < PROPAGATION_ATTEMPTS; attempt++) {
      let status, body;
      try {
        const unauthorized = await fetchImpl(endpoint, { method: "POST" });
        status = unauthorized.status;
        if (status === 401) {
          note(`attempt ${attempt + 1}/${PROPAGATION_ATTEMPTS} answered HTTP 401: the route is live and closed`);
          authorized = true;
          break;
        }
        body = await excerptResponse(unauthorized);
        // A live route that serves an unauthenticated request is a protocol breach, never a race.
        if (status === 200)
          throw new Error(`scenario endpoint served an unauthenticated request with HTTP 200: ${body}`);
      } catch (error) {
        const message = String(error?.message ?? error);
        if (message.startsWith("scenario endpoint served")) throw error;
        status = "unreachable";
        body = message;
      }
      lastUnauthorizedStatus = String(status);
      lastUnauthorizedBody = body;
      note(`attempt ${attempt + 1}/${PROPAGATION_ATTEMPTS} answered ${status}: ${body}; the route is not live yet`);
      if (attempt < PROPAGATION_ATTEMPTS - 1) await delay(PROPAGATION_DELAY_MS);
    }
    if (!authorized)
      throw new Error(
        `scenario endpoint never answered 401 after ${PROPAGATION_ATTEMPTS} attempts; last response was ${lastUnauthorizedStatus}: ${lastUnauthorizedBody}. The workers.dev route did not become live, or it answers something other than the scenario protocol`,
      );

    enter("secret-propagation", "Waiting for the Worker secret to propagate; an unknown scenario must answer 404");
    const authenticatedHeaders = { authorization: `Bearer ${auth}`, "content-type": "application/json" };
    let ready = false,
      lastStatus = "none",
      lastBody = "";
    for (let attempt = 0; attempt < PROPAGATION_ATTEMPTS; attempt++) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: authenticatedHeaders,
        body: '{"scenario":"unknown"}',
      });
      lastStatus = String(response.status);
      if (response.status === 404) {
        note(`attempt ${attempt + 1}/${PROPAGATION_ATTEMPTS} answered HTTP 404: the secret is live`);
        ready = true;
        break;
      }
      lastBody = await excerptResponse(response);
      note(`attempt ${attempt + 1}/${PROPAGATION_ATTEMPTS} answered HTTP ${response.status}: ${lastBody}`);
      if (attempt < PROPAGATION_ATTEMPTS - 1) await delay(PROPAGATION_DELAY_MS);
    }
    if (!ready)
      throw new Error(
        `scenario authentication did not become ready after ${PROPAGATION_ATTEMPTS} attempts; last response was HTTP ${lastStatus}: ${lastBody}`,
      );

    enter("data-channel-probe", "Probing with a prohibited data field; the Worker must reject it with 400");
    const prohibited = await fetchImpl(endpoint, {
      method: "POST",
      headers: authenticatedHeaders,
      body: '{"scenario":"managed-d1/batch-success","sql":"x"}',
    });
    note(`prohibited-field POST answered HTTP ${prohibited.status}`);
    if (prohibited.status !== 400)
      throw new Error(
        `scenario protocol data-channel probe returned HTTP ${prohibited.status}, expected 400: ${await excerptResponse(prohibited)}`,
      );

    enter("scenarios", `Running ${scenarios.length} managed scenarios against real D1`);
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
        if (scenario.status === "passed") note(`${scenario.id}: passed`);
        else {
          const kind =
            typeof body.errorKind === "string" && ["native", "generated", "result"].includes(body.errorKind)
              ? `${body.errorKind} error`
              : "no error kind reported";
          failure = { phase: "scenarios", detail: `${scenario.id} failed with HTTP ${response.status} (${kind})` };
          annotate(`managed scenario ${failure.detail}`);
        }
      } catch (error) {
        scenario.status = "ambiguous";
        failure = {
          phase: "scenarios",
          detail: `${scenario.id} is ambiguous: the request did not complete (${error?.message ?? error}); it may or may not have reached D1`,
        };
        annotate(`managed scenario ${failure.detail}`);
        break;
      } finally {
        clearTimer(timeout);
      }
      if (scenario.status !== "passed") break;
    }
    if (mode === "simulate-test-failure" && scenarios.every(({ status }) => status === "passed"))
      scenarios[scenarios.length - 1].status = "failed";
  } catch (error) {
    const where = typeof error?.managedPhase === "string" ? error.managedPhase : phase;
    const detail = String(error?.message ?? error);
    failure = { phase: where, detail: detail.slice(0, FAILURE_DETAIL_LIMIT) };
    annotate(`managed verification failed during ${where}: ${detail}`);
    const pending = scenarios.find(({ attempts }) => attempts === 0);
    if (scenarioStarted && pending) {
      pending.attempts = 1;
      pending.status = "ambiguous";
    }
  }

  let evidence;
  await provision(async () => {
    say(
      `[cleanup] Deleting every provisioned resource (worker: ${state.worker.status}, database: ${state.database.status})`,
    );
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
      ...(failure && testStatus(scenarios) !== "passed" ? { failure } : {}),
    };
    note(`cleanup: worker ${cleanup.worker}, database ${cleanup.database} (${cleanup.status})`);
    await validateManagedD1Evidence({ evidence, config });
    await writePrivateJson(evidencePath, evidence);
    say(`[result] scenarios ${evidence.test.status}, cleanup ${cleanup.status}; evidence written to ${evidencePath}`);
    for (const scenario of scenarios) note(`${scenario.status.padEnd(9)} ${scenario.id}`);
    if (stage) await rm(stage, { recursive: true, force: true });
  });

  if (signalCleanupPromise) await signalCleanupPromise;
  disposeSignals();
  return evidence;
}

function report(message) {
  const text = String(message);
  process.stdout.write(process.env.GITHUB_ACTIONS ? `::error::${text.replace(/\r?\n/g, "%0A")}\n` : `${text}\n`);
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
    if (evidence.test.status !== "passed" || evidence.cleanup.status !== "confirmed") {
      const reason = evidence.failure
        ? `${evidence.failure.phase}: ${evidence.failure.detail}`
        : `scenarios ${evidence.test.status}, cleanup ${evidence.cleanup.status}`;
      report(`managed D1 verification did not pass — ${reason}`);
      process.exitCode = 1;
    }
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
    report(`managed D1 lifecycle aborted: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
