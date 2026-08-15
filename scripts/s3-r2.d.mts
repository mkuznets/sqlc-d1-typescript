export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignedS3Request {
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  signedHeaders: string;
}

export interface S3RequestOptions {
  endpoint: string;
  bucket: string;
  key: string;
  credentials: R2Credentials;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: () => Date;
}

export function sha256Hex(bytes: Uint8Array | string): string;
export function md5Base64(bytes: Uint8Array | string): string;
export function encodeObjectKey(key: string): string;
export function r2Endpoint(accountId: string): string;
export function signS3Request(options: {
  method: string;
  url: string;
  headers?: Record<string, string | undefined>;
  payloadSha256: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  service?: string;
  now?: Date;
}): SignedS3Request;
export function putObjectCreateOnly(
  options: S3RequestOptions & { body: Uint8Array; headers?: Record<string, string> },
): Promise<{ outcome: "created" | "exists"; status: number; headers: Record<string, string>; detail?: string }>;
export function getObject(
  options: S3RequestOptions,
): Promise<{ status: number; bytes: Buffer | null; headers: Record<string, string>; detail?: string }>;
export function headObject(options: S3RequestOptions): Promise<{ status: number; headers: Record<string, string> }>;
export function headBucket(options: Omit<S3RequestOptions, "key">): Promise<{ status: number }>;
export function listBuckets(
  options: Omit<S3RequestOptions, "key" | "bucket">,
): Promise<{ denied: boolean; status: number; buckets: string[] | null }>;
export function deleteObject(options: S3RequestOptions): Promise<{ status: number }>;
