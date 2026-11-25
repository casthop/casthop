import type { LayoutId, PublicDestination, PublicStudio } from "../../worker/types";
import { HOST_KEY_HEADER } from "../../worker/security";

export type { PublicStudio, PublicDestination };

function headers(hostKey?: string, extra?: HeadersInit): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(hostKey ? { [HOST_KEY_HEADER]: hostKey } : {}),
    ...(extra ?? {}),
  };
}

export async function api<T>(path: string, init?: RequestInit & { hostKey?: string }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: headers(init?.hostKey, init?.headers),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `${res.status} ${path}`);
  }
  return data;
}

export function createStudio(title: string) {
  return api<{ id: string; title: string; hostKey: string; hostUrl: string; guestUrl: string }>("/api/studios", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export function getStudio(id: string, hostKey?: string) {
  return api<PublicStudio>(`/api/studios/${id}`, { hostKey });
}

export function getConfig() {
  return api<{ livekitUrl: string; maxOnStage: number }>("/api/config");
}

export function getHealth() {
  return api<{ ok: boolean; livekit: { ok: boolean } }>("/api/health");
}

export function mintToken(
  id: string,
  body: { name: string; role: "host" | "guest"; hostKey?: string; identity?: string; guestSecret?: string },
) {
  return api<{
    token: string;
    identity: string;
    name: string;
    role: "host" | "guest";
    url: string;
    canPublish: boolean;
    guestSecret?: string;
  }>(`/api/studios/${id}/token`, { method: "POST", body: JSON.stringify(body), hostKey: body.hostKey });
}

export function setStage(id: string, hostKey: string, identity: string, on: boolean) {
  return api<PublicStudio>(`/api/studios/${id}/stage`, {
    method: "POST",
    hostKey,
    body: JSON.stringify({ hostKey, identity, on }),
  });
}

export function setLayout(id: string, hostKey: string, layout: LayoutId) {
  return api<PublicStudio>(`/api/studios/${id}/layout`, {
    method: "POST",
    hostKey,
    body: JSON.stringify({ hostKey, layout }),
  });
}

export function setDestinations(id: string, hostKey: string, destinations: PublicDestination[]) {
  return api<PublicStudio>(`/api/studios/${id}/destinations`, {
    method: "POST",
    hostKey,
    body: JSON.stringify({ hostKey, destinations }),
  });
}

export function setBanner(id: string, hostKey: string, patch: { title?: string; bannerTitle?: string; bannerSubtitle?: string }) {
  return api<PublicStudio>(`/api/studios/${id}/banner`, {
    method: "POST",
    hostKey,
    body: JSON.stringify({ hostKey, ...patch }),
  });
}

export function setLive(id: string, hostKey: string, live: boolean) {
  return api<PublicStudio>(`/api/studios/${id}/live`, {
    method: "POST",
    hostKey,
    body: JSON.stringify({ hostKey, live }),
  });
}

export function sendChat(id: string, body: { identity: string; name: string; text: string }) {
  return api<PublicStudio>(`/api/studios/${id}/chat`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
