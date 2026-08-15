export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<CommandResult>;

export interface R2Call {
  endpoint: string;
  bucket: string;
  key: string;
  credentials: R2Credentials;
  run?: CommandRunner;
  signal?: AbortSignal;
}

export interface ObjectDescription {
  httpMetadata: Record<string, string | undefined>;
  metadata: Record<string, string>;
  size?: number;
}

export const AWS_BIN: string;
export function md5Base64(bytes: Uint8Array | string): string;
export function r2Endpoint(accountId: string): string;
export function commandEnvironment(options: {
  credentials: R2Credentials;
  endpoint: string;
  env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv;
export const commandRunner: CommandRunner;
export function putObjectCreateOnly(
  options: Omit<R2Call, "key"> & {
    key: string;
    bodyPath: string;
    contentMd5: string;
    httpMetadata: Record<string, string>;
    metadata: Record<string, string>;
  },
): Promise<{ outcome: "created" | "exists" }>;
export function getObject(
  options: R2Call,
): Promise<{ status: number; bytes: Buffer | null } & Partial<ObjectDescription>>;
export function headObject(options: R2Call): Promise<{ status: number } & Partial<ObjectDescription>>;
export function headBucket(options: Omit<R2Call, "key">): Promise<{ status: number }>;
export function listBuckets(
  options: Omit<R2Call, "key" | "bucket">,
): Promise<{ denied: boolean; buckets: string[] | null }>;
export function deleteObject(options: R2Call): Promise<{ status: number }>;
export function awsVersion(options?: { run?: CommandRunner }): Promise<string>;
