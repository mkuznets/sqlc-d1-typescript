import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { GenerateResponse } from "../../src/gen/plugin/codegen_pb";

export function compileGeneratedResponse(response: GenerateResponse): void {
  const cache = resolve(process.cwd(), "node_modules/.cache/sqlc-d1-typescript");
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(`${cache}/emission-`);
  try {
    for (const file of response.files) {
      const destination = resolve(directory, file.name);
      const pathFromRoot = relative(directory, destination);
      assert.ok(pathFromRoot && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot), `unsafe generated path ${file.name}`);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.contents);
    }
    writeFileSync(resolve(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2020",
        module: "ESNext",
        moduleResolution: "node",
        types: ["@cloudflare/workers-types"],
        skipLibCheck: true,
      },
      include: ["**/*.ts"],
    }));
    const compiler = resolve(process.cwd(), "node_modules/typescript-5-2/lib/tsc.js");
    const result = spawnSync(process.execPath, [compiler, "-p", resolve(directory, "tsconfig.json")], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
