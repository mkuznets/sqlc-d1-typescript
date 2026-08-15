import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/app.ts"],
  bundle: true,
  treeShaking: true,
  format: "esm",
  target: "es2020",
  outfile: "build/out.js",
});
