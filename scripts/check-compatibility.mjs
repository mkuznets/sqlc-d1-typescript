#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadCompatibilityConfig, renderCompatibilityFacts } from "./compatibility-config.mjs";

export async function checkCompatibility(root = process.cwd()) {
  const config = await loadCompatibilityConfig({ root, checkLocal: true });
  return renderCompatibilityFacts(config);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => { try { console.log(await checkCompatibility()); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; } })();
}
