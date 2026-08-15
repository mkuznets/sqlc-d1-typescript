import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "esbuild";

export const runtimeTextPlugin: Plugin = {
  name: "runtime-text",
  setup(build) {
    build.onResolve({ filter: /\.\/runtime$/ }, (args) => ({
      path: resolve(dirname(args.importer), "runtime.d1.ts"),
      namespace: "runtime-text",
    }));
    build.onLoad({ filter: /.*/, namespace: "runtime-text" }, (args) => {
      const lines = readFileSync(args.path, "utf8").split("\n");
      const runtime: string[] = [];
      let inside = false;
      for (const line of lines) {
        if (line === "// --- RUNTIME BEGIN ---") {
          inside = true;
          continue;
        }
        if (line === "// --- RUNTIME END ---") break;
        if (inside) runtime.push(line);
      }
      if (runtime.length === 0) {
        throw new Error(`No runtime code found between RUNTIME BEGIN/END markers in ${args.path}`);
      }
      return {
        contents: `export const RUNTIME = ${JSON.stringify(runtime.join("\n"))};`,
        loader: "js",
      };
    });
  },
};
