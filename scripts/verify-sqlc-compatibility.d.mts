export interface VerifySqlcCompatibilityOptions {
  candidate: string;
  sha256: string;
  sqlcVersion: string;
  sqlc: string;
  root?: string;
}

export interface SqlcCompatibilityFixture {
  directory: string;
  config: string;
  generatedDirectory: string;
  staticFiles: string[];
}
export function fixturesForSqlcVersion(version: string): readonly SqlcCompatibilityFixture[];

export interface SqlcCompatibilityResult {
  sqlcVersion: string;
  fixtures: string[];
  knownExceptions: readonly string[];
  typescriptVersion: string;
  candidateSha256: string;
  cleanup: "confirmed";
}
export function verifySqlcCompatibility(options: VerifySqlcCompatibilityOptions): Promise<SqlcCompatibilityResult>;
