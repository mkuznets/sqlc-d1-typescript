#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseManagedResourceName, stableJson } from "./managed-d1-contract.mjs";
const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function selectStaleManagedResources(resources, { now = new Date(), minimumAgeMs = DAY } = {}) {
  return resources.filter(({ name }) => { const parsed = parseManagedResourceName(name); if (!parsed) return false; return now.valueOf() - parsed.createdAt.valueOf() > minimumAgeMs; });
}
async function checkedJson(response, operation) { if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}`); try { return await response.json(); } catch { throw new Error(`${operation} returned malformed JSON`); } }
async function inventoryPages({ url, headers, fetchImpl, operation, map }) {
  const result = []; let page = 1;
  while (true) {
    const separator = url.includes("?") ? "&" : "?"; const body = await checkedJson(await fetchImpl(`${url}${separator}page=${page}&per_page=100`, { headers }), operation);
    if (!Array.isArray(body.result) || !body.result_info || !Number.isSafeInteger(body.result_info.page) || !Number.isSafeInteger(body.result_info.total_pages) || body.result_info.page !== page || body.result_info.total_pages < page) throw new Error(`${operation} inventory pagination is invalid`);
    for (const item of body.result) result.push(map(item));
    if (page === body.result_info.total_pages) return result; page++;
  }
}
export async function reapManagedD1({ accountId, token, now = new Date(), fetchImpl = fetch, log = () => {} }) {
  if (!accountId || !token) throw new Error("Cloudflare account and token are required");
  const headers = { authorization: `Bearer ${token}` }; const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const workersInventory = await inventoryPages({ url: `${api}/workers/scripts`, headers, fetchImpl, operation: "Worker inventory", map: (item) => { if (!item || typeof item.id !== "string" || item.id.length === 0) throw new Error("Worker inventory identity is invalid"); return { name: item.id, id: item.id }; } });
  const d1Inventory = await inventoryPages({ url: `${api}/d1/database`, headers, fetchImpl, operation: "D1 inventory", map: (item) => { if (!item || typeof item.name !== "string" || typeof item.uuid !== "string" || !UUID.test(item.uuid)) throw new Error("D1 inventory identity is invalid"); return { name: item.name, id: item.uuid }; } });
  const workers = selectStaleManagedResources(workersInventory, { now }), databases = selectStaleManagedResources(d1Inventory, { now }); const actions = [];
  for (const worker of workers) { log(`deleting Worker script ${worker.id}`); const response = await fetchImpl(`${api}/workers/scripts/${encodeURIComponent(worker.id)}`, { method: "DELETE", headers }); if (!response.ok) throw new Error(`Worker deletion failed with HTTP ${response.status}`); actions.push({ kind: "worker", name: worker.name, id: worker.id, action: "deleted" }); }
  for (const database of databases) { log(`deleting D1 database ${database.id} (${database.name})`); const response = await fetchImpl(`${api}/d1/database/${encodeURIComponent(database.id)}`, { method: "DELETE", headers }); if (!response.ok) throw new Error(`D1 deletion failed with HTTP ${response.status}`); actions.push({ kind: "database", name: database.name, id: database.id, action: "deleted" }); }
  return { schemaVersion: 1, completedAt: now.toISOString(), actions };
}
async function cli() { const [command, ...rest] = process.argv.slice(2); const args = {}; for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, "")] = rest[i + 1]; if (command !== "reap") throw new Error("usage: reap-managed-d1.mjs reap --output FILE"); const report = await reapManagedD1({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN, log: console.error }); await writeFile(resolve(args.output), stableJson(report), { mode: 0o600 }); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void cli().catch((error) => { console.error(error.message); process.exitCode = 1; });
