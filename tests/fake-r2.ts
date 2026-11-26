/** In-memory R2, same shape Miniflare uses locally. No real bucket. */

type PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;

type Stored = {
  bytes: Uint8Array;
  httpMetadata?: R2HTTPMetadata;
  uploaded: Date;
};

async function toBytes(value: PutValue): Promise<Uint8Array> {
  if (value == null) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
}

class FakeR2Object implements R2Object {
  readonly key: string;
  readonly version = "1";
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly checksums: R2Checksums = {};
  readonly uploaded: Date;
  readonly httpMetadata?: R2HTTPMetadata;
  readonly customMetadata: Record<string, string> = {};
  readonly storageClass = "Standard";
  protected readonly payload: Uint8Array;

  constructor(key: string, payload: Uint8Array, uploaded: Date, httpMetadata?: R2HTTPMetadata) {
    this.key = key;
    this.payload = payload;
    this.size = payload.byteLength;
    this.etag = `${payload.byteLength}`;
    this.httpEtag = `"${this.etag}"`;
    this.uploaded = uploaded;
    this.httpMetadata = httpMetadata;
  }

  writeHttpMetadata(headers: Headers): void {
    if (this.httpMetadata?.contentType) headers.set("Content-Type", this.httpMetadata.contentType);
    if (this.httpMetadata?.cacheControl) headers.set("Cache-Control", this.httpMetadata.cacheControl);
    if (this.httpMetadata?.contentDisposition) headers.set("Content-Disposition", this.httpMetadata.contentDisposition);
    if (this.httpMetadata?.contentEncoding) headers.set("Content-Encoding", this.httpMetadata.contentEncoding);
    if (this.httpMetadata?.contentLanguage) headers.set("Content-Language", this.httpMetadata.contentLanguage);
  }
}

class FakeR2ObjectBody extends FakeR2Object implements R2ObjectBody {
  private used = false;

  get body(): ReadableStream {
    this.used = true;
    return new ReadableStream({
      start: (controller) => {
        controller.enqueue(this.payload);
        controller.close();
      },
    });
  }

  get bodyUsed(): boolean {
    return this.used;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.used = true;
    return this.payload.buffer.slice(this.payload.byteOffset, this.payload.byteOffset + this.payload.byteLength);
  }

  async text(): Promise<string> {
    this.used = true;
    return new TextDecoder().decode(this.payload);
  }

  async json<T>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  async blob(): Promise<Blob> {
    this.used = true;
    return new Blob([this.payload]);
  }
}

export class FakeR2 implements R2Bucket {
  private readonly objects = new Map<string, Stored>();
  listCalls = 0;

  async head(key: string): Promise<R2Object | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return new FakeR2Object(key, stored.bytes, stored.uploaded, stored.httpMetadata);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return new FakeR2ObjectBody(key, stored.bytes, stored.uploaded, stored.httpMetadata);
  }

  async put(key: string, value: PutValue, options?: R2PutOptions): Promise<R2Object> {
    const bytes = await toBytes(value);
    const stored: Stored = {
      bytes,
      httpMetadata: options?.httpMetadata,
      uploaded: new Date(),
    };
    this.objects.set(key, stored);
    return new FakeR2Object(key, bytes, stored.uploaded, stored.httpMetadata);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    this.listCalls += 1;
    const prefix = options?.prefix ?? "";
    const limit = Math.min(options?.limit ?? 1000, 1000);
    let keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (options?.cursor) keys = keys.filter((k) => k > options.cursor!);
    const sliced = keys.slice(0, limit);
    const truncated = keys.length > limit;
    return {
      objects: sliced.map((key) => {
        const stored = this.objects.get(key)!;
        return new FakeR2Object(key, stored.bytes, stored.uploaded, stored.httpMetadata);
      }),
      truncated,
      cursor: truncated && sliced.length ? sliced[sliced.length - 1] : undefined,
      delimitedPrefixes: [],
    };
  }

  createMultipartUpload(): Promise<R2MultipartUpload> {
    return Promise.reject(new Error("multipart not used"));
  }

  resumeMultipartUpload(): R2MultipartUpload {
    throw new Error("multipart not used");
  }
}
