export type LayoutId = "solo" | "side" | "screen";

export type DestinationKind = "youtube" | "linkedin" | "x" | "custom";

export type Destination = {
  id: string;
  kind: DestinationKind;
  label: string;
  detail: string;
  url: string;
  enabled: boolean;
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
  egressId: string | null;
  recordingPath: string | null;
  bannerTitle: string;
  bannerSubtitle: string;
  destinations: Destination[];
  participants: ParticipantInfo[];
  /** Identities removed from the studio; join rejects them until they are a member again. */
  kickedIdentities?: string[];
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
  HOST_KEY_SECRET?: string;
  LIVEKIT_HTTP_URL: string;
  PUBLIC_LIVEKIT_URL: string;
  RTMP_YOUTUBE: string;
  RTMP_LINKEDIN: string;
  RTMP_X: string;
  EGRESS_TEMPLATE_URL: string;
  CASTHOP_ALLOW_DEV_KEYS?: string;
  CASTHOP_TRUST_FORWARDED?: string;
  PUBLIC_ORIGIN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  MAIL_WEBHOOK_URL?: string;
  MAIL_WEBHOOK_TOKEN?: string;
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

export type StudioRecord = {
  id: string;
  title: string;
  ownerId: string;
  createdAt: number;
  role: MemberRole;
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
  "hostKeyHash" | "destinations" | "recordingPath" | "egressId" | "liveStartingAt" | "kickedIdentities"
> & {
  destinations: PublicDestination[];
  egressId?: string | null;
};

export const MAX_ON_STAGE = 6;

export function defaultDestinations(env: Pick<Env, "RTMP_YOUTUBE" | "RTMP_LINKEDIN" | "RTMP_X">): Destination[] {
  return [
    {
      id: "youtube",
      kind: "youtube",
      label: "YouTube",
      detail: "Channel · public",
      url: env.RTMP_YOUTUBE,
      enabled: true,
    },
    {
      id: "linkedin",
      kind: "linkedin",
      label: "LinkedIn",
      detail: "Company page",
      url: env.RTMP_LINKEDIN,
      enabled: true,
    },
    {
      id: "x",
      kind: "x",
      label: "X",
      detail: "Account",
      url: env.RTMP_X,
      enabled: true,
    },
    {
      id: "custom",
      kind: "custom",
      label: "Custom RTMP",
      detail: "rtmp://…/live",
      url: "",
      enabled: false,
    },
  ];
}

export function layoutToEgress(layout: LayoutId): string {
  if (layout === "solo") return "speaker";
  if (layout === "screen") return "speaker";
  return "grid";
}
