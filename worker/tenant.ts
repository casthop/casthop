import { studioTenantId } from "./db";
import type { Env } from "./types";

const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function asTenantId(value: unknown): string | null {
  return typeof value === "string" && TENANT_ID.test(value) ? value : null;
}

/** The only place R2 key prefixes for hosted tenants are built. No tenant, no prefix. */
export function tenantKeyPrefix(tenantId: string | null): string {
  return tenantId ? `t/${tenantId}/` : "";
}

type Listed = { objects: { key: string; size: number }[]; truncated: boolean; cursor?: string };

/** The slice of R2Bucket the Worker uses for studio files. */
export type ObjectStore = {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: R2PutOptions): Promise<R2Object>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<Listed>;
};

export type StoreEnv = { RECORDINGS: ObjectStore };

/** Keys passed in get the tenant prefix; keys returned from list lose it, so callers see today's keys. */
export function scopeStore(bucket: ObjectStore, tenantId: string | null): ObjectStore {
  const prefix = tenantKeyPrefix(tenantId);
  if (!prefix) return bucket;
  const strip = (key: string) => (key.startsWith(prefix) ? key.slice(prefix.length) : key);
  return {
    get: (key) => bucket.get(prefix + key),
    head: (key) => bucket.head(prefix + key),
    put: (key, value, options) => bucket.put(prefix + key, value, options),
    delete: (keys) => bucket.delete(Array.isArray(keys) ? keys.map((k) => prefix + k) : prefix + keys),
    async list(options) {
      const page = await bucket.list({ ...options, prefix: prefix + (options?.prefix ?? "") });
      return {
        objects: page.objects.map((o) => ({ key: strip(o.key), size: o.size })),
        truncated: page.truncated,
        cursor: page.cursor,
      };
    },
  };
}

/** Env whose RECORDINGS is scoped to the studio's tenant. Same bucket when the studio has none. */
export async function storeFor(env: Pick<Env, "DB" | "RECORDINGS">, studioId: string): Promise<StoreEnv> {
  const tenantId = await studioTenantId(env.DB, studioId);
  return { RECORDINGS: scopeStore(env.RECORDINGS, tenantId) };
}

/** Delete every object under a prefix, page by page. */
export async function deleteAllUnder(bucket: ObjectStore, prefix: string): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list(cursor ? { prefix, limit: 1000, cursor } : { prefix, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    if (!page.truncated || !page.cursor) return;
    cursor = page.cursor;
  }
}
