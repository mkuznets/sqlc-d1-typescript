import type { CompatibilityConfig } from "./compatibility-config.mjs";

export interface UpstreamFacts {
  sqlc: string;
  workersTypes: string;
  wrangler: string;
  vitestPoolWorkers: string;
  miniflare: string;
  workerd: string;
}

export interface UpstreamRow {
  component: string;
  baseline: string;
  upstream: string;
  drift: boolean;
}

export function compareUpstreamCompatibility(config: CompatibilityConfig, upstream: UpstreamFacts): UpstreamRow[];
export function renderUpstreamTable(rows: UpstreamRow[]): string;
export function fetchUpstreamFacts(fetchImpl?: typeof fetch, options?: { timeoutMs?: number }): Promise<UpstreamFacts>;
export function checkUpstreamCompatibility(options?: {
  root?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string>;
