#!/usr/bin/env node
// The runtime is shipped text. Only the lines between the RUNTIME markers in
// src/runtime.d1.ts reach consumers; this writes them into src/runtime.ts as a string
// literal so both the wasm build and the tests see the exact same bytes.
//
// src/runtime.ts is generated and gitignored. The Makefile rebuilds it whenever
// src/runtime.d1.ts changes, so nothing else needs to remember to.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAsCli } from "./candidate-utils.ts";

const BEGIN = "// --- RUNTIME BEGIN ---";
const END = "// --- RUNTIME END ---";

export function extractRuntime(source: string): string {
  const lines = source.split("\n");
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  if (begin === -1 || end === -1 || end <= begin + 1)
    throw new Error(`no runtime found between the ${BEGIN} and ${END} markers`);
  return lines.slice(begin + 1, end).join("\n");
}

export async function writeRuntimeModule(root = process.cwd()): Promise<string> {
  const runtime = extractRuntime(await readFile(resolve(root, "src/runtime.d1.ts"), "utf8"));
  await writeFile(
    resolve(root, "src/runtime.ts"),
    `// Generated from src/runtime.d1.ts by scripts/extract-runtime.ts. Do not edit.\n` +
      `export const RUNTIME: string = ${JSON.stringify(runtime)};\n`,
  );
  return runtime;
}

runAsCli(import.meta.url, async () => {
  const runtime = await writeRuntimeModule();
  console.log(`==> Wrote src/runtime.ts (${runtime.split("\n").length} lines of shipped runtime)`);
});
