import type {
  LayoutId,
  PublicDestination,
  PublicReplay,
  PublicStudio,
  RecordingList,
  ReplayVisibility,
  StudioMember,
  StudioRecord,
  ViewerRole,
} from "../../worker/types";

export type { PublicReplay, PublicStudio, PublicDestination, RecordingList, ReplayVisibility, StudioMember, StudioRecord, ViewerRole };

export type StudioView = PublicStudio & { viewerRole: ViewerRole };

export type AccountMe = {
  id: string;
  email: string | null;
  name: string;
  githubId: string | null;
};

function headers(extra?: HeadersInit): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(extra ?? {}),
  };
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: headers(init?.headers),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `${res.status} ${path}`);
  }
  return data;
}

export function getMe() {
  return api<AccountMe>("/api/auth/me");
}

export function requestMagicLink(email: string) {
  return api<{ ok: true; devLogin?: string }>("/api/auth/magic-link", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function logout() {
  return api<{ ok: true }>("/api/auth/logout", { method: "POST" });
}

export function listStudios() {
  return api<{ studios: StudioRecord[] }>("/api/studios");
}

export function createStudio(title: string) {
  return api<{ id: string; title: string; role: "owner"; hostUrl: string; guestUrl: string }>("/api/studios", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export function getStudio(id: string) {
  return api<StudioView>(`/api/studios/${id}`);
}

export function sendEgressBeat(id: string, token: string, egressId: string) {
  return api<{ ok: true }>(`/api/studios/${id}/egress-beat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ egressId }),
  });
}

export function getConfig() {
  return api<{
    livekitUrl: string;
    maxOnStage: number;
    github: boolean;
    signedIn: boolean;
    destinationChat: { youtube: boolean };
  }>("/api/config");
}

export function getHealth() {
  return api<{ ok: boolean; livekit: { ok: boolean } }>("/api/health");
}

export function mintToken(
  id: string,
  body: { name: string; role: "host" | "guest"; identity?: string; guestSecret?: string },
) {
  return api<{
    token: string;
    identity: string;
    name: string;
    role: "host" | "guest";
    url: string;
    canPublish: boolean;
    expiresIn: number;
    guestSecret?: string;
  }>(`/api/studios/${id}/token`, { method: "POST", body: JSON.stringify(body) });
}

export type StageResult = PublicStudio & { warning?: string };

export function setStage(id: string, identity: string, on: boolean) {
  return api<StageResult>(`/api/studios/${id}/stage`, {
    method: "POST",
    body: JSON.stringify({ identity, on }),
  });
}

export function setLayout(id: string, layout: LayoutId) {
  return api<PublicStudio>(`/api/studios/${id}/layout`, {
    method: "POST",
    body: JSON.stringify({ layout }),
  });
}

export function setDestinations(id: string, destinations: PublicDestination[]) {
  return api<PublicStudio>(`/api/studios/${id}/destinations`, {
    method: "POST",
    body: JSON.stringify({ destinations }),
  });
}

export function setBanner(id: string, patch: { title?: string; bannerTitle?: string; bannerSubtitle?: string }) {
  return api<PublicStudio>(`/api/studios/${id}/banner`, {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

export function setLive(id: string, live: boolean) {
  return api<PublicStudio>(`/api/studios/${id}/live`, {
    method: "POST",
    body: JSON.stringify({ live }),
  });
}

export function setSeparateRecordings(id: string, separateRecordings: boolean) {
  return api<PublicStudio>(`/api/studios/${id}/iso-pref`, {
    method: "POST",
    body: JSON.stringify({ separateRecordings }),
  });
}

export function listRecordings(id: string) {
  return api<RecordingList>(`/api/studios/${id}/recordings`);
}

export function isoDownloadPath(studioId: string, trackId: string): string {
  return `/api/studios/${studioId}/recordings/iso/${trackId}`;
}

export function sendChat(
  id: string,
  body: { text: string; identity?: string; guestSecret?: string },
) {
  return api<PublicStudio>(`/api/studios/${id}/chat`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function pinChat(id: string, chatId: string | null) {
  return api<PublicStudio>(`/api/studios/${id}/pin`, {
    method: "POST",
    body: JSON.stringify({ chatId }),
  });
}

export function listCohosts(id: string) {
  return api<{ members: StudioMember[]; pending: { id: string; email: string }[] }>(`/api/studios/${id}/cohosts`);
}

export function inviteCohost(id: string, email: string) {
  return api<{ ok: true; pending?: boolean; member?: StudioMember }>(`/api/studios/${id}/cohosts`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function removeCohost(id: string, accountId: string) {
  return api<{ ok: true }>(`/api/studios/${id}/cohosts/${accountId}`, { method: "DELETE" });
}

export function setReplayVisibility(studioId: string, replayId: string, visibility: ReplayVisibility) {
  return api<PublicReplay>(`/api/studios/${studioId}/replays/${replayId}`, {
    method: "PATCH",
    body: JSON.stringify({ visibility }),
  });
}

export function getReplay(replayId: string) {
  return api<PublicReplay>(`/api/replays/${replayId}`);
}
