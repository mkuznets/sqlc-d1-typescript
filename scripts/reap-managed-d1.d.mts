export interface ManagedInventoryResource { name: string; id: string }
export function selectStaleManagedResources<T extends ManagedInventoryResource>(resources: T[], options?: { now?: Date; minimumAgeMs?: number }): T[];
export function reapManagedD1(options: { accountId: string; token: string; now?: Date; fetchImpl?: typeof fetch; log?: (line: string) => void }): Promise<{ schemaVersion: 1; completedAt: string; actions: Array<{ kind: "worker" | "database"; name: string; id: string; action: "deleted" }> }>;
