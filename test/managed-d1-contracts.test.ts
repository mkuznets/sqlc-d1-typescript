import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createScenarioHandler, MANAGED_SCENARIO_IDS as WORKER_SCENARIO_IDS } from "./managed-d1/src/protocol";

const contract = () => import("../scripts/managed-d1-contract.mjs");
const reaper = () => import("../scripts/reap-managed-d1.mjs");
const lifecycle = () => import("../scripts/managed-d1.mjs");

const digest = "a".repeat(64),
  sourceCommit = "b".repeat(40),
  resource = "sqlc-d1-ci-20260205T120000Z-123-1-deadbeef";

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    candidateSha256: digest,
    sourceCommit,
    run: {
      id: "123",
      url: "https://github.com/o/r/actions/runs/123",
      trigger: "release",
      startedAt: "2026-02-05T12:00:00.000Z",
      completedAt: "2026-02-05T12:01:00.000Z",
      remoteDate: "2026-02-05",
    },
    configuration: { compatibilityDate: "2026-02-05", compatibilityFlags: [], wranglerVersion: "4.63.0" },
    resources: {
      worker: { status: "created", name: resource, id: resource },
      database: { status: "created", name: resource, id: "123e4567-e89b-42d3-a456-426614174000" },
    },
    scenarios: [
      "value-command-metadata",
      "macro-smoke",
      "batch-success",
      "batch-rollback",
      "direct-session",
      "bookmark-transfer",
      "native-error-identity",
      "post-execution-result-error",
    ].map((id) => ({ id: `managed-d1/${id}`, status: "passed", attempts: 1 })),
    test: { status: "passed" },
    cleanup: { status: "confirmed", worker: "deleted", database: "deleted", emergencyRecovery: "not-needed" },
    ...overrides,
  };
}

test("verification/managed-name-contract - formats and strictly parses complete reserved resource names", async () => {
  const { formatManagedResourceName, parseManagedResourceName } = await contract();
  const name = formatManagedResourceName({
    now: new Date("2026-02-05T12:00:00Z"),
    runId: "123",
    attempt: "2",
    randomHex: "deadbeef",
  });
  assert.equal(name, "sqlc-d1-ci-20260205T120000Z-123-2-deadbeef");
  assert.equal(parseManagedResourceName(name)?.runId, "123");
  for (const invalid of [
    "sqlc-d1-ci-20260230T120000Z-1-1-deadbeef",
    "x" + name,
    name + "-x",
    name.replace("deadbeef", "DEADBEEF"),
  ])
    assert.equal(parseManagedResourceName(invalid), null);
});

test("verification/managed-evidence-contract - validates closed candidate-bound passing evidence", async () => {
  const { validateManagedD1Evidence } = await contract();
  assert.equal(
    (
      await validateManagedD1Evidence({
        evidence: evidence(),
        candidateSha256: digest,
        sourceCommit,
        runId: "123",
        requirePassing: true,
      })
    ).test.status,
    "passed",
  );
  await assert.rejects(
    validateManagedD1Evidence({ evidence: evidence({ credentials: "secret" }) }),
    /prohibited field|schema mismatch/,
  );
  const failed = evidence();
  failed.scenarios[0].status = "failed";
  await assert.rejects(validateManagedD1Evidence({ evidence: failed }), /test.status mismatch/);
});

test("verification/managed-protocol - rejects every data channel and dispatches only authenticated allow-listed IDs", async () => {
  let calls = 0;
  const registry = Object.freeze({
    "managed-d1/value-command-metadata": async () => {
      calls++;
    },
  }) as any;
  const handle = createScenarioHandler(registry);
  const request = (body: string, token = "secret") =>
    new Request("https://worker.invalid/scenario", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });

  assert.equal(
    (
      await handle(request('{"scenario":"managed-d1/value-command-metadata"}'), {
        DB: {} as D1Database,
        SCENARIO_AUTH_TOKEN: "secret",
      })
    ).status,
    200,
  );
  assert.equal(calls, 1);

  for (const body of [
    '{"scenario":"unknown"}',
    '{"scenario":"managed-d1/value-command-metadata","sql":"SELECT 1"}',
    '{"scenario":1}',
    "[]",
    "not-json",
  ])
    assert.notEqual((await handle(request(body), { DB: {} as D1Database, SCENARIO_AUTH_TOKEN: "secret" })).status, 200);

  assert.equal(
    (
      await handle(request('{"scenario":"managed-d1/value-command-metadata"}', "wrong"), {
        DB: {} as D1Database,
        SCENARIO_AUTH_TOKEN: "secret",
      })
    ).status,
    401,
  );
  assert.equal(calls, 1);

  const { MANAGED_SCENARIO_IDS } = await contract();
  assert.deepEqual(WORKER_SCENARIO_IDS, MANAGED_SCENARIO_IDS);
});

test("verification/managed-protocol-size - cancels streaming bodies immediately beyond the limit", async () => {
  let cancelled = false,
    reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      controller.enqueue(new Uint8Array(200));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("https://w.invalid/scenario", {
    method: "POST",
    headers: { authorization: "Bearer s", "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  const handle = createScenarioHandler(Object.freeze({}) as any);

  assert.equal((await handle(request, { DB: {} as D1Database, SCENARIO_AUTH_TOKEN: "s" })).status, 400);
  assert.equal(cancelled, true);
  assert.ok(reads >= 2);
});

test("verification/managed-protocol-safe-errors - returns bounded kinds without error details", async () => {
  const handle = createScenarioHandler(
    Object.freeze({
      "managed-d1/value-command-metadata": async () => {
        throw new Error("sensitive row");
      },
    }) as any,
  );
  const response = await handle(
    new Request("https://w.invalid/scenario", {
      method: "POST",
      headers: { authorization: "Bearer s", "content-type": "application/json" },
      body: '{"scenario":"managed-d1/value-command-metadata"}',
    }),
    { DB: {} as D1Database, SCENARIO_AUTH_TOKEN: "s" },
  );
  const source = await response.text();

  assert.equal(response.status, 500);
  assert.doesNotMatch(source, /sensitive|row|stack|cause/);
  assert.deepEqual(JSON.parse(source), {
    scenario: "managed-d1/value-command-metadata",
    status: "failed",
    errorKind: "native",
  });
});

test("verification/managed-reaper - selects only complete names strictly older than 24 hours", async () => {
  const { selectStaleManagedResources } = await reaper();
  const old = { name: resource, id: "old" },
    boundary = { name: "sqlc-d1-ci-20260206T120000Z-123-1-deadbeef", id: "boundary" },
    unrelated = { name: "production", id: "no" };
  assert.deepEqual(selectStaleManagedResources([old, boundary, unrelated], { now: new Date("2026-02-07T12:00:00Z") }), [
    old,
  ]);
});

test("verification/managed-reaper-exact-deletion - logs exact identifiers before exact API deletion", async () => {
  const { reapManagedD1 } = await reaper();
  const calls: string[] = [],
    logs: string[] = [];
  const fake = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (!init?.method && url.includes("/workers/scripts"))
      return new Response(
        JSON.stringify({ result: [{ id: resource }, { id: "production" }], result_info: { page: 1, total_pages: 1 } }),
      );
    if (!init?.method)
      return new Response(
        JSON.stringify({
          result: [{ name: resource, uuid: "123e4567-e89b-42d3-a456-426614174000" }],
          result_info: { page: 1, per_page: 100, total_count: 1 },
        }),
      );
    return new Response("{}");
  };

  const report = await reapManagedD1({
    accountId: "acct",
    token: "secret",
    now: new Date("2026-02-07T12:00:01Z"),
    fetchImpl: fake as typeof fetch,
    log: (line) => logs.push(line),
  });

  assert.equal(report.actions.length, 2);
  assert.match(logs[0], new RegExp(resource));
  assert.ok(calls.some((line) => line.endsWith(`/workers/scripts/${resource}`)));
  assert.ok(calls.some((line) => line.endsWith("/d1/database/123e4567-e89b-42d3-a456-426614174000")));
  assert.ok(calls.every((line) => !line.includes("production") || line.startsWith("GET")));
});

test("verification/managed-reaper-pagination - accepts Workers inventory and visits every D1 page", async () => {
  const { reapManagedD1 } = await reaper();
  const seen: string[] = [];
  const fake = async (url: string) => {
    seen.push(url);
    if (url.includes("workers/scripts"))
      return new Response(JSON.stringify({ result: [{ id: "production" }], success: true }));
    const page = new URL(url).searchParams.get("page");
    return new Response(
      JSON.stringify({ result: [], result_info: { page: Number(page), per_page: 100, total_count: 101 } }),
    );
  };
  await reapManagedD1({ accountId: "acct", token: "secret", fetchImpl: fake as typeof fetch });
  assert.equal(seen[0], "https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts");
  assert.ok(seen.slice(1).every((url) => /[?&]page=[12]/.test(url)));
  assert.equal(seen.length, 3);

  const malformed = async (url: string) =>
    new Response(
      JSON.stringify({
        result: url.includes("workers") ? [{ id: 7 }] : [{ name: resource, uuid: "bad" }],
        result_info: { page: 1, total_pages: 1 },
      }),
    );
  await assert.rejects(
    reapManagedD1({ accountId: "acct", token: "secret", fetchImpl: malformed as typeof fetch }),
    /inventory.*invalid/i,
  );
});

test("verification/managed-lifecycle-json - fails closed on malformed create output", async () => {
  const { parseD1CreateJson } = await lifecycle();
  assert.equal(
    parseD1CreateJson('{"uuid":"123e4567-e89b-42d3-a456-426614174000"}'),
    "123e4567-e89b-42d3-a456-426614174000",
  );
  assert.throws(() => parseD1CreateJson("Database created abc"), /malformed JSON/);
  assert.throws(() => parseD1CreateJson('{"uuid":"not-id"}'), /valid UUID/);
});

async function lifecycleFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "managed-lifecycle-"));
  const stage = resolve(root, "stage");
  await writeFile(resolve(root, "candidate.wasm"), "candidate");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(resolve(root, "verification"), { recursive: true });
  await mkdir(resolve(root, "test/miniflare/node_modules/.bin"), { recursive: true });
  await mkdir(resolve(stage, "test/managed-d1"), { recursive: true });
  await mkdir(resolve(stage, "test/miniflare"), { recursive: true });
  await writeFile(
    resolve(root, "verification/compatibility.json"),
    await readFile(resolve(process.cwd(), "verification/compatibility.json")),
  );
  await writeFile(
    resolve(root, "verification/compatibility.schema.json"),
    await readFile(resolve(process.cwd(), "verification/compatibility.schema.json")),
  );
  await writeFile(
    resolve(stage, "test/managed-d1/wrangler.template.jsonc"),
    '{"name":"__RESOURCE_NAME__","compatibility_date":"__COMPATIBILITY_DATE__","compatibility_flags":__COMPATIBILITY_FLAGS__,"d1_databases":[{"database_name":"__RESOURCE_NAME__","database_id":"__DATABASE_ID__"}]}',
  );
  await writeFile(resolve(stage, "test/miniflare/schema.sql"), "CREATE TABLE x(id INTEGER);");
  const bytes = await readFile(resolve(root, "candidate.wasm"));
  const { createHash } = await import("node:crypto");

  return {
    root,
    stage,
    candidate: resolve(root, "candidate.wasm"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const lifecycleOptions = (fixture: Awaited<ReturnType<typeof lifecycleFixture>>) => ({
  candidate: fixture.candidate,
  sha256: fixture.sha256,
  sourceCommit,
  runId: "123",
  runAttempt: "1",
  runUrl: "https://github.com/o/r/actions/runs/123",
  trigger: "release" as const,
  accountId: "acct",
  token: "cloudflare",
  evidencePath: resolve(fixture.root, "evidence.json"),
  statePath: resolve(fixture.root, "state.json"),
  root: fixture.root,
  stageImpl: async () => fixture.stage,
  createDatabaseImpl: async () => "123e4567-e89b-42d3-a456-426614174000",
  now: (() => {
    let tick = 0;
    return () => new Date(1770292800000 + tick++ * 60000);
  })(),
  registerSignal: () => () => {},
});

test("verification/managed-lifecycle-failures - cleans persisted D1 after deploy failure and fails before commands on candidate drift", async () => {
  const { verifyManagedD1 } = await lifecycle();
  const fixture = await lifecycleFixture();
  try {
    let commands = 0;
    await assert.rejects(
      verifyManagedD1({
        ...lifecycleOptions(fixture),
        sha256: "0".repeat(64),
        run: async () => {
          commands++;
          return { stdout: "", stderr: "" };
        },
      }),
      /SHA-256 mismatch/,
    );
    assert.equal(commands, 0);

    const calls: string[] = [];
    const run = async (_command: string, args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "d1" && args[1] === "create")
        return { stdout: '{"uuid":"123e4567-e89b-42d3-a456-426614174000"}', stderr: "" };
      if (args[0] === "deploy") throw new Error("deploy failed");
      return { stdout: "", stderr: "" };
    };
    const fetchImpl = async (url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? new Response("{}") : new Response("{}", { status: 404 });
    const result = await verifyManagedD1({ ...lifecycleOptions(fixture), run, fetchImpl: fetchImpl as typeof fetch });

    assert.equal(result.resources.database.status, "created");
    assert.equal(result.resources.worker.status, "not-created");
    assert.deepEqual(result.cleanup, {
      status: "confirmed",
      worker: "not-created",
      database: "deleted",
      emergencyRecovery: "not-needed",
    });
    assert.ok(calls.some((line) => line.startsWith("deploy")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification/managed-lifecycle-attempts - records ambiguity once, stops subsequent scenarios, masks auth, and cleans independently", async () => {
  const { verifyManagedD1 } = await lifecycle();
  const fixture = await lifecycleFixture();
  try {
    const scenarioBodies: string[] = [],
      masked: string[] = [],
      commandArgs: string[][] = [];
    const run = async (_command: string, args: string[], options?: { stdin?: string }) => {
      commandArgs.push(args);
      if (args[0] === "d1" && args[1] === "create")
        return { stdout: '{"uuid":"123e4567-e89b-42d3-a456-426614174000"}', stderr: "" };
      if (args[0] === "secret") assert.equal(options?.stdin, "run-secret");
      return { stdout: "", stderr: "" };
    };
    let probes = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.includes("workers/subdomain")) return new Response('{"result":{"subdomain":"example"}}');
      if (url.includes("workers.dev")) {
        if (probes++ < 3) return new Response("{}", { status: 400 });
        scenarioBodies.push(String(init?.body));
        throw new Error("timeout");
      }
      if (init?.method === "DELETE") return new Response("{}");
      return new Response("{}", { status: 404 });
    };

    const result = await verifyManagedD1({
      ...lifecycleOptions(fixture),
      run,
      fetchImpl: fetchImpl as typeof fetch,
      authToken: () => "run-secret",
      maskSecret: (value) => masked.push(value),
    });

    assert.equal(result.test.status, "ambiguous");
    assert.deepEqual(
      result.scenarios.map(({ attempts }: { attempts: number }) => attempts),
      [1, 0, 0, 0, 0, 0, 0, 0],
    );
    assert.equal(scenarioBodies.length, 1);
    assert.deepEqual(masked, ["run-secret"]);
    assert.ok(commandArgs.every((args) => !args.includes("run-secret")));
    assert.doesNotMatch(await readFile(resolve(fixture.root, "evidence.json"), "utf8"), /run-secret/);
    assert.equal(result.cleanup.status, "confirmed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification/managed-lifecycle-timeout - aborts one hung stateful request and records ambiguity", async () => {
  const { verifyManagedD1 } = await lifecycle();
  const fixture = await lifecycleFixture();
  try {
    const run = async (_command: string, args: string[]) =>
      args[0] === "d1" && args[1] === "create"
        ? { stdout: '{"uuid":"123e4567-e89b-42d3-a456-426614174000"}', stderr: "" }
        : { stdout: "", stderr: "" };
    let requests = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.includes("workers/subdomain")) return new Response('{"result":{"subdomain":"example"}}');
      if (url.includes("workers.dev")) {
        if (requests++ < 3) return new Response("{}", { status: 400 });
        return await new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        );
      }
      if (init?.method === "DELETE") return new Response("{}");
      return new Response("{}", { status: 404 });
    };

    const result = await verifyManagedD1({
      ...lifecycleOptions(fixture),
      run,
      fetchImpl: fetchImpl as typeof fetch,
      scenarioTimeoutMs: 1,
    });

    assert.equal(result.test.status, "ambiguous");
    assert.deepEqual(
      result.scenarios.map(({ attempts }: { attempts: number }) => attempts),
      [1, 0, 0, 0, 0, 0, 0, 0],
    );
    assert.equal(result.cleanup.status, "confirmed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification/managed-lifecycle-signal - signal cleanup uses persisted exact state and second cleanup remains safe", async () => {
  const { verifyManagedD1, cleanupManagedD1State } = await lifecycle();
  const fixture = await lifecycleFixture();
  try {
    let signal: (() => Promise<void>) | undefined,
      deletes = 0;
    const run = async (_command: string, args: string[]) => {
      if (args[0] === "d1" && args[1] === "create")
        return { stdout: '{"uuid":"123e4567-e89b-42d3-a456-426614174000"}', stderr: "" };
      if (args[0] === "d1" && args[1] === "execute")
        queueMicrotask(() => {
          void signal?.();
        });
      return { stdout: "", stderr: "" };
    };
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deletes++;
        return new Response("{}");
      }
      return new Response("{}", { status: 404 });
    };

    const result = await verifyManagedD1({
      ...lifecycleOptions(fixture),
      run,
      fetchImpl: fetchImpl as typeof fetch,
      registerSignal: (handler) => {
        signal = handler;
        return () => {};
      },
    });
    assert.equal(result.cleanup.database, "deleted");

    const report = await cleanupManagedD1State({
      statePath: resolve(fixture.root, "state.json"),
      reportPath: resolve(fixture.root, "recovery.json"),
      accountId: "acct",
      token: "cloudflare",
      fetchImpl: fetchImpl as typeof fetch,
    });
    assert.equal(report.cleanup.database, "deleted");
    assert.equal(deletes, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verification/managed-lifecycle-provision-races - waits for in-flight create and deploy persistence before signal cleanup", async () => {
  const { verifyManagedD1 } = await lifecycle();
  for (const race of ["create", "deploy"] as const) {
    const fixture = await lifecycleFixture();
    try {
      let signal: (() => Promise<void>) | undefined,
        deletes: string[] = [],
        release!: () => void;
      const gate = new Promise<void>((resolveGate) => (release = resolveGate));
      const run = async (_command: string, args: string[]) => {
        if (args[0] === "d1" && args[1] === "create") {
          if (race === "create") {
            queueMicrotask(() => {
              void signal?.();
            });
            await gate;
          }
          return { stdout: '{"uuid":"123e4567-e89b-42d3-a456-426614174000"}', stderr: "" };
        }
        if (args[0] === "deploy" && race === "deploy") {
          queueMicrotask(() => {
            void signal?.();
          });
          await gate;
        }
        return { stdout: "", stderr: "" };
      };
      const fetchImpl = async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          deletes.push(url);
          return new Response("{}");
        }
        return new Response("{}", { status: 404 });
      };

      const pending = verifyManagedD1({
        ...lifecycleOptions(fixture),
        run,
        fetchImpl: fetchImpl as typeof fetch,
        createDatabaseImpl: async () => {
          if (race === "create") {
            queueMicrotask(() => {
              void signal?.();
            });
            await gate;
          }
          return "123e4567-e89b-42d3-a456-426614174000";
        },
        registerSignal: (handler) => {
          signal = handler;
          return () => {};
        },
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
      assert.equal(deletes.length, 0);
      release();
      const result = await pending;

      assert.ok(deletes.some((url) => url.includes("/d1/database/123e4567-e89b-42d3-a456-426614174000")));
      if (race === "deploy") assert.ok(deletes.some((url) => url.includes("/workers/scripts/")));
      assert.equal(result.cleanup.status, "confirmed");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});
