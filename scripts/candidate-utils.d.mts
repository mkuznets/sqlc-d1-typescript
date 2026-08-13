export interface RetainedCandidate {
  readonly bytes: Buffer;
  readonly path: string;
  readonly sha256: string;
}

export function readCandidate(candidate: string, sha256: string): Promise<RetainedCandidate>;
export function validateCandidate(candidate: string, sha256: string): Promise<string>;
export function parseArguments(argv: string[], required: string[], allowed?: string[]): Record<string, string>;
export function usageError(message: string): Error & { exitCode: number };
