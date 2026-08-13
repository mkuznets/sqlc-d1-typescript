export interface RunArtifact { id: number | string; name: string; expired: boolean }
export type RunArtifactSelection = { mode: "create" } | { mode: "reuse"; artifactId: string; name: string };
export function listRunArtifacts(options: { owner: string; repo: string; runId: string; name?: string; prefix?: string; token: string; fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<RunArtifact[]>;
export function selectPassingManagedEvidence(artifacts: RunArtifact[], validateArtifact: (artifact: RunArtifact) => Promise<{ remoteDate: string } | null>): Promise<{ mode: "create" } | { mode: "reuse"; artifactId: string; name: string; remoteDate: string }>;
export function selectExactRunArtifact(artifacts: RunArtifact[], name: string, options?: { allowCreate?: boolean }): RunArtifactSelection;
