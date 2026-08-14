#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareVersions, loadCompatibilityConfig } from "./compatibility-config.mjs";

const SOURCES = [
  ["sqlc", "sqlc.testedCeiling", "https://api.github.com/repos/sqlc-dev/sqlc/releases/latest", (json) => json.tag_name],
  [
    "workersTypes",
    "cloudflare.workersTypes",
    "https://registry.npmjs.org/@cloudflare%2fworkers-types",
    selectLatestDistTag,
  ],
  ["wrangler", "cloudflare.wrangler", "https://registry.npmjs.org/wrangler", selectLatestDistTag],
  [
    "vitestPoolWorkers",
    "cloudflare.vitestPoolWorkers",
    "https://registry.npmjs.org/@cloudflare%2fvitest-pool-workers",
    selectLatestDistTag,
  ],
  ["miniflare", "cloudflare.miniflare", "https://registry.npmjs.org/miniflare", selectLatestDistTag],
  ["workerd", "cloudflare.workerd", "https://registry.npmjs.org/workerd", selectLatestDistTag],
];

function baselineValue(config, path) {
  return path.split(".").reduce((value, key) => value[key], config);
}

function stable(value) {
  return typeof value === "string" && /^v?\d+\.\d+\.\d+(?:\.\d+)?$/.test(value);
}

function selectLatestDistTag(json) {
  return json?.["dist-tags"]?.latest;
}

export function compareUpstreamCompatibility(config, upstream) {
  return SOURCES.map(([name, path]) => {
    const baseline = baselineValue(config, path),
      actual = upstream[name];
    if (!stable(actual)) throw new Error(`upstream.${name}: missing or malformed stable version`);
    return { component: name, baseline, upstream: actual, drift: compareVersions(actual, baseline) !== 0 };
  });
}

export function renderUpstreamTable(rows) {
  return [
    "| Component | Reviewed baseline | Upstream stable | Status |",
    "|---|---:|---:|---|",
    ...rows.map(
      (row) =>
        `| ${row.component} | ${row.baseline} | ${row.upstream} | ${row.drift ? "review required" : "current"} |`,
    ),
    "",
    "A newer/different release is a review signal, not proof that the Plugin is incompatible.",
    "Managed D1 and SQLite versions are intentionally not inferred.",
  ].join("\n");
}

export async function fetchUpstreamFacts(fetchImpl = fetch, { timeoutMs = 10000 } = {}) {
  const result = {};
  for (const [name, , url, select] of SOURCES) {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "sqlc-d1-typescript-compatibility-check" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`upstream.${name}: HTTP ${response.status}`);
    let json;
    try {
      json = await response.json();
    } catch {
      throw new Error(`upstream.${name}: malformed JSON`);
    }
    const version = select(json);
    if (!stable(version)) throw new Error(`upstream.${name}: missing or malformed stable version`);
    result[name] = version;
  }
  return result;
}

export async function checkUpstreamCompatibility({ root = process.cwd(), fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const config = await loadCompatibilityConfig({ root });
  const rows = compareUpstreamCompatibility(config, await fetchUpstreamFacts(fetchImpl, { timeoutMs }));
  const table = renderUpstreamTable(rows);
  if (rows.some(({ drift }) => drift)) {
    const error = new Error(`upstream compatibility drift detected\n${table}`);
    error.table = table;
    throw error;
  }
  return table;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => {
    try {
      console.log(await checkUpstreamCompatibility());
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  })();
}
