import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONFIG_PATH = "verification/compatibility.json";

export type SqlcRole = "floor" | "intervening" | "ceiling";

export interface CompatibilityConfig {
  readonly sqlc: {
    readonly supportedFloor: string;
    readonly testedCeiling: string;
    readonly samples: readonly { readonly version: string; readonly role: SqlcRole; readonly rationale: string }[];
    readonly knownExceptions: readonly string[];
  };
  readonly typescript: { readonly floor: string; readonly current: string };
  readonly tools: { readonly node: string; readonly npm: string; readonly bun: string };
}

const stripV = (value: string): string => (value.startsWith("v") ? value.slice(1) : value);

function compareVersions(left: string, right: string): number {
  const a = stripV(left).split(".").map(Number);
  const b = stripV(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function fail(path: string, message: string): never {
  throw new Error(`compatibility.${path}: ${message}`);
}

// The config is a checked-in file this repo owns, so its shape is owned by
// CompatibilityConfig above. This guards the handful of typos a hand edit actually
// produces; validateSemantics does the checking that matters.
function assertShape(config: unknown): asserts config is CompatibilityConfig {
  const present = (path: string, value: unknown): void => {
    if (value === undefined || value === null) fail(path, "is missing");
  };
  if (typeof config !== "object" || config === null) fail("json", "must be an object");
  const value = config as Record<string, Record<string, unknown> | undefined>;
  for (const section of ["sqlc", "typescript", "tools"]) present(section, value[section]);
  for (const field of ["supportedFloor", "testedCeiling", "samples", "knownExceptions"])
    present(`sqlc.${field}`, value.sqlc?.[field]);
  for (const field of ["floor", "current"]) present(`typescript.${field}`, value.typescript?.[field]);
  for (const field of ["node", "npm", "bun"]) present(`tools.${field}`, value.tools?.[field]);
  if (!Array.isArray(value.sqlc?.samples) || value.sqlc.samples.length === 0)
    fail("sqlc.samples", "must be a non-empty array");
}

function validateSemantics(config: CompatibilityConfig): void {
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

export async function loadCompatibilityConfig({
  root = process.cwd(),
}: { root?: string } = {}): Promise<CompatibilityConfig> {
  const source = await readFile(resolve(root, CONFIG_PATH), "utf8");
  let config: unknown;
  try {
    config = JSON.parse(source);
  } catch (error) {
    fail("json", error instanceof Error ? error.message : String(error));
  }
  assertShape(config);
  validateSemantics(config);
  return config;
}
