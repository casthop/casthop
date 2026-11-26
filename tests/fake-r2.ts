type Stored = {
  key: string;
  bytes: Uint8Array;
};

function asBytes(value: R2PutValue): Uint8Array {
  if (value === null || value === undefined) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("fake r2: unsupported put body");
}

function objectMeta(row: Stored): R2Object {
  return {
    key: row.key,
    size: row.bytes.byteLength,
    etag: String(row.bytes.byteLength),
    httpEtag: `"${row.bytes.byteLength}"`,
    uploaded: new Date(),
    checksums: {},
    storageClass: "Standard",
  } as R2Object;
}

export class FakeR2 {
  private objects = new Map<string, Stored>();

  async head(key: string): Promise<R2Object | null> {
    const row = this.objects.get(key);
    return row ? objectMeta(row) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const row = this.objects.get(key);
    if (!row) return null;
    const copy = row.bytes.slice();
    return {
      ...objectMeta(row),
      body: new Blob([copy]).stream(),
      bodyUsed: false,
      arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
      text: async () => new TextDecoder().decode(copy),
      json: async <T>() => JSON.parse(new TextDecoder().decode(copy)) as T,
      blob: async () => new Blob([copy]),
    } as R2ObjectBody;
  }

  async put(key: string, value: R2PutValue): Promise<R2Object> {
    const bytes = asBytes(await resolvePut(value));
    const row = { key, bytes };
    this.objects.set(key, row);
    return objectMeta(row);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const startAfter = options?.cursor ?? options?.startAfter ?? "";
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const from = startAfter ? keys.findIndex((k) => k > startAfter) : 0;
    const slice = from < 0 ? [] : keys.slice(Math.max(0, from), Math.max(0, from) + limit);
    const truncated = from >= 0 && from + limit < keys.length;
    return {
      objects: slice.map((key) => objectMeta(this.objects.get(key)!)),
      truncated,
      cursor: truncated ? slice.at(-1) : undefined,
      delimitedPrefixes: [],
    };
  }

}

type R2PutValue = Parameters<R2Bucket["put"]>[1];

async function resolvePut(value: R2PutValue): Promise<R2PutValue> {
  if (value && typeof value === "object" && "getReader" in value) {
    const reader = (value as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (chunk) chunks.push(chunk);
    }
    const size = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return value;
}
