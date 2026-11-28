import type { PublicDestination, PublicStudio } from "../../worker/types";
import type { StudioView } from "./api";

export type ShotState = "main" | "chat" | "golive";

export function shotFromUrl(): ShotState | null {
  const value = new URLSearchParams(window.location.search).get("shot");
  if (value === "main" || value === "chat" || value === "golive") return value;
  return null;
}

function dest(
  id: PublicDestination["id"],
  kind: PublicDestination["kind"],
  label: string,
  detail: string,
  enabled: boolean,
  live: boolean,
): PublicDestination {
  return {
    id,
    kind,
    label,
    detail,
    enabled,
    hasKey: true,
    urlMasked: "rtmp://…",
    url: `rtmp://127.0.0.1:1935/live/${id}`,
    status: live && enabled ? "live" : "idle",
    error: null,
    aspect: "landscape",
  };
}

/** Sample booth used to capture the three mockup states. */
export function shotStudio(shot: ShotState): StudioView {
  const live = shot === "chat";
  const at = 1_700_000_000_000;
  const studio: PublicStudio = {
    id: "shot",
    title: "Weekly Build Log",
    layout: "side",
    live,
    liveStartedAt: live ? at - (14 * 60 + 32) * 1000 : null,
    liveError: null,
    liveFailed: false,
    livePhase: live ? "live" : "idle",
    bannerTitle: "Weekly Build Log",
    bannerSubtitle: "Episode 12",
    destinations: [
      dest("youtube", "youtube", "YouTube", "Ana Souza channel", true, live),
      dest("linkedin", "linkedin", "LinkedIn", "Personal profile", false, live),
      dest("x", "x", "X", "@anasouza", true, live),
    ],
    participants: [
      { identity: "host", name: "Ana Souza", role: "host", onStage: true, joinedAt: at },
      { identity: "g-marco", name: "Marco Lima", role: "guest", onStage: true, joinedAt: at },
      { identity: "g-julia", name: "Julia Reis", role: "guest", onStage: false, joinedAt: at },
    ],
    chat: [
      { id: "c1", from: "g-julia", name: "Julia Reis", text: "Audio sounds good from here.", at, source: "studio" },
      { id: "c2", from: "yt-pedro", name: "pedro.dev", text: "Will you share the repo link?", at, source: "youtube" },
      { id: "c3", from: "yt-lu", name: "lu.martins", text: "Joining from Recife 👋", at, source: "youtube" },
      { id: "c4", from: "g-marco", name: "Marco Lima", text: "Link is in the description.", at, source: "studio" },
    ],
    pinnedChat: live
      ? { id: "c2", name: "pedro.dev", text: "Will you share the repo link?", source: "youtube" }
      : null,
    createdAt: at,
    captions: { on: false, burn: false },
    captionLine: null,
    separateRecordings: false,
    isoSessionId: null,
  };
  return { ...studio, viewerRole: "owner" };
}

export const SHOT_LIVE_MS = (14 * 60 + 32) * 1000;
