#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAsCli } from "./candidate-utils.ts";
import { parseManagedResourceName, stableJson } from "./managed-d1-contract.ts";
const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ManagedResource {
  name: string;
  id: string;
}

export interface ReapAction {
  kind: "worker" | "database";
  name: string;
  id: string;
  action: "deleted";
}

export interface ReaperReport {
  schemaVersion: 1;
  completedAt: string;
  actions: ReapAction[];
}

export function selectStaleManagedResources<T extends { name: string }>(
  resources: readonly T[],
  { now = new Date(), minimumAgeMs = DAY }: { now?: Date; minimumAgeMs?: number } = {},
): T[] {
  return resources.filter(({ name }) => {
    const parsed = parseManagedResourceName(name);
    if (!parsed) return false;
    return now.valueOf() - parsed.createdAt.valueOf() > minimumAgeMs;
  });
}

async function checkedJson(response: Response, operation: string): Promise<any> {
  if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} returned malformed JSON`);
  }
}

interface InventoryOptions {
  url: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  operation: string;
  map: (item: any) => ManagedResource;
}

async function inventory({ url, headers, fetchImpl, operation, map }: InventoryOptions): Promise<ManagedResource[]> {
  const body = await checkedJson(await fetchImpl(url, { headers }), operation);
  if (!Array.isArray(body.result)) throw new Error(`${operation} inventory is invalid`);
  return body.result.map(map);
}

async function inventoryPages({
  url,
  headers,
  fetchImpl,
  operation,
  map,
}: InventoryOptions): Promise<ManagedResource[]> {
  const result: ManagedResource[] = [];
  let page = 1;
  while (true) {
    const separator = url.includes("?") ? "&" : "?";
    const body = await checkedJson(
      await fetchImpl(`${url}${separator}page=${page}&per_page=100`, { headers }),
      operation,
    );
    const info = body.result_info;
    if (
      !Array.isArray(body.result) ||
      !info ||
      !Number.isSafeInteger(info.page) ||
      !Number.isSafeInteger(info.per_page) ||
      !Number.isSafeInteger(info.total_count) ||
      info.page !== page ||
      info.per_page < 1 ||
      info.total_count < 0
    )
      throw new Error(`${operation} inventory pagination is invalid`);
    for (const item of body.result) result.push(map(item));
    const totalPages = Math.max(1, Math.ceil(info.total_count / info.per_page));
    if (page === totalPages) return result;
    if (page > totalPages) throw new Error(`${operation} inventory pagination is invalid`);
    page++;
  }
}

export async function reapManagedD1({
  accountId,
  token,
  now = new Date(),
  fetchImpl = fetch,
  log = () => {},
}: {
  accountId?: string;
  token?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): Promise<ReaperReport> {
  if (!accountId || !token) throw new Error("Cloudflare account and token are required");
  const headers = { authorization: `Bearer ${token}` };
  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

  const workersInventory = await inventory({
    url: `${api}/workers/scripts`,
    headers,
    fetchImpl,
    operation: "Worker inventory",
    map: (item) => {
      if (!item || typeof item.id !== "string" || item.id.length === 0)
        throw new Error("Worker inventory identity is invalid");
      return { name: item.id, id: item.id };
    },
  });

  const d1Inventory = await inventoryPages({
    url: `${api}/d1/database`,
    headers,
    fetchImpl,
    operation: "D1 inventory",
    map: (item) => {
      if (!item || typeof item.name !== "string" || typeof item.uuid !== "string" || !UUID.test(item.uuid))
        throw new Error("D1 inventory identity is invalid");
      return { name: item.name, id: item.uuid };
    },
  });

  const workers = selectStaleManagedResources(workersInventory, { now }),
    databases = selectStaleManagedResources(d1Inventory, { now });
  const actions: ReapAction[] = [];
  for (const worker of workers) {
    log(`deleting Worker script ${worker.id}`);
    const response = await fetchImpl(`${api}/workers/scripts/${encodeURIComponent(worker.id)}`, {
      method: "DELETE",
      headers,
    });
    if (!response.ok) throw new Error(`Worker deletion failed with HTTP ${response.status}`);
    actions.push({ kind: "worker", name: worker.name, id: worker.id, action: "deleted" });
  }

  for (const database of databases) {
    log(`deleting D1 database ${database.id} (${database.name})`);
    const response = await fetchImpl(`${api}/d1/database/${encodeURIComponent(database.id)}`, {
      method: "DELETE",
      headers,
    });
    if (!response.ok) throw new Error(`D1 deletion failed with HTTP ${response.status}`);
    actions.push({ kind: "database", name: database.name, id: database.id, action: "deleted" });
  }
  return { schemaVersion: 1, completedAt: now.toISOString(), actions };
}

async function cli(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, "")] = rest[i + 1];
  if (command !== "reap") throw new Error("usage: reap-managed-d1.ts reap --output FILE");

  const report = await reapManagedD1({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    log: console.error,
  });
  await writeFile(resolve(args.output), stableJson(report), { mode: 0o600 });
}
runAsCli(import.meta.url, cli);
