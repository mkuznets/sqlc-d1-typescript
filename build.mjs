import * as esbuild from "esbuild";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";

const runtimeTextPlugin = {
  name: "runtime-text",
  setup(build) {
    build.onResolve({ filter: /\.\/runtime$/ }, (args) => ({
      path: resolve(dirname(args.importer), "runtime.d1.ts"),
      namespace: "runtime-text",
    }));
    build.onLoad({ filter: /.*/, namespace: "runtime-text" }, (args) => {
      const lines = readFileSync(args.path, "utf8").split("\n");
      const result = [];
      let inside = false;
      for (const line of lines) {
        if (line === "// --- RUNTIME BEGIN ---") {
          inside = true;
          continue;
        }
        if (line === "// --- RUNTIME END ---") {
          break;
        }
        if (inside) {
          result.push(line);
        }
      }
      if (result.length === 0) {
        throw new Error("No runtime code found between RUNTIME BEGIN/END markers in " + args.path);
      }
      return {
        contents: `export const RUNTIME = ${JSON.stringify(result.join("\n"))};`,
        loader: "js",
      };
    });
  },
};

await esbuild.build({
  entryPoints: ["src/app.ts"],
  bundle: true,
  treeShaking: true,
  format: "esm",
  target: "es2020",
  outfile: "build/out.js",
  plugins: [runtimeTextPlugin],
});
