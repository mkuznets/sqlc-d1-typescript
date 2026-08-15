import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { GenerateResponse } from "../../src/gen/plugin/codegen_pb.ts";

export interface CompileGeneratedOptions {
  compiler?: "typescript-5-2" | "typescript";
  additionalFiles?: Readonly<Record<string, string>>;
}

export function compileGeneratedResponse(response: GenerateResponse, options: CompileGeneratedOptions = {}): void {
  const cache = resolve(process.cwd(), "node_modules/.cache/sqlc-d1-typescript");
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(`${cache}/emission-`);
  try {
    const occupiedPaths = new Set<string>();
    const writeContainedFile = (name: string, contents: string | Uint8Array, kind: string): void => {
      const destination = resolve(directory, name);
      const pathFromRoot = relative(directory, destination);
      assert.ok(
        pathFromRoot && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot),
        `unsafe ${kind} path ${name}`,
      );
      assert.notEqual(pathFromRoot, "tsconfig.json", `${kind} path collides with tsconfig.json`);
      assert.equal(occupiedPaths.has(pathFromRoot), false, `${kind} path collides with ${pathFromRoot}`);
      occupiedPaths.add(pathFromRoot);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    };

    for (const file of response.files) writeContainedFile(file.name, file.contents, "generated");
    for (const [name, contents] of Object.entries(options.additionalFiles ?? {})) {
      writeContainedFile(name, contents, "additional");
    }

    writeFileSync(
      resolve(directory, "tsconfig.json"),
      JSON.stringify({
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
      }),
    );

    const compiler = resolve(process.cwd(), `node_modules/${options.compiler ?? "typescript-5-2"}/lib/tsc.js`);
    const result = spawnSync(process.execPath, [compiler, "-p", resolve(directory, "tsconfig.json")], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
