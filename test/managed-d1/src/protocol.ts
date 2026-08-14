export const MANAGED_SCENARIO_IDS = [
  "managed-d1/value-command-metadata",
  "managed-d1/macro-smoke",
  "managed-d1/batch-success",
  "managed-d1/batch-rollback",
  "managed-d1/direct-session",
  "managed-d1/bookmark-transfer",
  "managed-d1/native-error-identity",
  "managed-d1/post-execution-result-error",
] as const;
export type ManagedScenarioId = (typeof MANAGED_SCENARIO_IDS)[number];

export interface ScenarioEnvironment {
  DB: D1Database;
  SCENARIO_AUTH_TOKEN?: string;
}
export type Scenario = (database: D1Database) => Promise<void>;
export type ScenarioRegistry = Readonly<Record<ManagedScenarioId, Scenario>>;

const encoder = new TextEncoder();
const MAX_BODY_BYTES = 256;

function json(status: number, body: Readonly<Record<string, string>>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function fixedBytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function authorize(request: Request, expected: string | undefined): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (!expected || !header?.startsWith("Bearer ") || header.slice(7).length === 0) return false;
  const a = await fixedBytes(header.slice(7)),
    b = await fixedBytes(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export async function parseScenarioRequest(request: Request): Promise<ManagedScenarioId | null> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/scenario") return null;
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return null;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "scenario") return null;
  return typeof (value as { scenario?: unknown }).scenario === "string"
    ? (value as { scenario: ManagedScenarioId }).scenario
    : null;
}

export function createScenarioHandler(registry: ScenarioRegistry) {
  return async (request: Request, env: ScenarioEnvironment): Promise<Response> => {
    if (request.method !== "POST") return json(405, { status: "rejected" });
    if (new URL(request.url).pathname !== "/scenario") return json(404, { status: "rejected" });
    if (!(await authorize(request, env.SCENARIO_AUTH_TOKEN))) return json(401, { status: "rejected" });
    const scenario = await parseScenarioRequest(request);
    if (scenario === null) return json(400, { status: "rejected" });
    if (!Object.prototype.hasOwnProperty.call(registry, scenario)) return json(404, { status: "rejected" });

    try {
      await registry[scenario](env.DB);
      return json(200, { scenario, status: "passed" });
    } catch (error) {
      const errorKind =
        error instanceof Error && error.name === "QueryResultError"
          ? "result"
          : error instanceof Error && error.name.endsWith("SqlcD1Error")
            ? "generated"
            : "native";
      return json(500, { scenario, status: "failed", errorKind });
    }
  };
}
