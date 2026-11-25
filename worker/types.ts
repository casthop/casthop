export type LayoutId = "solo" | "side" | "screen";

export type DestinationKind = "youtube" | "linkedin" | "x" | "custom";

/** Host intent vs compositor health, shown in the studio pill. */
export type LivePhase = "idle" | "starting" | "live" | "retrying" | "stopping";

/** Per-RTMP URL. Guests see this; they never see the URL itself. */
export type DestStatus = "idle" | "connecting" | "live" | "retrying" | "failed" | "stopped";

export type Destination = {
  id: string;
  kind: DestinationKind;
  label: string;
  detail: string;
  url: string;
  enabled: boolean;
  status: DestStatus;
  error: string | null;
};

/** Wire format. `url` is present only for an authenticated host. */
export type PublicDestination = {
  id: string;
  kind: DestinationKind;
  label: string;
  detail: string;
  enabled: boolean;
  hasKey: boolean;
  urlMasked: string;
  url?: string;
  status: DestStatus;
  error: string | null;
};

export type ParticipantInfo = {
  identity: string;
  name: string;
  role: "host" | "guest";
  onStage: boolean;
  joinedAt: number;
};

export type ChatMessage = {
  id: string;
  from: string;
  name: string;
  text: string;
  at: number;
  source: "studio" | "youtube" | "linkedin" | "x";
};

export type StudioState = {
  id: string;
  title: string;
  hostKeyHash: string;
  layout: LayoutId;
  live: boolean;
  liveStartedAt: number | null;
  liveStartingAt?: number;
  /** Host clicked Go Live; watchdog retries until this is false. */
  wantLive: boolean;
  liveError: string | null;
  egressRetryCount: number;
  egressRetryAt: number | null;
  emptySince: number | null;
  egressId: string | null;
  recordingPath: string | null;
  bannerTitle: string;
  bannerSubtitle: string;
  destinations: Destination[];
  participants: ParticipantInfo[];
  chat: ChatMessage[];
  createdAt: number;
};

export type Env = {
  STUDIO: DurableObjectNamespace;
  DB: D1Database;
  RECORDINGS: R2Bucket;
  ASSETS: Fetcher;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  LIVEKIT_HTTP_URL: string;
  PUBLIC_LIVEKIT_URL: string;
  RTMP_YOUTUBE: string;
  RTMP_LINKEDIN: string;
  RTMP_X: string;
  EGRESS_TEMPLATE_URL: string;
  CASTHOP_ALLOW_DEV_KEYS?: string;
  CASTHOP_EMPTY_GRACE_MS?: string;
  CASTHOP_BACKOFF_MS?: string;
};

export type PublicStudio = Omit<
  StudioState,
  | "hostKeyHash"
  | "destinations"
  | "recordingPath"
  | "egressId"
  | "liveStartingAt"
  | "wantLive"
  | "egressRetryCount"
  | "egressRetryAt"
  | "emptySince"
> & {
  destinations: PublicDestination[];
  egressId?: string | null;
  livePhase: LivePhase;
};

export const MAX_ON_STAGE = 6;

function idleDest(
  id: Destination["id"],
  kind: DestinationKind,
  label: string,
  detail: string,
  url: string,
  enabled: boolean,
): Destination {
  return { id, kind, label, detail, url, enabled, status: "idle", error: null };
}

export function defaultDestinations(env: Pick<Env, "RTMP_YOUTUBE" | "RTMP_LINKEDIN" | "RTMP_X">): Destination[] {
  return [
    idleDest("youtube", "youtube", "YouTube", "Channel · public", env.RTMP_YOUTUBE, true),
    idleDest("linkedin", "linkedin", "LinkedIn", "Company page", env.RTMP_LINKEDIN, true),
    idleDest("x", "x", "X", "Account", env.RTMP_X, true),
    idleDest("custom", "custom", "Custom RTMP", "rtmp://…/live", "", false),
  ];
}

export function layoutToEgress(layout: LayoutId): string {
  if (layout === "solo") return "speaker";
  if (layout === "screen") return "speaker";
  return "grid";
}
