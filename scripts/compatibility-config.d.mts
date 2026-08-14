export type SqlcRole = "floor" | "intervening" | "ceiling";

export interface CompatibilityConfig {
  readonly schemaVersion: 1;
  readonly sqlc: {
    readonly supportedFloor: string;
    readonly testedCeiling: string;
    readonly samples: readonly { readonly version: string; readonly role: SqlcRole; readonly rationale: string }[];
    readonly knownExceptions: readonly string[];
  };
  readonly typescript: { readonly floor: string; readonly current: string };
  readonly cloudflare: {
    readonly workersTypes: string;
    readonly wrangler: string;
    readonly vitestPoolWorkers: string;
    readonly miniflare: string;
    readonly workerd: string;
    readonly compatibilityDate: string;
    readonly compatibilityFlags: readonly string[];
  };
  readonly tools: {
    readonly node: string;
    readonly npm: string;
    readonly bun: string;
    readonly buf: string;
    readonly javy: string;
  };
}

export function loadCompatibilityConfig(options?: {
  root?: string;
  checkLocal?: boolean;
}): Promise<CompatibilityConfig>;
export function checkLocalCompatibility(config: CompatibilityConfig, root?: string): Promise<CompatibilityConfig>;
export function readLocalCompatibilityFacts(root?: string): Promise<unknown>;
export function assertSqlcPolicy(
  config: CompatibilityConfig,
  policy: { supportedFloor: string; testedCeiling: string },
): void;
export function renderCompatibilityFacts(config: CompatibilityConfig): string;
export function compareVersions(left: string, right: string): number;
