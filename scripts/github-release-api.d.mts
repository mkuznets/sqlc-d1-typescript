export interface GitHubCall {
  repository: string;
  token: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface ReleaseAsset {
  id: string;
  name: string;
  state: string;
  size: number;
  content_type?: string;
}

export interface Release {
  id: string;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  target_commitish?: string;
}

export function getImmutableReleases(
  options: GitHubCall,
): Promise<{ enabled: boolean; enforced_by_owner: boolean; readable: boolean }>;
export function findDraftRelease(options: GitHubCall & { tagName: string }): Promise<Release | null>;
export function getRelease(options: GitHubCall & { releaseId: string }): Promise<Release>;
export function createDraftRelease(
  options: GitHubCall & {
    tagName: string;
    targetCommitish: string;
    name: string;
    body: string;
    prerelease?: boolean;
  },
): Promise<Release>;
export function listReleaseAssets(options: GitHubCall & { releaseId: string }): Promise<ReleaseAsset[]>;
export function uploadReleaseAsset(
  options: GitHubCall & { releaseId: string; name: string; contentType: string; bytes: Uint8Array },
): Promise<ReleaseAsset>;
export function downloadReleaseAsset(options: GitHubCall & { assetId: string }): Promise<Buffer>;
export function deleteReleaseAsset(options: GitHubCall & { assetId: string }): Promise<{ status: number }>;
export function publishRelease(
  options: GitHubCall & { releaseId: string; makeLatest?: "true" | "false" | "legacy" },
): Promise<Release>;
export function deleteRelease(options: GitHubCall & { releaseId: string }): Promise<{ status: number }>;
export function resolveTagCommit(options: GitHubCall & { tagName: string }): Promise<string | null>;
