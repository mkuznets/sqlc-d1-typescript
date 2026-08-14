export interface GenerateCandidateOptions {
  candidate: string;
  sha256: string;
  config: string;
  cwd: string;
  sqlc?: string;
}

export function generateCandidate(options: GenerateCandidateOptions): Promise<void>;
export function combinedError(primary: unknown, cleanupErrors: unknown[], cleanupLabel: string): Error;
