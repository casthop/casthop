import { deleteStudioRows, insertMember, insertStudioRow, setStudioTenant, studiosOfTenant } from "./db";
import { hostKeyFor, randomId, sha256hex } from "./security";
import { deleteAllUnder, scopeStore, tenantKeyPrefix } from "./tenant";
import type { Env } from "./types";

export function studioStub(env: Env, id: string): DurableObjectStub {
  return env.STUDIO.get(env.STUDIO.idFromName(id));
}

/** Keep in step with the key builders in clips.ts, replays.ts and iso.ts. */
function studioKeyPrefixes(studioId: string): string[] {
  return [`live/${studioId}/`, `clips/${studioId}/`, `replays/${studioId}/`, `iso/${studioId}/`];
}

/** Row, owner membership and Durable Object for a new studio. Null if the Durable Object refuses it. */
export async function createStudio(
  env: Env,
  input: { ownerId: string; title: string; tenantId?: string },
): Promise<{ id: string; title: string } | null> {
  const id = randomId(8).toLowerCase();
  const hostKeyHash = await sha256hex(await hostKeyFor(env, id));
  const createdAt = Date.now();
  await insertStudioRow(env.DB, id, input.title, createdAt, input.ownerId);
  if (input.tenantId) await setStudioTenant(env.DB, id, input.tenantId);
  await insertMember(env.DB, id, input.ownerId, "owner", createdAt);
  const created = await studioStub(env, id).fetch(`https://studio/${id}?action=create`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, title: input.title, hostKeyHash }),
  });
  return created.ok ? { id, title: input.title } : null;
}

/** Ends egress, wipes Durable Object storage, R2 objects and D1 rows. D1 goes last so a failed run can be repeated. */
export async function destroyStudio(env: Env, studioId: string, tenantId: string | null): Promise<void> {
  const res = await studioStub(env, studioId).fetch(`https://studio/${studioId}?action=destroy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostKey: await hostKeyFor(env, studioId) }),
  });
  // 404: the Durable Object never had state or is already empty.
  if (!res.ok && res.status !== 404) throw new Error(`studio ${studioId} destroy failed: ${res.status}`);
  const store = scopeStore(env.RECORDINGS, tenantId);
  for (const prefix of studioKeyPrefixes(studioId)) await deleteAllUnder(store, prefix);
  await deleteStudioRows(env.DB, studioId);
}

export async function destroyTenant(env: Env, tenantId: string): Promise<number> {
  const studios = await studiosOfTenant(env.DB, tenantId);
  for (const studio of studios) await destroyStudio(env, studio.id, tenantId);
  await deleteAllUnder(env.RECORDINGS, tenantKeyPrefix(tenantId));
  return studios.length;
}
