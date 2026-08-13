import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import test from "node:test";

const root = process.cwd();
const documents = [
  "README.md",
  "docs/generated-code-tour.md",
  "docs/sqlc-to-d1.md",
  "docs/runtime-and-errors.md",
  "docs/compatibility.md",
  "docs/troubleshooting.md",
] as const;
const candidate = process.env.CANDIDATE_WASM;
const sha256 = process.env.CANDIDATE_SHA256;
const sqlc = process.env.SQLC_BIN;

const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const slug = (heading: string): string => heading.toLowerCase().trim().replace(/<[^>]+>/g, "").replace(/[^a-z0-9 -]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-");

function links(source: string): Array<{ label: string; target: string }> {
  return [...source.matchAll(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g)].map((match) => ({ label: match[1], target: match[2] }));
}

function assertDocumentLinks(path: string, source: string): void {
  const sourceDirectory = dirname(resolve(root, path));
  for (const { target } of links(source)) {
    if (/^https?:/.test(target)) {
      assert.match(target, /^https:\/\//, `${path}: external links must use HTTPS: ${target}`);
      continue;
    }
    if (target.startsWith("mailto:")) continue;
    const [filePart, anchor] = target.split("#", 2);
    const destination = filePart ? resolve(sourceDirectory, decodeURIComponent(filePart)) : resolve(root, path);
    assert.ok(destination === root || destination.startsWith(`${root}${sep}`), `${path}: link escapes repository: ${target}`);
    assert.ok(existsSync(destination), `${path}: missing relative link target ${target}`);
    if (statSync(destination).isDirectory()) {
      assert.equal(anchor, undefined, `${path}: directory link cannot have an anchor: ${target}`);
      continue;
    }
    const destinationSource = readFileSync(destination, "utf8");
    if (anchor) {
      const anchors = new Set([...destinationSource.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1])));
      assert.ok(anchors.has(anchor), `${path}: missing anchor #${anchor} in ${target}`);
    }
  }
}

const normalizeMarkdown = (value: string): string => value.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();

function firstTableAfterHeading(source: string, heading: string): string[][] {
  const marker = `## ${heading}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const contentStart = start + marker.length;
  const nextHeading = source.indexOf("\n## ", contentStart);
  const section = source.slice(contentStart, nextHeading === -1 ? undefined : nextHeading);
  const rows = section.split("\n").filter((line) => /^\|.*\|$/.test(line));
  assert.ok(rows.length >= 2, `${heading}: missing Markdown table`);
  assert.match(rows[1], /^\|(?:\s*:?-+:?\s*\|)+$/, `${heading}: malformed Markdown table separator`);
  return rows.slice(2).map((line) => line.slice(1, -1).split("|").map(normalizeMarkdown));
}

function readmeYaml(): string {
  const match = /```yaml\n([\s\S]*?)\n```/.exec(read("README.md"));
  assert.ok(match, "README.md: missing sqlc YAML fence");
  return match[1];
}

function readmeSqlFences(): string[] {
  return [...read("README.md").matchAll(/```sql\n([\s\S]*?)\n```/g)].map((match) => `${match[1]}\n`);
}

function diagnosticIdsFromSource(): string[] {
  const ids = new Set<string>();
  for (const path of ["src/plugin.ts", "src/validation.ts", "src/emission-plan.ts", "src/diagnostics.ts"]) {
    const source = read(path);
    for (const match of source.matchAll(/error\(\s*"([A-Z]+)"\s*,\s*"([A-Z_]+)"/g)) ids.add(`${match[1]}/${match[2]}`);
    for (const match of source.matchAll(/emissionError\(\s*"([A-Z_]+)"/g)) ids.add(`EMISSION/${match[1]}`);
    for (const match of source.matchAll(/category:\s*"([A-Z]+)"[\s\S]{0,120}?reason:\s*"([A-Z_]+)"/g)) ids.add(`${match[1]}/${match[2]}`);
  }
  return [...ids].sort();
}

interface Fence { path: string; id: string; source: string }
function publicTypeScriptFences(): Fence[] {
  const fences: Fence[] = [];
  const ids = new Set<string>();
  for (const path of documents) {
    const source = read(path);
    const taggedStarts = new Map<number, string>();
    for (const match of source.matchAll(/<!--\s*compile:\s*([a-z][a-z0-9-]*)\s*-->\s*\n```ts\n/g)) taggedStarts.set(match.index + match[0].length, match[1]);
    for (const match of source.matchAll(/```ts\n([\s\S]*?)\n```/g)) {
      const start = match.index + "```ts\n".length;
      const id = taggedStarts.get(start);
      assert.ok(id, `${path}: untagged public TypeScript fence at offset ${match.index}`);
      assert.equal(ids.has(id), false, `${path}: duplicate compile ID ${id}`);
      ids.add(id); fences.push({ path, id, source: match[1] });
    }
  }
  return fences;
}

function compileFence(fence: Fence, generated: string, compiler: "typescript-5-2" | "typescript"): void {
  const directory = mkdtempSync(resolve(tmpdir(), `sqlc-d1-doc-${fence.id}-`));
  try {
    cpSync(generated, directory, { recursive: true });
    let scaffold = "";
    if (fence.id === "tour-get-user-types") scaffold = `
import type { GetUserArgs as ActualArgs, GetUserRow as ActualRow } from "./queries_sql";
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;
type Expect<T extends true> = T;
type _ArgsEqual = Expect<Equal<GetUserArgs, ActualArgs>>;
type _ArgsEqualReverse = Expect<Equal<ActualArgs, GetUserArgs>>;
type _RowEqual = Expect<Equal<GetUserRow, ActualRow>>;
type _RowEqualReverse = Expect<Equal<ActualRow, GetUserRow>>;
`;
    writeFileSync(resolve(directory, "snippet.ts"), `${fence.source}\n${scaffold}`);
    writeFileSync(resolve(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      strict: true, noEmit: true, target: "ES2020", module: "ESNext", moduleResolution: "node",
      types: ["@cloudflare/workers-types"], typeRoots: [resolve(root, "node_modules/@types"), resolve(root, "node_modules")], skipLibCheck: true,
    }, include: ["**/*.ts"] }));
    const tsc = resolve(root, `node_modules/${compiler}/lib/tsc.js`);
    const result = spawnSync(process.execPath, [tsc, "-p", resolve(directory, "tsconfig.json")], { encoding: "utf8" });
    assert.equal(result.status, 0, `${fence.path} (${fence.id}, ${compiler}):\n${result.stdout}\n${result.stderr}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("verification/documentation-contract validates pages, headings, links, release configuration, and public boundaries", () => {
  const requiredHeadings: Record<(typeof documents)[number], string[]> = {
    "README.md": ["Select and configure a release", "Generate your first query", "Learn the public surface", "Known rough edges"],
    "docs/generated-code-tour.md": ["Generated-code tour", "Mental model"],
    "docs/sqlc-to-d1.md": ["sqlc-to-D1 translation", "Commands", "Parameters and macros", "Fail-closed boundaries"],
    "docs/runtime-and-errors.md": ["Runtime, batches, sessions, and errors", "Batch shapes", "Sessions and bookmarks", "Public error classes"],
    "docs/compatibility.md": ["Compatibility and release evidence", "sqlc support policy", "Managed D1 status"],
    "docs/troubleshooting.md": ["Troubleshooting", "Complete stable identifier inventory", "Runtime errors"],
  };
  const all = documents.map((path) => read(path)).join("\n");
  for (const path of documents) {
    const source = read(path);
    for (const heading of requiredHeadings[path]) assert.match(source, new RegExp(`^#{1,6} ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), `${path}: missing heading ${heading}`);
    assertDocumentLinks(path, source);
  }
  const yaml = readmeYaml();
  assert.match(yaml, /^version: "2"$/m);
  assert.match(yaml, /^\s+url: https:\/\/sqlc\.mkuznets\.com\/plugins\/sqlc-gen-d1-typescript_<selected-version>\.wasm$/m);
  assert.match(yaml, /^\s+sha256: <selected-sha256>$/m);
  assert.match(yaml, /^\s+interface: workers$/m);
  const [schema, firstQuery] = readmeSqlFences();
  assert.equal(schema, read("examples/d1-worker/migrations/0001_init.sql"), "README.md: schema must match the canonical Worker");
  assert.equal(firstQuery, `${read("examples/d1-worker/queries.sql").split("\n\n")[0]}\n`, "README.md: first query must match the canonical Worker");
  assert.doesNotMatch(all, /latest[^\n)]*\.wasm/i);
  assert.doesNotMatch(all, /docs\/prototypes|human-documentation-structure/);
  assert.doesNotMatch(all, /generatedInternals|parseGetUserRow|d1_values|d1_Context/);
  assert.doesNotMatch(all, /kind:\s*["'](?:one|many|exec)|params:\s*Object\.freeze|descriptor\.sql\b/);
  publicTypeScriptFences();
  assert.deepEqual(diagnosticIdsFromSource(), [...read("docs/troubleshooting.md").matchAll(/^- `\[([A-Z]+\/[A-Z_]+)\]`/gm)].map((match) => match[1]).sort());
});

test("verification/documentation-facts matches compatibility and scoped evidence facts", () => {
  const config = JSON.parse(read("verification/compatibility.json")) as {
    sqlc: { supportedFloor: string; testedCeiling: string; samples: Array<{ version: string; role: string; rationale: string }>; knownExceptions: string[] };
    typescript: { floor: string; current: string };
    cloudflare: Record<string, string | string[]>;
    tools: Record<string, string>;
  };
  const guide = read("docs/compatibility.md");
  for (const fact of [config.sqlc.supportedFloor, config.sqlc.testedCeiling, config.typescript.floor, config.typescript.current]) assert.ok(guide.includes(fact), `docs/compatibility.md: missing ${fact}`);
  for (const exception of config.sqlc.knownExceptions) assert.ok(normalizeMarkdown(guide).includes(normalizeMarkdown(exception)), `docs/compatibility.md: missing ${exception}`);
  assert.deepEqual(
    firstTableAfterHeading(guide, "sqlc support policy"),
    config.sqlc.samples.map(({ version, role, rationale }) => [version, role, normalizeMarkdown(rationale)]),
    "docs/compatibility.md: strategic sqlc table must exactly match compatibility.json",
  );
  assert.deepEqual(firstTableAfterHeading(guide, "TypeScript evidence"), [
    ["supported floor compiler", config.typescript.floor],
    ["current compiler evidence", config.typescript.current],
  ], "docs/compatibility.md: TypeScript table must exactly match compatibility.json");
  assert.deepEqual(firstTableAfterHeading(guide, "Cloudflare local evidence baseline"), [
    ["Workers types", String(config.cloudflare.workersTypes)],
    ["Wrangler", String(config.cloudflare.wrangler)],
    ["Vitest Pool Workers", String(config.cloudflare.vitestPoolWorkers)],
    ["Miniflare", String(config.cloudflare.miniflare)],
    ["workerd", String(config.cloudflare.workerd)],
    ["compatibility date", String(config.cloudflare.compatibilityDate)],
    ["compatibility flags", "none ([])"],
  ], "docs/compatibility.md: Cloudflare table must exactly match compatibility.json");
  for (const fact of Object.values(config.tools)) assert.ok(guide.includes(fact), `docs/compatibility.md: missing evidence fact ${fact}`);
  assert.match(guide, /not yet part of current evidence/i);
  assert.doesNotMatch(guide, /managed D1 (?:is|has been) (?:tested|verified|supported)/i);
  const readme = read("README.md");
  for (const size of ["221.17 KiB / 55.29 KiB gzip", "258.26 KiB / 61.36 KiB gzip", "241.68 KiB / 59.51 KiB gzip", "+37.09 KiB / +6.07 KiB gzip", "16.58 KiB / 1.85 KiB gzip", "Wrangler `4.120.0`"]) assert.ok(readme.includes(size), `README.md: missing bundle fact ${size}`);
  assert.match(readme, /one historical Worker observation/i);
  assert.notEqual(config.cloudflare.wrangler, "4.120.0");
});

test("verification/documentation-snippets generates canonical files and compiles every excerpt against the exact candidate", async () => {
  if (!candidate || !sha256 || !sqlc) throw new Error("CANDIDATE_WASM, CANDIDATE_SHA256, and SQLC_BIN are required");
  const { readCandidate } = await import("../scripts/candidate-utils.mjs") as { readCandidate(candidate: string, sha256: string): Promise<unknown> };
  const { compareGeneratedTrees } = await import("../scripts/check-generated-drift.mjs");
  const { generateCandidate } = await import("../scripts/generate-candidate.mjs");
  await readCandidate(candidate, sha256);
  const directory = mkdtempSync(resolve(tmpdir(), "sqlc-d1-documentation-"));
  try {
    mkdirSync(resolve(directory, "migrations"), { recursive: true });
    cpSync(resolve(root, "examples/d1-worker/migrations/0001_init.sql"), resolve(directory, "migrations/0001_init.sql"));
    cpSync(resolve(root, "examples/d1-worker/queries.sql"), resolve(directory, "queries.sql"));
    writeFileSync(resolve(directory, "sqlc.yaml"), readmeYaml());
    await generateCandidate({ candidate, sha256, config: "sqlc.yaml", cwd: directory, sqlc });
    const differences = await compareGeneratedTrees(resolve(root, "examples/d1-worker/src"), resolve(directory, "src"), ["index.ts"]);
    assert.deepEqual(differences, [], `canonical generated drift: ${JSON.stringify(differences)}`);
    assert.deepEqual(readdirSync(resolve(directory, "src")).sort(), ["queries_sql.ts", "runtime.ts"]);
    for (const fence of publicTypeScriptFences()) {
      compileFence(fence, resolve(directory, "src"), "typescript-5-2");
      compileFence(fence, resolve(directory, "src"), "typescript");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
