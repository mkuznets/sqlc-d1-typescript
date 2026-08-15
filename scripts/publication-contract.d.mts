import type { ReleaseIntent, ReleaseManifest } from "./release-contract.mjs";

export const R2_BUCKET: "sqlc";
export const PUBLIC_ORIGIN: "https://sqlc.mkuznets.com";
export const KEY_PREFIX: "plugins/";
export const REHEARSAL_PREFIX: "rehearsal/";
export const PLUGIN: "sqlc-d1-typescript";
export const PRERELEASE_NOTICE: string;
export const PUBLICATION_PHASES: readonly string[];

export type PublicationMode = "publish" | "dry-run";
export type ObjectOutcome = "created" | "existing-identical" | "not-created";
export type DraftOutcome = "created" | "reused" | "not-created";
export type TeardownOutcome = "not-created" | "deleted" | "failed" | "retained";

export type ObjectHttpMetadata = Record<string, string>;

export interface PublicationRecord {
  schema_version: 1;
  plugin: "sqlc-d1-typescript";
  mode: PublicationMode;
  version: string;
  tag: string | null;
  dry_run: boolean;
  source_commit: string;
  workflow_url: string;
  verified_sha256: string | null;
  artifact: { filename: string; size: number; actions_artifact_id: string | null };
  manifest: { filename: string; sha256: string; size: number };
  r2: {
    bucket: "sqlc";
    key: string;
    outcome: ObjectOutcome;
    http_metadata: { content_type: string; content_disposition: string; cache_control: string } | null;
    metadata_sha256: string | null;
    direct_download_sha256: string | null;
    public_url: string;
    public_download_sha256: string | null;
    public_attempts: number;
  };
  github: {
    release_id: string | null;
    release_url: string | null;
    tag_name: string;
    prerelease: boolean;
    draft_outcome: DraftOutcome;
    asset_sha256: { wasm: string | null; manifest: string | null };
    published: boolean;
    immutable_releases: { enabled: boolean; enforced_by_owner: boolean };
  };
  order: { phase: string; at: string }[];
  teardown: { object: TeardownOutcome; draft: TeardownOutcome };
  failure?: { phase: string; detail: string };
}

export function contractError(message: string): Error & { exitCode: number };
export function redactSecrets(text: unknown, secrets?: (string | undefined)[]): string;
export function canonicalObjectKey(version: string): string;
export function rehearsalObjectKey(version: string, runId: string): string;
export function isVersionKey(key: unknown): boolean;
export function publicUrlForKey(key: string): string;
export function objectHttpMetadata(options: { filename: string }): ObjectHttpMetadata;
export function objectUserMetadata(options: {
  sha256: string;
  version: string;
  sourceCommit: string;
}): Record<string, string>;
export function assertHttpMetadata(observed: Record<string, unknown>, expected: Record<string, string>): true;
export function repositoryFromWorkflowUrl(workflowUrl: string): string;
export function buildReleaseBody(options: {
  manifest: ReleaseManifest;
  intent: ReleaseIntent;
  notes?: string;
  manifestSha256: string;
}): string;
export function assertBodyAgreesWithManifest(
  body: string,
  manifest: ReleaseManifest,
  options?: { manifestSha256?: string },
): true;
export function createPublicationRecord(options: {
  mode: PublicationMode;
  intent: ReleaseIntent;
  candidate: { filename: string; size: number; sha256: string };
  artifactId?: string | null;
  manifest: ReleaseManifest;
  manifestSize: number;
  manifestSha256: string;
  verifiedSha256?: string | null;
  r2: PublicationRecord["r2"];
  github: PublicationRecord["github"];
  order?: { phase: string; at: string }[];
  teardown?: PublicationRecord["teardown"];
  failure?: { phase: string; detail: string };
}): PublicationRecord;
export function validatePublicationRecord(options: {
  record?: unknown;
  path?: string;
  root?: string;
}): Promise<PublicationRecord>;
export function writePublicationJson(path: string, value: unknown): Promise<void>;
export function stableJson(value: unknown): string;
