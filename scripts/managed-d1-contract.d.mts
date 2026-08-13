export const MANAGED_SCENARIO_IDS: readonly ["managed-d1/value-command-metadata", "managed-d1/macro-smoke", "managed-d1/batch-success", "managed-d1/batch-rollback", "managed-d1/direct-session", "managed-d1/bookmark-transfer", "managed-d1/native-error-identity", "managed-d1/post-execution-result-error"];
export type ManagedScenarioId = typeof MANAGED_SCENARIO_IDS[number];
export interface ParsedManagedResourceName { name: string; createdAt: Date; runId: string; attempt: string; randomHex: string; grammarVersion: 1 }
export function compactTimestamp(date: Date): string;
export function formatManagedResourceName(options: { now?: Date; runId: string; attempt: string; randomHex?: string }): string;
export function parseManagedResourceName(name: unknown): ParsedManagedResourceName | null;
export function initialResourceState(options: { name: string; candidateSha256: string; createdAt?: string }): { grammarVersion: 1; candidateSha256: string; createdAt: string; database: { status: "not-created"; name: string }; worker: { status: "not-created"; name: string } };
export function stableJson(value: unknown): string;
export function writePrivateJson(path: string, value: unknown): Promise<void>;
export function validateManagedD1Evidence(options: { evidence?: unknown; path?: string; candidateSha256?: string; sourceCommit?: string; runId?: string; runUrl?: string; trigger?: "schedule" | "workflow_dispatch" | "release"; config?: import("./compatibility-config.mjs").CompatibilityConfig; root?: string; requirePassing?: boolean }): Promise<any>;
