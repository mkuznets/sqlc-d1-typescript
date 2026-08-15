#!/usr/bin/env node
import { runAsCli } from "./candidate-utils.ts";
import { compareVersions, loadCompatibilityConfig, type CompatibilityConfig } from "./compatibility-config.ts";

interface UpstreamSource {
  name: string;
  path: string;
  url: string;
  select: (json: any) => unknown;
}

function selectLatestDistTag(json: any): unknown {
  return json?.["dist-tags"]?.latest;
}

const SOURCES: readonly UpstreamSource[] = [
  {
    name: "sqlc",
    path: "sqlc.testedCeiling",
    url: "https://api.github.com/repos/sqlc-dev/sqlc/releases/latest",
    select: (json) => json.tag_name,
  },
  {
    name: "workersTypes",
    path: "cloudflare.workersTypes",
    url: "https://registry.npmjs.org/@cloudflare%2fworkers-types",
    select: selectLatestDistTag,
  },
  {
    name: "wrangler",
    path: "cloudflare.wrangler",
    url: "https://registry.npmjs.org/wrangler",
    select: selectLatestDistTag,
  },
  {
    name: "vitestPoolWorkers",
    path: "cloudflare.vitestPoolWorkers",
    url: "https://registry.npmjs.org/@cloudflare%2fvitest-pool-workers",
    select: selectLatestDistTag,
  },
  {
    name: "miniflare",
    path: "cloudflare.miniflare",
    url: "https://registry.npmjs.org/miniflare",
    select: selectLatestDistTag,
  },
  {
    name: "workerd",
    path: "cloudflare.workerd",
    url: "https://registry.npmjs.org/workerd",
    select: selectLatestDistTag,
  },
];

export interface UpstreamRow {
  component: string;
  baseline: string;
  upstream: string;
  drift: boolean;
}

export type UpstreamFacts = Record<string, string>;

export class UpstreamDriftError extends Error {
  table: string;

  constructor(message: string, table: string) {
    super(message);
    this.table = table;
  }
}

function baselineValue(config: CompatibilityConfig, path: string): string {
  return path.split(".").reduce<any>((value, key) => value[key], config) as string;
}

function stable(value: unknown): value is string {
  return typeof value === "string" && /^v?\d+\.\d+\.\d+(?:\.\d+)?$/.test(value);
}

export function compareUpstreamCompatibility(config: CompatibilityConfig, upstream: UpstreamFacts): UpstreamRow[] {
  return SOURCES.map(({ name, path }) => {
    const baseline = baselineValue(config, path),
      actual = upstream[name];
    if (!stable(actual)) throw new Error(`upstream.${name}: missing or malformed stable version`);
    return { component: name, baseline, upstream: actual, drift: compareVersions(actual, baseline) !== 0 };
  });
}

export function renderUpstreamTable(rows: readonly UpstreamRow[]): string {
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

export async function fetchUpstreamFacts(
  fetchImpl: typeof fetch = fetch,
  { timeoutMs = 10000 }: { timeoutMs?: number } = {},
): Promise<UpstreamFacts> {
  const result: UpstreamFacts = {};
  for (const { name, url, select } of SOURCES) {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "sqlc-d1-typescript-compatibility-check" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`upstream.${name}: HTTP ${response.status}`);
    let json: unknown;
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

export async function checkUpstreamCompatibility({
  root = process.cwd(),
  fetchImpl = fetch,
  timeoutMs = 10000,
}: { root?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<string> {
  const config = await loadCompatibilityConfig({ root });
  const rows = compareUpstreamCompatibility(config, await fetchUpstreamFacts(fetchImpl, { timeoutMs }));
  const table = renderUpstreamTable(rows);
  if (rows.some(({ drift }) => drift))
    throw new UpstreamDriftError(`upstream compatibility drift detected\n${table}`, table);
  return table;
}

runAsCli(import.meta.url, async () => {
  console.log(await checkUpstreamCompatibility());
});
