import * as esbuild from "esbuild";
import { runtimeTextPlugin } from "./scripts/runtime-text-plugin.ts";

await esbuild.build({
  entryPoints: ["src/app.ts"],
  bundle: true,
  treeShaking: true,
  format: "esm",
  target: "es2020",
  outfile: "build/out.js",
  plugins: [runtimeTextPlugin],
});
