import type { PublicationMode, PublicationRecord, TeardownOutcome } from "./publication-contract.mjs";
import type { ReleaseIntent } from "./release-contract.mjs";
import type { CommandRunner } from "./r2-cli.mjs";

export const ENVIRONMENT: "release-publication";

export interface PublicationCredentials {
  githubToken: string;
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
}

export interface PreflightCheck {
  name: string;
  status: "passed" | "failed" | "not-verifiable";
  detail: string;
}

export interface PreflightResult {
  schemaVersion: 1;
  repository: string;
  environment: string;
  version: string;
  checkedAt: string;
  status: "passed" | "failed";
  checks: PreflightCheck[];
  immutableReleases: { enabled: boolean; enforced_by_owner: boolean };
}

export function credentialsFromEnvironment(env?: NodeJS.ProcessEnv): PublicationCredentials;
export function recoveryGuidance(options: {
  mode?: PublicationMode;
  version: string;
  tag?: string | null;
  key: string;
  digest: string;
  keyExists: boolean;
  published: boolean;
}): string;
export function preflightPublication(options: {
  repository: string;
  intent: ReleaseIntent;
  credentials: PublicationCredentials;
  fetchImpl?: typeof fetch;
  run?: CommandRunner;
  logger?: (line: string) => void;
  now?: () => Date;
  output?: string;
}): Promise<PreflightResult>;
export function publishPublication(options: {
  repository: string;
  intent: ReleaseIntent;
  candidateDir: string;
  manifestPath: string;
  notes?: string;
  artifactId?: string | null;
  credentials: PublicationCredentials;
  fetchImpl?: typeof fetch;
  run?: CommandRunner;
  now?: () => Date;
  delay?: (milliseconds: number) => Promise<void>;
  logger?: (line: string) => void;
  recordPath?: string;
  statePath: string;
  mode?: PublicationMode;
  publicAttempts?: number;
  publicIntervalMs?: number;
  root?: string;
}): Promise<PublicationRecord>;
export function teardownPublication(options: {
  statePath: string;
  credentials: PublicationCredentials;
  fetchImpl?: typeof fetch;
  run?: CommandRunner;
  logger?: (line: string) => void;
  reportPath?: string;
}): Promise<{
  schemaVersion: 1;
  mode: PublicationMode;
  resources: unknown;
  teardown: { object: TeardownOutcome; draft: TeardownOutcome };
}>;
