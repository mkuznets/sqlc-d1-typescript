import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const ROUTER = "AGENTS.md";
const BRANCHES = [
  "docs/agents/generator-runtime.md",
  "docs/agents/verification.md",
  "docs/agents/release.md",
  "docs/agents/workflows.md",
];
const TOOLING = ["docs/agents/issue-tracker.md", "docs/agents/triage-labels.md", "docs/agents/domain.md"];
const GUIDANCE = [ROUTER, ...BRANCHES];

const PATH_TOKEN = /^\.?[A-Za-z0-9_][A-Za-z0-9_./-]*(?:\.(?:ts|mts|cts|mjs|json|jsonc|yml|yaml|sh|md|sql)|\/)$/;

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const inlineCode = (source: string): string[] => [...source.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
const fencedCode = (source: string): string[] =>
  [...source.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]);

function makeTargets(): Set<string> {
  const targets = new Set<string>();
  for (const line of read("Makefile").split("\n")) {
    const rule = /^([A-Za-z0-9_.\/ -]+):(?!=)/.exec(line);
    if (rule) for (const target of rule[1].trim().split(/\s+/)) targets.add(target);
  }
  return targets;
}

test("verification/agent-guidance routes every task branch and keeps its references real", () => {
  const router = read(ROUTER);

  for (const document of [...BRANCHES, ...TOOLING])
    assert.ok(router.includes(document), `${ROUTER} must route to ${document}`);

  const routerLines = router.split("\n").filter((line) => line.trim() !== "");
  assert.ok(routerLines.length <= 40, `${ROUTER} must stay a thin router, found ${routerLines.length} lines`);
  assert.ok(!router.includes("```"), `${ROUTER} must hold no code block`);

  const targets = makeTargets();
  for (const file of GUIDANCE) {
    const source = read(file);

    const code = inlineCode(source);
    for (const token of code)
      if (PATH_TOKEN.test(token)) assert.ok(existsSync(resolve(process.cwd(), token)), `${file} references ${token}`);

    // Prose says "make sure"; only code says `make <target>`.
    for (const invocation of [...code, ...fencedCode(source)].join("\n").matchAll(/\bmake ([a-z][a-z0-9-]*)/g))
      assert.ok(targets.has(invocation[1]), `${file} names make ${invocation[1]}, which the Makefile does not define`);

    const version = /\d+\.\d+/.exec(source);
    assert.equal(
      version,
      null,
      `${file} states the version fact "${version?.[0]}"; verification/compatibility.json and the release record own those`,
    );
  }

  assert.ok(!router.includes("RUNTIME BEGIN"), "the shipped-runtime rule belongs to docs/agents/generator-runtime.md");
  assert.ok(!router.includes("scripts/generate-candidate.mjs"), "regeneration belongs to docs/agents/verification.md");
  assert.ok(!router.includes("scripts/workflows/lib.sh"), "workflow authoring belongs to docs/agents/workflows.md");
  assert.ok(read("docs/agents/generator-runtime.md").includes("RUNTIME BEGIN"));
  assert.ok(read("docs/agents/verification.md").includes("scripts/generate-candidate.mjs"));
  assert.ok(read("docs/agents/workflows.md").includes("scripts/workflows/lib.sh"));
});
