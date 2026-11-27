export type LayoutId = "solo" | "side" | "screen";

export type DestinationKind = "youtube" | "linkedin" | "x" | "custom";

/** Which composite this destination receives. Landscape is the 16:9 program. */
export type DestAspect = "landscape" | "portrait";

/** Host intent vs compositor health, shown in the studio pill. */
export type LivePhase = "idle" | "starting" | "live" | "retrying" | "stopping" | "failed";

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
  retryCount?: number;
  retryAt?: number | null;
  /** Omitted on older stored rows; treat as landscape. */
  aspect?: DestAspect;
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
  aspect: DestAspect;
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

export type PinnedChat = {
  id: string;
  name: string;
  text: string;
  source: ChatMessage["source"];
};

export type DestChatState = {
  liveChatId?: string;
  pageToken?: string;
  nextPollAt: number;
};

export type IsoTrackKind = "camera" | "screen";

/** One MediaRecorder run for a person, stored as numbered R2 chunks. */
export type IsoTrack = {
  id: string;
  sessionId: string;
  identity: string;
  name: string;
  kind: IsoTrackKind;
  mimeType: string;
  startedAt: number;
  endedAt: number | null;
  bytes: number;
  chunks: number;
  complete: boolean;
};

export type RecordingList = {
  mixed: { filename: string; startedAt: number | null } | null;
  tracks: IsoTrack[];
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
  /** Watchdog stopped retrying; host can Retry. */
  liveFailed?: boolean;
  egressRetryCount: number;
  egressRetryAt: number | null;
  /** First compositor death / start failure in this recovery window. */
  egressRecoveringSince?: number | null;
  /** Dead egress ids we already gave up on; do not re-adopt from ListEgress. */
  abandonedEgressIds?: string[];
  /** Last compositor page beat; used to drop Live as soon as Chrome dies. */
  egressHeartbeatAt?: number | null;
  /** Second RoomComposite for 9:16 destinations. Independent encode. */
  portraitEgressId?: string | null;
  portraitHeartbeatAt?: number | null;
  portraitRetryCount?: number;
  portraitRetryAt?: number | null;
  portraitRecoveringSince?: number | null;
  emptySince: number | null;
  egressId: string | null;
  recordingPath: string | null;
  /** Host opted into per-person browser recordings for the next live. */
  separateRecordings: boolean;
  /** Current live session id for ISO tracks. Public so each browser can start. */
  isoSessionId: string | null;
  /** Per-person tracks. Hosts list these on GET recordings; never on public state. */
  isoTracks: IsoTrack[];
  bannerTitle: string;
  bannerSubtitle: string;
  destinations: Destination[];
  participants: ParticipantInfo[];
  /** Identities removed from the studio; join rejects them until they are a member again. */
  kickedIdentities?: string[];
  chat: ChatMessage[];
  pinnedChat?: PinnedChat | null;
  /** Internal YouTube poll cursor. Not public. */
  destChat?: { youtube?: DestChatState };
  createdAt: number;
};

export type Env = {
  STUDIO: DurableObjectNamespace;
  DB: D1Database;
  RECORDINGS: R2Bucket;
  ASSETS: Fetcher;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  HOST_KEY_SECRET?: string;
  LIVEKIT_HTTP_URL: string;
  PUBLIC_LIVEKIT_URL: string;
  RTMP_YOUTUBE: string;
  RTMP_LINKEDIN: string;
  RTMP_X: string;
  EGRESS_TEMPLATE_URL: string;
  CASTHOP_ALLOW_DEV_KEYS?: string;
  CASTHOP_EMPTY_GRACE_MS?: string;
  CASTHOP_COMPOSITOR_GRACE_MS?: string;
  CASTHOP_BACKOFF_MS?: string;
  CASTHOP_RECOVERY_MS?: string;
  CASTHOP_HEARTBEAT_MS?: string;
  CASTHOP_TRUST_FORWARDED?: string;
  /** Hosted mode. Each is off unless set; see the configuration docs. */
  CASTHOP_SIGNIN?: string;
  CASTHOP_EXTERNAL_AUTH_KEYS?: string;
  CASTHOP_EXTERNAL_AUTH_ISSUER?: string;
  CASTHOP_SERVICE_KEYS?: string;
  PUBLIC_ORIGIN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  MAIL_WEBHOOK_URL?: string;
  MAIL_WEBHOOK_TOKEN?: string;
  YOUTUBE_API_KEY?: string;
  YOUTUBE_LIVE_CHAT_ID?: string;
  YOUTUBE_VIDEO_ID?: string;
  YOUTUBE_OAUTH_CLIENT_ID?: string;
  YOUTUBE_OAUTH_CLIENT_SECRET?: string;
  YOUTUBE_OAUTH_REFRESH_TOKEN?: string;
};

export type WorkerVars = {
  sessionCookie?: string;
};

export type AppEnv = {
  Bindings: Env;
  Variables: WorkerVars;
};

export type Account = {
  id: string;
  email: string | null;
  name: string;
  githubId: string | null;
  createdAt: number;
};

export type MemberRole = "owner" | "cohost";

export type ReplayVisibility = "private" | "public";

export type ReplayRecord = {
  id: string;
  studioId: string;
  title: string;
  visibility: ReplayVisibility;
  durationMs: number | null;
  createdAt: number;
  bytes: number;
  files: number;
};

export type PublicReplay = Omit<ReplayRecord, "studioId"> & {
  studioId?: string;
  playlistUrl: string;
  viewerCanEdit: boolean;
};

export type ClipRecord = ReplayRecord & {
  seconds: 30 | 60;
};

export type PublicClip = Omit<ClipRecord, "studioId"> & {
  studioId?: string;
  playlistUrl: string;
  downloadUrl: string;
  viewerCanEdit: boolean;
};

export type StudioRecord = {
  id: string;
  title: string;
  ownerId: string;
  createdAt: number;
  role: MemberRole;
  replays: ReplayRecord[];
  clips: ClipRecord[];
};

export type StudioMember = {
  accountId: string;
  email: string | null;
  name: string;
  role: MemberRole;
};

export type ViewerRole = "owner" | "cohost" | "guest";

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
  | "kickedIdentities"
  | "egressHeartbeatAt"
  | "abandonedEgressIds"
  | "egressRecoveringSince"
  | "destChat"
  | "isoTracks"
  | "portraitEgressId"
  | "portraitHeartbeatAt"
  | "portraitRetryCount"
  | "portraitRetryAt"
  | "portraitRecoveringSince"
> & {
  destinations: PublicDestination[];
  egressId?: string | null;
  livePhase: LivePhase;
};

export const MAX_ON_STAGE = 6;

export function destAspectOf(d: { aspect?: string | null }): DestAspect {
  return d.aspect === "portrait" ? "portrait" : "landscape";
}

function idleDest(
  id: Destination["id"],
  kind: DestinationKind,
  label: string,
  detail: string,
  url: string,
  enabled: boolean,
): Destination {
  return {
    id,
    kind,
    label,
    detail,
    url,
    enabled,
    status: "idle",
    error: null,
    retryCount: 0,
    retryAt: null,
    aspect: "landscape",
  };
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
