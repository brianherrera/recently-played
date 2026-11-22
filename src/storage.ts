import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Everything under this prefix is served by CloudFront (it's the distribution's origin path). */
export const PUBLIC_PREFIX = "public/";
/** Never served. */
export const PRIVATE_PREFIX = "private/";

export const KEYS = {
  games: `${PUBLIC_PREFIX}games.json`,
  state: `${PRIVATE_PREFIX}state.json`,
  snapshot: (date: string) => `${PRIVATE_PREFIX}snapshots/${date}.json`,
  /** coverKey is relative to the public prefix so it maps 1:1 onto the URL path. */
  cover: (coverKey: string) => `${PUBLIC_PREFIX}${coverKey}`,
};

export interface Storage {
  getJson<T>(key: string): Promise<T | undefined>;
  put(key: string, body: string | Uint8Array, contentType: string, cacheControl?: string): Promise<void>;
}

export class S3Storage implements Storage {
  constructor(
    private readonly bucket: string,
    private readonly client = new S3Client({}),
  ) {}

  async getJson<T>(key: string): Promise<T | undefined> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const text = await res.Body!.transformToString();
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof NoSuchKey) return undefined;
      throw err;
    }
  }

  async put(key: string, body: string | Uint8Array, contentType: string, cacheControl?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
  }
}

/** In-memory implementation for tests and local dry runs. */
export class MemoryStorage implements Storage {
  readonly objects = new Map<string, { body: string | Uint8Array; contentType: string; cacheControl?: string }>();

  async getJson<T>(key: string): Promise<T | undefined> {
    const obj = this.objects.get(key);
    if (!obj) return undefined;
    const text = typeof obj.body === "string" ? obj.body : new TextDecoder().decode(obj.body);
    return JSON.parse(text) as T;
  }

  async put(key: string, body: string | Uint8Array, contentType: string, cacheControl?: string): Promise<void> {
    this.objects.set(key, { body, contentType, cacheControl });
  }
}
