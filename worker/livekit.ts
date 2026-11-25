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
  roomAdmin?: boolean;
}): Promise<string> {
  return signJwt(opts.env.LIVEKIT_API_KEY, opts.env.LIVEKIT_API_SECRET, opts.identity, opts.name, {
    room: opts.room,
    roomJoin: true,
    canPublish: opts.canPublish,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
    roomAdmin: !!opts.roomAdmin,
  });
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
      can_publish_data: true,
      can_update_metadata: true,
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
  const body: Record<string, unknown> = {
    room_name: opts.room,
    layout: layoutToEgress(opts.layout),
    preset: 0,
    file_outputs: [
      {
        filepath: opts.filepath,
      },
    ],
    stream_outputs: [
      {
        protocol: 1,
        urls: opts.urls,
      },
    ],
  };
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
    layout: layoutToEgress(layout),
  });
}

export async function listEgress(env: Env, room: string): Promise<unknown> {
  return twirp(env, "/twirp/livekit.Egress/ListEgress", { room_name: room });
}
