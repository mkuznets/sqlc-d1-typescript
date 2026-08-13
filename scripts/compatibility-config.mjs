import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const CONFIG_PATH = "verification/compatibility.json";
const SCHEMA_PATH = "verification/compatibility.schema.json";
const stripV = (value) => value.startsWith("v") ? value.slice(1) : value;
const versionParts = (value) => stripV(value).split(".").map(Number);
export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}
function fail(path, message) { throw new Error(`compatibility.${path}: ${message}`); }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
export async function loadCompatibilityConfig({ root = process.cwd(), checkLocal = false } = {}) {
  const [source, schema] = await Promise.all([
    readFile(resolve(root, CONFIG_PATH), "utf8"),
    readFile(resolve(root, SCHEMA_PATH), "utf8"),
  ]);
  let config;
  try { config = JSON.parse(source); } catch (error) { fail("json", error.message); }
  const validate = new Ajv2020({ allErrors: true, strict: false, formats: { date: /^\d{4}-\d{2}-\d{2}$/ } }).compile(JSON.parse(schema));
  if (!validate(config)) {
    const errors = validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).sort();
    fail("schema", errors.join("; "));
  }
  validateSemantics(config);
  const frozen = deepFreeze(structuredClone(config));
  if (checkLocal) await checkLocalCompatibility(frozen, root);
  return frozen;
}
function validateSemantics(config) {
  const [year, month, day] = config.cloudflare.compatibilityDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail("cloudflare.compatibilityDate", "must be a valid calendar date");
  }
  const samples = config.sqlc.samples;
  const versions = samples.map(({ version }) => stripV(version));
  if (new Set(versions).size !== versions.length) fail("sqlc.samples", "versions must be unique");
  if (samples.filter(({ role }) => role === "floor").length !== 1) fail("sqlc.samples", "must contain exactly one floor role");
  if (samples.filter(({ role }) => role === "ceiling").length !== 1) fail("sqlc.samples", "must contain exactly one ceiling role");
  if (samples[0].role !== "floor" || samples.at(-1).role !== "ceiling") fail("sqlc.samples", "floor and ceiling must be the first and last samples");
  if (stripV(config.sqlc.supportedFloor) !== versions[0]) fail("sqlc.supportedFloor", `must equal first sample ${samples[0].version}`);
  if (stripV(config.sqlc.testedCeiling) !== versions.at(-1)) fail("sqlc.testedCeiling", `must equal last sample ${samples.at(-1).version}`);
  for (let index = 1; index < versions.length; index++) if (compareVersions(versions[index - 1], versions[index]) >= 0) fail(`sqlc.samples[${index}].version`, "samples must be strictly ordered");
}
function actualVersion(entry) { return Array.isArray(entry) ? String(entry[0]).replace(/^.*@(?=\d)/, "") : undefined; }
function equal(path, expected, actual, file) { if (JSON.stringify(expected) !== JSON.stringify(actual)) fail(path, `expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)} in ${file}`); }
function parseJsonc(text) { return JSON.parse(text.replace(/,\s*([}\]])/g, "$1")); }
async function json(root, path, jsonc = false) { const source = await readFile(resolve(root, path), "utf8"); return jsonc ? parseJsonc(source) : JSON.parse(source); }
export async function readLocalCompatibilityFacts(root = process.cwd()) {
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
  const [bufScript, javyScript] = await Promise.all([readFile(resolve(root, "scripts/install-buf.sh"), "utf8"), readFile(resolve(root, "scripts/install-javy.sh"), "utf8")]);
  const scriptVersion = (source, file) => { const match = source.match(/^VERSION="v([^\"]+)"/m); if (!match) fail("tools", `VERSION constant missing from ${file}`); return match[1]; };
  return {
    typescript: {
      floor: packageLock.packages["node_modules/typescript-5-2"]?.version,
      current: packageLock.packages["node_modules/typescript"]?.version,
    },
    workersTypes: packageLock.packages["node_modules/@cloudflare/workers-types"]?.version,
    fixtureFacts, bunPaths,
    wranglers, wranglerPaths,
    buf: scriptVersion(bufScript, "scripts/install-buf.sh"),
    javy: scriptVersion(javyScript, "scripts/install-javy.sh"),
  };
}
export async function checkLocalCompatibility(config, root = process.cwd()) {
  const facts = await readLocalCompatibilityFacts(root);
  equal("typescript.floor", config.typescript.floor, facts.typescript.floor, "package-lock.json");
  equal("typescript.current", config.typescript.current, facts.typescript.current, "package-lock.json");
  equal("cloudflare.workersTypes", config.cloudflare.workersTypes, facts.workersTypes, "package-lock.json");
  for (let index = 0; index < facts.fixtureFacts.length; index++) for (const field of ["wrangler", "vitestPoolWorkers", "miniflare", "workerd"]) equal(`cloudflare.${field}`, config.cloudflare[field], facts.fixtureFacts[index][field], facts.bunPaths[index]);
  equal("cloudflare.fixtureGraphs", facts.fixtureFacts[0], facts.fixtureFacts[1], facts.bunPaths.join(" and "));
  for (let index = 0; index < facts.wranglers.length; index++) {
    equal("cloudflare.compatibilityDate", config.cloudflare.compatibilityDate, facts.wranglers[index].compatibility_date, facts.wranglerPaths[index]);
    equal("cloudflare.compatibilityFlags", config.cloudflare.compatibilityFlags, facts.wranglers[index].compatibility_flags, facts.wranglerPaths[index]);
  }
  equal("tools.buf", config.tools.buf, facts.buf, "scripts/install-buf.sh");
  equal("tools.javy", config.tools.javy, facts.javy, "scripts/install-javy.sh");
  return config;
}
export function assertSqlcPolicy(config, policy) {
  equal("sqlc.supportedFloor", stripV(config.sqlc.supportedFloor), policy.supportedFloor, "src/validation.ts");
  equal("sqlc.testedCeiling", stripV(config.sqlc.testedCeiling), policy.testedCeiling, "src/validation.ts");
}
export function renderCompatibilityFacts(config) {
  const rows = [
    ["sqlc.supportedFloor", config.sqlc.supportedFloor], ["sqlc.testedCeiling", config.sqlc.testedCeiling],
    ["sqlc.samples", config.sqlc.samples.map(({ version }) => version).join(", ")],
    ["typescript.floor", config.typescript.floor], ["typescript.current", config.typescript.current],
    ...["workersTypes", "wrangler", "vitestPoolWorkers", "miniflare", "workerd", "compatibilityDate"].map((key) => [`cloudflare.${key}`, config.cloudflare[key]]),
    ["cloudflare.compatibilityFlags", config.cloudflare.compatibilityFlags.join(",") || "[]"],
    ...["node", "npm", "bun", "buf", "javy"].map((key) => [`tools.${key}`, config.tools[key]]),
  ];
  return rows.map(([field, value]) => `${field}=${value}`).join("\n");
}
