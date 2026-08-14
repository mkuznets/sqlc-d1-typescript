import type { SqlcCompatibilityResult } from "./verify-sqlc-compatibility.mjs";

export interface ActualTools {
  node: string;
  npm: string;
  bun: string;
}

export function writeCompatibilityEvidence(options: {
  matrixResult: SqlcCompatibilityResult;
  output: string;
  root?: string;
  actualTools?: ActualTools;
}): Promise<unknown>;
