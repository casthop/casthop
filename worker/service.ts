import { Hono } from "hono";
import type { AppEnv } from "./types";
import { claimNonce, studioTenantId, studiosOfTenant } from "./db";
import { findOrCreateEmailAccount } from "./auth";
import { parseKeyList, verifyServiceRequest } from "./hosted";
import { asEmail, asName } from "./security";
import { createStudio, destroyStudio, destroyTenant } from "./studios";
import { asTenantId } from "./tenant";

/** Signed API for a control plane. Off (404) unless CASTHOP_SERVICE_KEYS is set. */
export const service = new Hono<AppEnv>();

service.use("*", async (c, next) => {
  const keys = parseKeyList(c.env.CASTHOP_SERVICE_KEYS);
  if (!keys) return c.json({ error: "not found" }, 404);
  const verified = await verifyServiceRequest(keys, c.req.raw, await c.req.arrayBuffer());
  const fresh = verified ? await claimNonce(c.env.DB, verified.nonceKey, verified.nonceExpiresAt) : false;
  if (!fresh) return c.json({ error: "bad_signature" }, 401);
  await next();
});

service.post("/studios", async (c) => {
  const body = ((await c.req.json().catch(() => null)) ?? {}) as { tenantId?: unknown; ownerEmail?: unknown; ownerName?: unknown; name?: unknown };
  const tenantId = asTenantId(body.tenantId);
  if (!tenantId) return c.json({ error: "valid tenantId required" }, 400);
  const email = asEmail(body.ownerEmail);
  if (!email) return c.json({ error: "valid ownerEmail required" }, 400);
  const owner = await findOrCreateEmailAccount(c.env, email, body.ownerName === undefined ? undefined : asName(body.ownerName, "Host"));
  const title = asName(body.name, "Weekly product update");
  const studio = await createStudio(c.env, { ownerId: owner.id, title, tenantId });
  if (!studio || "limited" in studio) return c.json({ error: "failed to create studio" }, 500);
  return c.json({ studio: { id: studio.id, name: studio.title, tenantId, ownerId: owner.id } }, 201);
});

service.get("/tenants/:tenantId/studios", async (c) => {
  const tenantId = asTenantId(c.req.param("tenantId"));
  if (!tenantId) return c.json({ error: "valid tenantId required" }, 400);
  const rows = await studiosOfTenant(c.env.DB, tenantId);
  return c.json({ studios: rows.map((r) => ({ id: r.id, name: r.title, ownerId: r.owner_id, createdAt: r.created_at })) });
});

service.delete("/studios/:id", async (c) => {
  const tenantId = asTenantId(c.req.query("tenantId"));
  if (!tenantId) return c.json({ error: "valid tenantId required" }, 400);
  const id = c.req.param("id");
  if ((await studioTenantId(c.env.DB, id)) !== tenantId) return c.json({ error: "not found" }, 404);
  await destroyStudio(c.env, id, tenantId);
  return c.json({ deleted: true });
});

service.delete("/tenants/:tenantId", async (c) => {
  const tenantId = asTenantId(c.req.param("tenantId"));
  if (!tenantId) return c.json({ error: "valid tenantId required" }, 400);
  return c.json({ deleted: await destroyTenant(c.env, tenantId) });
});
