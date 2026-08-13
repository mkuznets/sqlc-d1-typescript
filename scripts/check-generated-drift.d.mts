export interface CheckGeneratedDriftOptions {
  candidate: string;
  sha256: string;
  root?: string;
  mode?: "mirror" | "worktree";
}
export interface GeneratedDifference { kind: "added" | "deleted" | "changed"; path: string }
export function checkGeneratedDrift(options: CheckGeneratedDriftOptions): Promise<void>;
export function compareGeneratedTrees(expectedDirectory: string, actualDirectory: string, staticFiles?: string[]): Promise<GeneratedDifference[]>;
export function clearGeneratedDirectory(directory: string, staticFiles?: string[]): Promise<void>;
