import type { Env, LayoutId } from "./types";
import { layoutToEgress } from "./types";
import { bytesToB64Url, hmacSha256B64Url, randomId, sha256hex, timingSafeEqual } from "./security";

export { randomId, sha256hex };

function jsonToB64Url(obj: unknown): string {
  return bytesToB64Url(new TextEncoder().encode(JSON.stringify(obj)));
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

/** Host/co-host LiveKit JWTs. Short so a kick cannot be undone with a leftover token. */
export const HOST_TOKEN_TTL_SEC = 10 * 60;
export const GUEST_TOKEN_TTL_SEC = 6 * 60 * 60;
export const API_TOKEN_TTL_SEC = 6 * 60 * 60;

async function signJwt(
  apiKey: string,
  apiSecret: string,
  sub: string,
  name: string,
  video: VideoGrant,
  ttlSec: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    iss: apiKey,
    sub,
    name,
    nbf: now - 10,
    exp: now + ttlSec,
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
  ttlSec?: number;
}): Promise<string> {
  return signJwt(
    opts.env.LIVEKIT_API_KEY,
    opts.env.LIVEKIT_API_SECRET,
    opts.identity,
    opts.name,
    {
      room: opts.room,
      roomJoin: true,
      canPublish: opts.canPublish,
      canSubscribe: true,
      canPublishData: opts.canPublishData ?? opts.canPublish,
      canUpdateOwnMetadata: false,
      roomAdmin: !!opts.roomAdmin,
    },
    opts.ttlSec ?? GUEST_TOKEN_TTL_SEC,
  );
}

export async function guestSecretFor(env: Env, studioId: string, identity: string): Promise<string> {
  return hmacSha256B64Url(env.LIVEKIT_API_SECRET, `guest:${studioId}:${identity}`);
}

export async function guestSecretOk(env: Env, studioId: string, identity: string, secret: string): Promise<boolean> {
  if (!secret || !identity) return false;
  const expected = await guestSecretFor(env, studioId, identity);
  return timingSafeEqual(expected, secret);
}

export async function mintApiToken(env: Env): Promise<string> {
  return signJwt(
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
    "casthop-api",
    "casthop",
    {
      roomCreate: true,
      roomList: true,
      roomAdmin: true,
      roomRecord: true,
    },
    API_TOKEN_TTL_SEC,
  );
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

export async function removeParticipant(env: Env, room: string, identity: string): Promise<void> {
  await twirp(env, "/twirp/livekit.RoomService/RemoveParticipant", { room, identity });
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

export async function listEgress(env: Env, room: string): Promise<unknown> {
  return twirp(env, "/twirp/livekit.Egress/ListEgress", { room_name: room });
}
