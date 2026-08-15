#!/usr/bin/env node
import { runAsCli } from "./candidate-utils.ts";
import { loadCompatibilityConfig, renderCompatibilityFacts } from "./compatibility-config.ts";

export async function checkCompatibility(root = process.cwd()): Promise<string> {
  const config = await loadCompatibilityConfig({ root, checkLocal: true });
  return renderCompatibilityFacts(config);
}

runAsCli(import.meta.url, async () => {
  console.log(await checkCompatibility());
});
