import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONFIG_PATH = "verification/compatibility.json";

export type SqlcRole = "floor" | "intervening" | "ceiling";

export interface CompatibilityConfig {
  readonly schemaVersion: 1;
  readonly sqlc: {
    readonly supportedFloor: string;
    readonly testedCeiling: string;
    readonly samples: readonly { readonly version: string; readonly role: SqlcRole; readonly rationale: string }[];
    readonly knownExceptions: readonly string[];
  };
  readonly typescript: { readonly floor: string; readonly current: string };
  readonly cloudflare: {
    readonly workersTypes: string;
    readonly wrangler: string;
    readonly vitestPoolWorkers: string;
    readonly miniflare: string;
    readonly workerd: string;
    readonly compatibilityDate: string;
    readonly compatibilityFlags: readonly string[];
  };
  readonly tools: {
    readonly node: string;
    readonly npm: string;
    readonly bun: string;
    readonly buf: string;
    readonly javy: string;
  };
}

export type CloudflareVersionKey = "wrangler" | "vitestPoolWorkers" | "miniflare" | "workerd";

const stripV = (value: string): string => (value.startsWith("v") ? value.slice(1) : value);
const versionParts = (value: string): number[] => stripV(value).split(".").map(Number);

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left),
    b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function fail(path: string, message: string): never {
  throw new Error(`compatibility.${path}: ${message}`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// The config is a checked-in file this repo both writes and reads, so its shape is
// owned by CompatibilityConfig above. This guards the handful of typos a hand edit
// actually produces; validateSemantics does the checking that matters.
function assertShape(config: unknown): asserts config is CompatibilityConfig {
  const present = (path: string, value: unknown): void => {
    if (value === undefined || value === null) fail(path, "is missing");
  };
  if (typeof config !== "object" || config === null) fail("json", "must be an object");
  const value = config as Record<string, Record<string, unknown> | undefined>;
  for (const section of ["sqlc", "typescript", "cloudflare", "tools"]) present(section, value[section]);
  for (const field of ["supportedFloor", "testedCeiling", "samples", "knownExceptions"])
    present(`sqlc.${field}`, value.sqlc?.[field]);
  for (const field of ["floor", "current"]) present(`typescript.${field}`, value.typescript?.[field]);
  for (const field of [
    "workersTypes",
    "wrangler",
    "vitestPoolWorkers",
    "miniflare",
    "workerd",
    "compatibilityDate",
    "compatibilityFlags",
  ])
    present(`cloudflare.${field}`, value.cloudflare?.[field]);
  for (const field of ["node", "npm", "bun", "buf", "javy"]) present(`tools.${field}`, value.tools?.[field]);
  if (!Array.isArray(value.sqlc?.samples) || value.sqlc.samples.length === 0)
    fail("sqlc.samples", "must be a non-empty array");
}

export async function loadCompatibilityConfig({
  root = process.cwd(),
  checkLocal = false,
}: { root?: string; checkLocal?: boolean } = {}): Promise<CompatibilityConfig> {
  const source = await readFile(resolve(root, CONFIG_PATH), "utf8");
  let config: unknown;
  try {
    config = JSON.parse(source);
  } catch (error) {
    fail("json", error instanceof Error ? error.message : String(error));
  }
  assertShape(config);
  validateSemantics(config);
  const frozen = deepFreeze(structuredClone(config));
  if (checkLocal) await checkLocalCompatibility(frozen, root);
  return frozen;
}

function validateSemantics(config: CompatibilityConfig): void {
  const [year, month, day] = config.cloudflare.compatibilityDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail("cloudflare.compatibilityDate", "must be a valid calendar date");
  }
  const samples = config.sqlc.samples;
  const versions = samples.map(({ version }) => stripV(version));
  if (new Set(versions).size !== versions.length) fail("sqlc.samples", "versions must be unique");
  if (samples.filter(({ role }) => role === "floor").length !== 1)
    fail("sqlc.samples", "must contain exactly one floor role");
  if (samples.filter(({ role }) => role === "ceiling").length !== 1)
    fail("sqlc.samples", "must contain exactly one ceiling role");
  const last = samples[samples.length - 1];
  if (samples[0].role !== "floor" || last?.role !== "ceiling")
    fail("sqlc.samples", "floor and ceiling must be the first and last samples");
  if (stripV(config.sqlc.supportedFloor) !== versions[0])
    fail("sqlc.supportedFloor", `must equal first sample ${samples[0].version}`);
  if (stripV(config.sqlc.testedCeiling) !== versions[versions.length - 1])
    fail("sqlc.testedCeiling", `must equal last sample ${last?.version}`);
  for (let index = 1; index < versions.length; index++)
    if (compareVersions(versions[index - 1], versions[index]) >= 0)
      fail(`sqlc.samples[${index}].version`, "samples must be strictly ordered");
}

function actualVersion(entry: unknown): string | undefined {
  return Array.isArray(entry) ? String(entry[0]).replace(/^.*@(?=\d)/, "") : undefined;
}

function equal(path: string, expected: unknown, actual: unknown, file: string): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    fail(path, `expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)} in ${file}`);
}

function parseJsonc(text: string): any {
  return JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
}

async function json(root: string, path: string, jsonc = false): Promise<any> {
  const source = await readFile(resolve(root, path), "utf8");
  return jsonc ? parseJsonc(source) : JSON.parse(source);
}

export interface LocalCompatibilityFacts {
  typescript: { floor?: string; current?: string };
  workersTypes?: string;
  fixtureFacts: Record<CloudflareVersionKey, string | undefined>[];
  bunPaths: string[];
  wranglers: any[];
  wranglerPaths: string[];
  buf: string;
  javy: string;
}

export async function readLocalCompatibilityFacts(root = process.cwd()): Promise<LocalCompatibilityFacts> {
  const packageLock = await json(root, "package-lock.json");
  const bunPaths = ["test/miniflare/bun.lock", "examples/d1-worker/bun.lock"];
  const bunLocks = await Promise.all(bunPaths.map((path) => json(root, path, true)));
  const fixtureFacts = bunLocks.map((lock) => ({
    wrangler: actualVersion(lock.packages.wrangler),
    vitestPoolWorkers: actualVersion(lock.packages["@cloudflare/vitest-pool-workers"]),
    miniflare: actualVersion(lock.packages.miniflare),
    workerd: actualVersion(lock.packages["miniflare/workerd"]),
  }));
  const wranglerPaths = ["test/miniflare/wrangler.jsonc", "examples/d1-worker/wrangler.jsonc"];
  const wranglers = await Promise.all(wranglerPaths.map((path) => json(root, path, true)));
  const [bufScript, javyScript] = await Promise.all([
    readFile(resolve(root, "scripts/install-buf.sh"), "utf8"),
    readFile(resolve(root, "scripts/install-javy.sh"), "utf8"),
  ]);
  const scriptVersion = (source: string, file: string): string => {
    const match = source.match(/^VERSION="v([^"]+)"/m);
    if (!match) fail("tools", `VERSION constant missing from ${file}`);
    return match[1];
  };

  return {
    typescript: {
      floor: packageLock.packages["node_modules/typescript-5-2"]?.version,
      current: packageLock.packages["node_modules/typescript"]?.version,
    },
    workersTypes: packageLock.packages["node_modules/@cloudflare/workers-types"]?.version,
    fixtureFacts,
    bunPaths,
    wranglers,
    wranglerPaths,
    buf: scriptVersion(bufScript, "scripts/install-buf.sh"),
    javy: scriptVersion(javyScript, "scripts/install-javy.sh"),
  };
}

export async function checkLocalCompatibility(
  config: CompatibilityConfig,
  root = process.cwd(),
): Promise<CompatibilityConfig> {
  const facts = await readLocalCompatibilityFacts(root);
  equal("typescript.floor", config.typescript.floor, facts.typescript.floor, "package-lock.json");
  equal("typescript.current", config.typescript.current, facts.typescript.current, "package-lock.json");
  equal("cloudflare.workersTypes", config.cloudflare.workersTypes, facts.workersTypes, "package-lock.json");
  const fields: CloudflareVersionKey[] = ["wrangler", "vitestPoolWorkers", "miniflare", "workerd"];
  for (let index = 0; index < facts.fixtureFacts.length; index++)
    for (const field of fields)
      equal(`cloudflare.${field}`, config.cloudflare[field], facts.fixtureFacts[index][field], facts.bunPaths[index]);
  equal("cloudflare.fixtureGraphs", facts.fixtureFacts[0], facts.fixtureFacts[1], facts.bunPaths.join(" and "));
  for (let index = 0; index < facts.wranglers.length; index++) {
    equal(
      "cloudflare.compatibilityDate",
      config.cloudflare.compatibilityDate,
      facts.wranglers[index].compatibility_date,
      facts.wranglerPaths[index],
    );
    equal(
      "cloudflare.compatibilityFlags",
      config.cloudflare.compatibilityFlags,
      facts.wranglers[index].compatibility_flags,
      facts.wranglerPaths[index],
    );
  }
  equal("tools.buf", config.tools.buf, facts.buf, "scripts/install-buf.sh");
  equal("tools.javy", config.tools.javy, facts.javy, "scripts/install-javy.sh");
  return config;
}

export function assertSqlcPolicy(
  config: CompatibilityConfig,
  policy: { supportedFloor: string; testedCeiling: string },
): void {
  equal("sqlc.supportedFloor", stripV(config.sqlc.supportedFloor), policy.supportedFloor, "src/validation.ts");
  equal("sqlc.testedCeiling", stripV(config.sqlc.testedCeiling), policy.testedCeiling, "src/validation.ts");
}

export function renderCompatibilityFacts(config: CompatibilityConfig): string {
  const cloudflareKeys = [
    "workersTypes",
    "wrangler",
    "vitestPoolWorkers",
    "miniflare",
    "workerd",
    "compatibilityDate",
  ] as const;
  const toolKeys = ["node", "npm", "bun", "buf", "javy"] as const;
  const rows: [string, string][] = [
    ["sqlc.supportedFloor", config.sqlc.supportedFloor],
    ["sqlc.testedCeiling", config.sqlc.testedCeiling],
    ["sqlc.samples", config.sqlc.samples.map(({ version }) => version).join(", ")],
    ["typescript.floor", config.typescript.floor],
    ["typescript.current", config.typescript.current],
    ...cloudflareKeys.map((key): [string, string] => [`cloudflare.${key}`, config.cloudflare[key]]),
    ["cloudflare.compatibilityFlags", config.cloudflare.compatibilityFlags.join(",") || "[]"],
    ...toolKeys.map((key): [string, string] => [`tools.${key}`, config.tools[key]]),
  ];
  return rows.map(([field, value]) => `${field}=${value}`).join("\n");
}
