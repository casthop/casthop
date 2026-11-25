import type { Env, LayoutId } from "./types";
import { layoutToEgress } from "./types";

function bytesToB64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function jsonToB64Url(obj: unknown): string {
  return bytesToB64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function hmacSha256B64Url(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToB64Url(new Uint8Array(sig));
}

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId(bytes = 8): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToB64Url(buf).replaceAll("-", "x").replaceAll("_", "y").slice(0, bytes + 4);
}

type VideoGrant = {
  room?: string;
  roomJoin?: boolean;
  roomCreate?: boolean;
  roomList?: boolean;
  roomAdmin?: boolean;
  roomRecord?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canUpdateOwnMetadata?: boolean;
};

async function signJwt(apiKey: string, apiSecret: string, sub: string, name: string, video: VideoGrant): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    iss: apiKey,
    sub,
    name,
    nbf: now - 10,
    exp: now + 60 * 60 * 6,
    jti: crypto.randomUUID(),
    video,
  };
  const unsigned = `${jsonToB64Url(header)}.${jsonToB64Url(claims)}`;
  return `${unsigned}.${await hmacSha256B64Url(apiSecret, unsigned)}`;
}

export async function mintParticipantToken(opts: {
  env: Env;
  identity: string;
  name: string;
  room: string;
  canPublish: boolean;
  canPublishData?: boolean;
  roomAdmin?: boolean;
}): Promise<string> {
  return signJwt(opts.env.LIVEKIT_API_KEY, opts.env.LIVEKIT_API_SECRET, opts.identity, opts.name, {
    room: opts.room,
    roomJoin: true,
    canPublish: opts.canPublish,
    canSubscribe: true,
    canPublishData: opts.canPublishData ?? opts.canPublish,
    canUpdateOwnMetadata: false,
    roomAdmin: !!opts.roomAdmin,
  });
}

export async function guestSecretFor(env: Env, studioId: string, identity: string): Promise<string> {
  return hmacSha256B64Url(env.LIVEKIT_API_SECRET, `guest:${studioId}:${identity}`);
}

export async function guestSecretOk(env: Env, studioId: string, identity: string, secret: string): Promise<boolean> {
  if (!secret || !identity) return false;
  const expected = await guestSecretFor(env, studioId, identity);
  if (expected.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export async function mintApiToken(env: Env): Promise<string> {
  return signJwt(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, "casthop-api", "casthop", {
    roomCreate: true,
    roomList: true,
    roomAdmin: true,
    roomRecord: true,
  });
}

async function twirp<T>(env: Env, path: string, body: unknown): Promise<T> {
  const token = await mintApiToken(env);
  const res = await fetch(`${env.LIVEKIT_HTTP_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LiveKit ${path} ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function livekitHealth(env: Env): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${env.LIVEKIT_HTTP_URL}/`, { method: "GET" });
    return { ok: res.ok || res.status === 404 || res.status === 200, detail: `http ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "unreachable" };
  }
}

export async function updateParticipantPublish(env: Env, room: string, identity: string, canPublish: boolean): Promise<void> {
  await twirp(env, "/twirp/livekit.RoomService/UpdateParticipant", {
    room,
    identity,
    permission: {
      can_subscribe: true,
      can_publish: canPublish,
      can_publish_data: false,
      can_update_metadata: false,
    },
  });
}

export async function startRoomComposite(opts: {
  env: Env;
  room: string;
  layout: LayoutId;
  urls: string[];
  filepath: string;
}): Promise<{ egressId: string }> {
  const layout = opts.env.EGRESS_TEMPLATE_URL ? opts.layout : layoutToEgress(opts.layout);
  const body: Record<string, unknown> = {
    room_name: opts.room,
    layout,
    preset: 0,
    file_outputs: [
      {
        filepath: opts.filepath,
      },
    ],
  };
  if (opts.urls.length) {
    body.stream_outputs = [
      {
        protocol: 1,
        urls: opts.urls,
      },
    ];
  }
  if (opts.env.EGRESS_TEMPLATE_URL) {
    body.custom_base_url = opts.env.EGRESS_TEMPLATE_URL;
  }
  const started = await twirp<{ egress_id?: string; egressId?: string }>(
    opts.env,
    "/twirp/livekit.Egress/StartRoomCompositeEgress",
    body,
  );
  const egressId = started.egress_id || started.egressId;
  if (!egressId) throw new Error("Egress started but no egress_id in response");
  return { egressId };
}

export async function stopEgress(env: Env, egressId: string): Promise<void> {
  await twirp(env, "/twirp/livekit.Egress/StopEgress", { egress_id: egressId });
}

export async function updateEgressLayout(env: Env, egressId: string, layout: LayoutId): Promise<void> {
  await twirp(env, "/twirp/livekit.Egress/UpdateLayout", {
    egress_id: egressId,
    layout: env.EGRESS_TEMPLATE_URL ? layout : layoutToEgress(layout),
  });
}

export async function listEgressRaw(env: Env, room: string): Promise<unknown> {
  return twirp(env, "/twirp/livekit.Egress/ListEgress", { room_name: room });
}

export async function listRoomParticipantsRaw(env: Env, room: string): Promise<unknown> {
  return twirp(env, "/twirp/livekit.RoomService/ListParticipants", { room });
}

export async function updateStream(env: Env, egressId: string, add: string[], remove: string[]): Promise<void> {
  if (!add.length && !remove.length) return;
  await twirp(env, "/twirp/livekit.Egress/UpdateStream", {
    egress_id: egressId,
    add_output_urls: add,
    remove_output_urls: remove,
  });
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function sha256b64(body: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return bytesToB64(new Uint8Array(d));
}

function bearerToken(header: string): string {
  const trimmed = header.trim();
  if (trimmed.toLowerCase().startsWith("bearer ")) return trimmed.slice(7).trim();
  return trimmed;
}

function b64UrlToBytes(raw: string): Uint8Array {
  const pad = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
  const b64 = (raw + pad).replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyLivekitWebhook(env: Env, authorization: string | undefined, body: string): Promise<boolean> {
  if (!authorization) return false;
  const token = bearerToken(authorization);
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return false;
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = await hmacSha256B64Url(env.LIVEKIT_API_SECRET, unsigned);
  const got = parts[2].replace(/=+$/, "");
  if (!timingEqual(expected, got)) return false;
  let claims: { iss?: unknown; exp?: unknown; nbf?: unknown; sha256?: unknown };
  try {
    claims = JSON.parse(new TextDecoder().decode(b64UrlToBytes(parts[1]))) as typeof claims;
  } catch {
    return false;
  }
  if (claims.iss !== env.LIVEKIT_API_KEY) return false;
  if (typeof claims.exp !== "number") return false;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp + 10 < now) return false;
  if (typeof claims.nbf === "number" && claims.nbf - 10 > now) return false;
  if (typeof claims.sha256 !== "string" || !claims.sha256) return false;
  const digest = await sha256b64(body);
  return timingEqual(claims.sha256, digest);
}

export async function signLivekitWebhook(env: Env, body: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    iss: env.LIVEKIT_API_KEY,
    nbf: now - 10,
    exp: now + 60 * 10,
    sha256: await sha256b64(body),
  };
  const unsigned = `${jsonToB64Url(header)}.${jsonToB64Url(claims)}`;
  return `${unsigned}.${await hmacSha256B64Url(env.LIVEKIT_API_SECRET, unsigned)}`;
}
