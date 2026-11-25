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
