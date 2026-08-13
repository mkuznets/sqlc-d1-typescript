import type { CompatibilityConfig } from "./compatibility-config.mjs";
export interface ReleaseIntent { version: string; tag: string | null; sourceCommit: string; defaultBranch: string; dryRun: boolean; workflowRunId: string; workflowUrl: string }
export interface CandidateDescriptor { schemaVersion: 1; plugin: "sqlc-d1-typescript"; version: string; tag: string | null; sourceCommit: string; workflowRunId: string; workflowUrl: string; buildPolicy: "build-once-exact-artifact"; filename: string; size: number; sha256: string }
export interface ReleaseManifest { artifact: { actions_artifact_id: string; filename: string; sha256: string; size: number; url: string }; build_policy: "build-once-exact-artifact"; dry_run: boolean; plugin: "sqlc-d1-typescript"; remote_d1: { date: string | null; evidence_artifact_id: string | null; result: "not-run" | "passed" | "failed" }; schema_version: 1; source_commit: string; tag: string | null; tested_versions: unknown; verification_configuration: unknown; version: string; workflow_url: string }
export function parseSemver(value: string, options?: { prefixed?: boolean }): string;
export function canonicalWasmFilename(version: string): string;
export function canonicalManifestFilename(version: string): string;
export function stableJson(value: unknown): string;
export function resolveReleaseIntent(options: { eventName: string; refType?: string; refName?: string; manualVersion?: string; sourceCommit: string; defaultBranch: string; workflowRunId: string; serverUrl?: string; repository: string; isAncestor: (source: string, branch: string) => boolean | Promise<boolean> }): Promise<ReleaseIntent>;
export function describeCandidate(options: { wasmPath: string; intent: ReleaseIntent }): Promise<CandidateDescriptor>;
export function writeCandidateBundle(options: { wasmPath: string; directory: string; intent: ReleaseIntent }): Promise<CandidateDescriptor>;
export function validateCandidateBundle(options: { directory: string; intent: ReleaseIntent }): Promise<CandidateDescriptor>;
export function validateCompatibilityEvidence(options: { path: string; candidateSha256: string; sqlcVersion?: string; config: CompatibilityConfig; root?: string }): Promise<unknown>;
export function collectCompatibilityEvidence(options: { paths: string[]; candidateSha256: string; config: CompatibilityConfig; root?: string }): Promise<unknown[]>;
export function validateCompatibilitySet(options: { paths: string[]; candidateSha256: string; config: CompatibilityConfig; root?: string }): Promise<unknown[]>;
export function createReleaseManifest(options: { intent: ReleaseIntent; candidate: CandidateDescriptor; artifactId: string; config: CompatibilityConfig; evidence: unknown[]; managedEvidence: any; managedEvidenceArtifactId: string }): ReleaseManifest;
export function validateReleaseManifest(options: { manifest?: ReleaseManifest | unknown; path?: string; intent?: ReleaseIntent; candidate?: CandidateDescriptor; artifactId?: string; config?: CompatibilityConfig; managedEvidence?: any; managedEvidenceArtifactId?: string; root?: string }): Promise<ReleaseManifest>;
export function writeReleaseManifest(options: { output: string; intent: ReleaseIntent; candidate: CandidateDescriptor; artifactId: string; config: CompatibilityConfig; evidence: unknown[]; managedEvidence: any; managedEvidenceArtifactId: string; root?: string }): Promise<ReleaseManifest>;
