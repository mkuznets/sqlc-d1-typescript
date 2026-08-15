import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const release = () => import("../scripts/release-contract.mjs");

const SKILL_DIR = "skills/sqlc-d1-typescript";
const SKILL = `${SKILL_DIR}/SKILL.md`;
const PROBE_VERSION = "9.9.9";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const inlineCode = (source: string): string[] => [...source.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
// Fences nested in a list item carry their indentation; strip it so the block reads as written.
const fencedCode = (source: string, language: string): string[] =>
  [...source.matchAll(/^([ \t]*)```([a-z]*)\n([\s\S]*?)^\1```/gm)]
    .filter((match) => match[2] === language)
    .map((match) => match[3].replace(new RegExp(`^${match[1]}`, "gm"), ""));

function skillFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const name of readdirSync(resolve(process.cwd(), directory)).sort()) {
      const path = join(directory, name);
      if (statSync(resolve(process.cwd(), path)).isDirectory()) walk(path);
      else files.set(path, read(path));
    }
  };
  walk(SKILL_DIR);
  return files;
}

function frontmatter(source: string): Map<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(source);
  assert.ok(block, `${SKILL} must open with a YAML frontmatter block`);
  const fields = new Map<string, string>();
  let key: string | undefined;
  for (const line of block[1].split("\n")) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (entry) {
      key = entry[1];
      fields.set(key, entry[2].trim());
    } else if (key !== undefined && /^\s+\S/.test(line)) {
      fields.set(key, `${fields.get(key)} ${line.trim()}`.trim());
    }
  }
  return fields;
}

const exportedNames = (path: string): Set<string> =>
  new Set(
    [...read(path).matchAll(/^export (?:abstract )?(?:class|function|const|type|interface) (\w+)/gm)].map(
      (match) => match[1],
    ),
  );

const sqlStatements = (source: string): string[] =>
  source
    .replace(/--[^\n]*/g, " ")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim().toLowerCase())
    .filter((statement) => statement !== "");

// Every key nested under an `options:` mapping in one YAML block, as written.
function optionKeys(block: string): string[] {
  const lines = block.split("\n");
  const keys: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const opener = /^(\s*)options:\s*$/.exec(lines[index]);
    if (!opener) continue;
    for (let next = index + 1; next < lines.length; next++) {
      if (lines[next].trim() === "") continue;
      if (lines[next].length - lines[next].trimStart().length <= opener[1].length) break;
      keys.push(lines[next].trim());
    }
  }
  return keys;
}

const FORBIDDEN = [
  "as any",
  "as unknown as",
  "@ts-ignore",
  "@ts-expect-error",
  "wrangler deploy",
  "--remote",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "d1 execute --remote",
  "node:sqlite",
  "better-sqlite3",
  "D1 HTTP API",
  "REST API",
];

const VOCABULARY = [
  "Workers binding interface",
  "query descriptor",
  "query executor",
  "session executor",
  "session bookmark",
];

const REPLACED_TERMS = ["prepared statement", "database driver", "as a transaction"];

test("verification/consumer-skill binds the shipped skill to the canonical Worker, docs, and release contract", async () => {
  const files = skillFiles();
  const skill = read(SKILL);
  const readme = read("README.md");
  const allSkillText = [...files.values()].join("\n");

  // 1. Frontmatter mechanics.
  const fields = frontmatter(skill);
  assert.equal(fields.get("name"), basename(SKILL_DIR), `${SKILL} must be named after its directory`);
  assert.ok((fields.get("description") ?? "").length > 0, `${SKILL} must carry a description`);
  assert.ok(
    !fields.has("disable-model-invocation"),
    `${SKILL} stays model-invoked; a consumer describes the task in their own words`,
  );

  // 2. No version facts.
  for (const [file, source] of files) {
    const version = /\d+\.\d+/.exec(source);
    assert.equal(
      version,
      null,
      `${file} states the version fact "${version?.[0]}"; the release record and verification/compatibility.json own those`,
    );
  }

  // 3. Release contract shapes.
  const { canonicalWasmFilename, canonicalManifestFilename } = await release();
  const schema = JSON.parse(read("verification/release-manifest.schema.json"));
  const artifactUrl = `https://sqlc.mkuznets.com/plugins/${canonicalWasmFilename(PROBE_VERSION)}`;
  assert.match(artifactUrl, new RegExp(schema.properties.artifact.properties.url.pattern));
  const urlTemplate = artifactUrl.replace(PROBE_VERSION, "<version>");
  for (const [file, source] of files)
    for (const match of source.matchAll(/https:\/\/sqlc\.mkuznets\.com\/\S+/g)) {
      const url = match[0].replace(/[).,`]+$/, "");
      assert.equal(url, urlTemplate, `${file} must name the canonical artifact URL as ${urlTemplate}`);
    }
  assert.ok(allSkillText.includes(urlTemplate), `the skill must name the artifact URL ${urlTemplate}`);
  const manifestTemplate = canonicalManifestFilename(PROBE_VERSION).replace(PROBE_VERSION, "<version>");
  assert.ok(allSkillText.includes(manifestTemplate), `the skill must name the release manifest ${manifestTemplate}`);
  assert.ok(
    skill.includes("64 lowercase hexadecimal characters"),
    `${SKILL} must state the digest as 64 lowercase hexadecimal characters`,
  );

  // 4. Tag-pinned links.
  let links = 0;
  for (const [file, source] of files)
    for (const match of source.matchAll(
      /https:\/\/github\.com\/mkuznets\/sqlc-d1-typescript\/blob\/([^/]+)\/([^)\s]+)/g,
    )) {
      links += 1;
      assert.equal(match[1], "v<version>", `${file} must pin ${match[2]} to the installed tag`);
      assert.ok(existsSync(resolve(process.cwd(), match[2])), `${file} links to ${match[2]}, which does not exist`);
    }
  assert.ok(links > 0, "the skill must reach the tag-pinned human documentation");

  // 5. The install contract.
  assert.ok(skill.includes("INSTALLED_TAG"), `${SKILL} must check INSTALLED_TAG before doing anything else`);
  const install = fencedCode(readme, "sh").find((block) => block.includes("git clone"));
  assert.ok(install, "README.md must carry the tag-matched install command");
  assert.ok(install.includes('--branch "v$VERSION"'), "README.md must install the skill from the matching tag");
  assert.ok(
    install.includes(".claude/skills/sqlc-d1-typescript/INSTALLED_TAG"),
    "README.md must record the installed tag in INSTALLED_TAG",
  );
  // An upgrade re-runs the command, so it must replace the previous install rather than nest inside it.
  const removal = install.indexOf("rm -rf .claude/skills/sqlc-d1-typescript");
  assert.ok(removal >= 0, "README.md must remove the previous install before copying the new one");
  assert.ok(removal < install.indexOf("cp -R"), "README.md must remove the previous install before copying");
  // The skill repeats the command at its mismatch stop; the two must not drift.
  const remedy = fencedCode(skill, "sh").find((block) => block.includes("git clone"));
  assert.ok(remedy, `${SKILL} must give the install command for the matching tag at its mismatch stop`);
  for (const line of remedy.split("\n").filter((candidate) => candidate.trim() !== ""))
    if (!line.startsWith("VERSION="))
      assert.ok(install.includes(line.trim()), `${SKILL} installs with "${line.trim()}", which README.md does not`);
  for (const file of files.keys())
    assert.notEqual(basename(file), "INSTALLED_TAG", `${file} is written at install time, not shipped`);

  // 6. Diagnostic phases.
  const categoryType = /export type DiagnosticCategory =([^;]+);/.exec(read("src/diagnostics.ts"));
  assert.ok(categoryType, "src/diagnostics.ts must declare DiagnosticCategory");
  const categories = [...categoryType[1].matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]);
  for (const [file, source] of files)
    for (const match of source.matchAll(/\[([A-Z][A-Z_]*)\/([A-Z][A-Z_]*)\]/g))
      assert.ok(
        match[1] === "CATEGORY" || categories.includes(match[1]),
        `${file} names the diagnostic phase ${match[1]}, which src/diagnostics.ts does not define`,
      );
  for (const category of categories)
    assert.ok(allSkillText.includes(category), `the skill must route the ${category} diagnostic phase`);

  // 7. Runtime error classes and their safe context.
  const runtime = read("src/runtime.d1.ts");
  const shipped = runtime.slice(runtime.indexOf("RUNTIME BEGIN"), runtime.indexOf("RUNTIME END"));
  const errorClasses = [...shipped.matchAll(/^export (?:abstract )?class (\w+)/gm)]
    .map((match) => match[1])
    .filter((name) => name.endsWith("Error"));
  assert.ok(errorClasses.length > 0, "src/runtime.d1.ts must export error classes between the runtime markers");
  for (const name of errorClasses)
    assert.ok(allSkillText.includes(name), `the skill must name the runtime error class ${name}`);
  for (const [file, source] of files)
    for (const token of inlineCode(source))
      if (/^[A-Z]\w*Error$/.test(token))
        assert.ok(errorClasses.includes(token), `${file} names ${token}, which the shipped runtime does not export`);
  assert.ok(
    allSkillText.includes("`SqlcD1Error` is the base class"),
    "the skill must name SqlcD1Error as the base class carrying the safe context",
  );
  const contextType = /export interface SqlcD1ErrorContext \{([\s\S]*?)\n\}/.exec(shipped);
  assert.ok(contextType, "src/runtime.d1.ts must declare SqlcD1ErrorContext");
  const contextFields = [...contextType[1].matchAll(/readonly (\w+)\??:/g)].map((match) => match[1]);
  for (const field of contextFields)
    assert.ok(allSkillText.includes(`\`${field}\``), `the skill must name the safe context field ${field}`);

  // 8. Snippet imports.
  const generated = new Map([
    ["runtime", exportedNames("examples/d1-worker/src/runtime.ts")],
    ["queries_sql", exportedNames("examples/d1-worker/src/queries_sql.ts")],
  ]);
  let imports = 0;
  for (const [file, source] of files)
    for (const block of fencedCode(source, "ts"))
      for (const match of block.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
        const module = match[2].replace(/^.*\//, "");
        const available = generated.get(module);
        if (!available) continue;
        imports += 1;
        for (const symbol of match[1]
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean))
          assert.ok(
            available.has(symbol),
            `${file} imports ${symbol} from ${match[2]}, which the canonical Worker does not export`,
          );
      }
  assert.ok(imports > 0, "the skill must show the generated public API in use");

  // 9. Snippet SQL.
  const canonicalSql = new Set([
    ...sqlStatements(read("examples/d1-worker/migrations/0001_init.sql")),
    ...sqlStatements(read("examples/d1-worker/queries.sql")),
  ]);
  for (const [file, source] of files)
    for (const block of fencedCode(source, "sql"))
      for (const statement of sqlStatements(block))
        assert.ok(canonicalSql.has(statement), `${file} shows SQL absent from examples/d1-worker/: ${statement}`);

  // 10. The option surface.
  const validation = read("src/validation.ts");
  const supportedKey = /UNKNOWN_OPTION",\s*`[^`]*supported option: \$\{quoteDiagnosticValue\("(\w+)"\)\}/.exec(
    validation,
  );
  const supportedValue = /UNSUPPORTED_INTERFACE",\s*`[^`]*must be \$\{quoteDiagnosticValue\("(\w+)"\)\}/.exec(
    validation,
  );
  assert.ok(supportedKey && supportedValue, "src/validation.ts must name its supported option and value");
  const onlyOption = `${supportedKey[1]}: ${supportedValue[1]}`;
  for (const [file, source] of files)
    for (const block of fencedCode(source, "yaml"))
      for (const key of optionKeys(block))
        assert.equal(key, onlyOption, `${file} configures ${key}; the only option is ${onlyOption}`);

  // 11. One boundary, no credentials.
  for (const [file, source] of files)
    for (const token of FORBIDDEN)
      assert.ok(!source.includes(token), `${file} names ${token}, which is outside what this skill drives`);

  // 12. The fixed vocabulary.
  const context = read("CONTEXT.md");
  for (const term of VOCABULARY) {
    assert.ok(context.toLowerCase().includes(term.toLowerCase()), `CONTEXT.md must fix the term ${term}`);
    assert.ok(skill.toLowerCase().includes(term.toLowerCase()), `${SKILL} must use the term ${term}`);
  }
  for (const [file, source] of files)
    for (const term of REPLACED_TERMS)
      assert.ok(!source.toLowerCase().includes(term), `${file} uses "${term}", which CONTEXT.md replaces`);

  // 13. No orphan disclosure.
  for (const file of files.keys()) {
    if (file === SKILL) continue;
    const pointer = file.slice(SKILL_DIR.length + 1);
    const source = pointer.startsWith("reference/") ? skill : allSkillText;
    const where = pointer.startsWith("reference/") ? SKILL : "the skill";
    assert.ok(source.includes(pointer), `${file} is never pointed at from ${where}`);
  }

  // 14. Steps, criteria, and the report.
  const headings = [...skill.matchAll(/^## Step (\d+) — .+$/gm)];
  assert.equal(headings.length, 7, `${SKILL} must carry the seven ordered steps`);
  const sections = skill.split(/^## /m).slice(1);
  for (const [index, heading] of headings.entries()) {
    assert.equal(heading[1], String(index + 1), `${SKILL} must number its steps in order`);
    const section = sections.find((candidate) => candidate.startsWith(heading[0].slice("## ".length)));
    assert.ok(section?.includes("**Done when**"), `${SKILL} step ${heading[1]} must end on a completion criterion`);
  }
  const report = sections[sections.length - 1] ?? "";
  for (const phrase of ["version", "release record", "generated files", "typecheck", "local D1 test"])
    assert.ok(report.includes(phrase), `${SKILL} must require the report to name the ${phrase}`);
  assert.ok(
    skill.includes("verified local behavior"),
    `${SKILL} must stop at verified local behavior rather than at a clean typecheck`,
  );
});
