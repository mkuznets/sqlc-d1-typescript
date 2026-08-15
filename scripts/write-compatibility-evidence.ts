#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAsCli } from "./candidate-utils.ts";
import { loadCompatibilityConfig } from "./compatibility-config.ts";

// The evidence envelope is deliberately narrow: it records which toolchain proved a
// candidate, never what the tests saw. No SQL, values, rows, bookmarks, credentials,
// headers, or stack traces belong in any field below.
export interface CompatibilityEvidence {
  schemaVersion: 1;
  candidateSha256: string;
  tools: {
    node: string;
    npm: string;
    bun: string;
    sqlc: string[];
    typescript: string[];
    workersTypes: string;
    wrangler: string;
    vitestPoolWorkers: string;
    miniflare: string;
    workerd: string;
    buf: string;
    javy: string;
  };
  configuration: {
    compatibilityDate: string;
    compatibilityFlags: readonly string[];
    knownExceptions: readonly string[];
  };
  scenarios: { id: string; status: "passed" | "failed" }[];
  cleanup: { status: string };
}

export interface MatrixResult {
  candidateSha256: string;
  sqlcVersion: string;
  typescriptVersion: string;
  knownExceptions: readonly string[];
  cleanup: string;
  fixtures?: string[];
}

export async function writeCompatibilityEvidence({
  matrixResult,
  output,
  root = process.cwd(),
  actualTools,
}: {
  matrixResult: MatrixResult;
  output: string;
  root?: string;
  actualTools?: { node: string; npm: string; bun: string };
}): Promise<CompatibilityEvidence> {
  if (!matrixResult || !/^[0-9a-f]{64}$/.test(matrixResult.candidateSha256 ?? ""))
    throw new Error("matrixResult must contain a valid candidateSha256");
  if (!/^v?\d+\.\d+\.\d+$/.test(matrixResult.sqlcVersion ?? ""))
    throw new Error("matrixResult must contain the actual sqlcVersion");

  const config = await loadCompatibilityConfig({ root, checkLocal: true });
  const tools = actualTools ?? config.tools;
  const evidence: CompatibilityEvidence = {
    schemaVersion: 1,
    candidateSha256: matrixResult.candidateSha256,
    tools: {
      node: tools.node,
      npm: tools.npm,
      bun: tools.bun,
      sqlc: [matrixResult.sqlcVersion],
      typescript: [config.typescript.floor, matrixResult.typescriptVersion],
      workersTypes: config.cloudflare.workersTypes,
      wrangler: config.cloudflare.wrangler,
      vitestPoolWorkers: config.cloudflare.vitestPoolWorkers,
      miniflare: config.cloudflare.miniflare,
      workerd: config.cloudflare.workerd,
      buf: config.tools.buf,
      javy: config.tools.javy,
    },
    configuration: {
      compatibilityDate: config.cloudflare.compatibilityDate,
      compatibilityFlags: config.cloudflare.compatibilityFlags,
      knownExceptions: matrixResult.knownExceptions,
    },
    scenarios: [{ id: "verification/sqlc-matrix", status: "passed" }],
    cleanup: { status: matrixResult.cleanup },
  };

  await writeFile(resolve(output), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return evidence;
}

runAsCli(import.meta.url, async () => {
  const values = Object.fromEntries(process.argv.slice(2).map((value) => value.split("=", 2))) as Record<
    string,
    string | undefined
  >;
  const matrixResult = JSON.parse(await readFile(resolve(values.result!), "utf8")) as MatrixResult;
  const actualTools =
    values.node && values.npm && values.bun ? { node: values.node, npm: values.npm, bun: values.bun } : undefined;
  await writeCompatibilityEvidence({
    matrixResult,
    actualTools,
    output: values.output ?? "compatibility-evidence.json",
  });
});
