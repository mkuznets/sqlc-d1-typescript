import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";
import { runtimeTextPlugin } from "../scripts/runtime-text-plugin.mjs";

const entries = process.argv.slice(2);
if (entries.length === 0) throw new Error("at least one test entry is required");
mkdirSync("test/dist", { recursive: true });

await Promise.all(
  entries.map(async (entry) => {
    const name = entry
      .replace(/^test\//, "")
      .replace(/\.ts$/, "")
      .replaceAll("/", "-");
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      outfile: `test/dist/${name}.cjs`,
      plugins: [runtimeTextPlugin],
    });
  }),
);
