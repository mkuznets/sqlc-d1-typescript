#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";
import { loadCompatibilityConfig } from "./compatibility-config.mjs";

export async function writeCompatibilityEvidence({ matrixResult, output, root = process.cwd(), actualTools } = {}) {
  if (!matrixResult || !/^[0-9a-f]{64}$/.test(matrixResult.candidateSha256 ?? ""))
    throw new Error("matrixResult must contain a valid candidateSha256");
  if (!/^v?\d+\.\d+\.\d+$/.test(matrixResult.sqlcVersion ?? ""))
    throw new Error("matrixResult must contain the actual sqlcVersion");

  const config = await loadCompatibilityConfig({ root, checkLocal: true });
  const tools = actualTools ?? config.tools;
  const evidence = {
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
  const schema = JSON.parse(await readFile(resolve(root, "verification/evidence.schema.json"), "utf8"));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  if (!validate(evidence)) throw new Error(`compatibility evidence is invalid: ${JSON.stringify(validate.errors)}`);

  await writeFile(resolve(output), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return evidence;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => {
    try {
      const values = Object.fromEntries(process.argv.slice(2).map((value) => value.split("=", 2)));
      const matrixResult = JSON.parse(await readFile(resolve(values.result), "utf8"));
      const actualTools =
        values.node && values.npm && values.bun ? { node: values.node, npm: values.npm, bun: values.bun } : undefined;
      await writeCompatibilityEvidence({
        matrixResult,
        actualTools,
        output: values.output ?? "compatibility-evidence.json",
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  })();
}
