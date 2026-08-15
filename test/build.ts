import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";
import { runtimeTextPlugin } from "../scripts/runtime-text-plugin.ts";

const entries = process.argv.slice(2);
if (entries.length === 0) throw new Error("at least one test entry is required");
mkdirSync("test/dist", { recursive: true });

await Promise.all(
  entries.map(async (entry) => {
    const name = entry
      .replace(/^test\//, "")
      .replace(/\.ts$/, "")
      .split("/")
      .join("-");
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      outfile: `test/dist/${name}.cjs`,
      plugins: [runtimeTextPlugin],
      // Bundled tests import the script modules but never run them as CLIs, so the
      // `runAsCli(import.meta.url, ...)` guard is deliberately inert here.
      logOverride: { "empty-import-meta": "silent" },
    });
  }),
);
