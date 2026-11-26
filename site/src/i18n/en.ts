export const en = {
  skip: "Skip to content",
  brandHome: "Casthop home",
  navMain: "Main",
  navDocs: "Docs",
  navGithub: "GitHub",
  navGetStarted: "Get started",
  language: "Language",

  metaTitle: "Casthop — open-source browser live studio",
  metaDescription:
    "Open-source browser live studio. Guests join from a link, up to six on stage, and the composite goes live to several RTMP destinations with a recording kept.",

  heroEyebrow: "Open source · AGPL-3.0",
  heroTitle: "Go live from a browser tab, everywhere at once.",
  heroLede:
    "Casthop is a live studio you run yourself. Bring guests in from a link, put up to six on stage, and send one composite to YouTube, LinkedIn and X.",
  heroRepo: "Open the repo",
  heroDocs: "Read the docs",
  heroAlt:
    "The Casthop host studio: a dark booth with a two-person stage, backstage guest, and a white Go live button.",

  featuresTitle: "What it does today",
  feature1Title: "One encode, several destinations.",
  feature1Body:
    "Casthop sends the composite to YouTube, LinkedIn and X over RTMP at the same time. LiveKit Egress transcodes once and fans out to every URL, and a recording is kept alongside.",
  feature1Link: "How destinations work",
  feature2Title: "Guests join from a link.",
  feature2Body:
    "Send the guest link. No account, no install. Guests wait backstage until you bring them on, and up to six people can be on stage together. Hosting itself needs a signed-in account.",
  feature2Link: "Guests",
  feature3Title: "Background blur, in the browser.",
  feature3Body:
    "Camera blur runs on the device using MediaPipe's Selfie Segmenter. The model loads only when blur is on, and it is served from your own origin, not a CDN.",
  feature3Link: "Architecture",
  feature4Title: "Streams recover on their own.",
  feature4Body:
    "If Egress or a stream drops, the studio retries with backoff. Each destination row shows its own RTMP status, so you can see which one is down.",
  feature4Link: "Per-destination status",

  ossEyebrow: "Self-host",
  ossTitle: "You run the media plane.",
  ossP1:
    "LiveKit, Egress, Redis and an RTMP edge run in Docker on your machine or server. The control plane is a Cloudflare Worker with Durable Objects and D1. Stream keys stay in Durable Object storage and are never returned to guests.",
  ossP2:
    "The server is licensed AGPL-3.0-only, so hosted forks must share their changes. This is a working prototype: prove the core, measure it, then polish. Expect rough edges, and read the measurements in the repo rather than taking our word for it.",
  ossGithub: "View on GitHub",
  ossDocs: "Self-hosting docs",

  footerTagline: "Open-source browser live studio.",
  footerDocs: "Docs",
  footerGettingStarted: "Getting started",
  footerSelfHosting: "Self-hosting",
  footerConfiguration: "Configuration",
  footerArchitecture: "Architecture",
  footerProject: "Project",
  footerLicense: "Casthop is licensed under AGPL-3.0-only.",

  docsChromeTitle: "Casthop docs",
  docsChromeDescription: "Casthop documentation.",
  docsTitleSuffix: "Casthop docs",
  docsNav: "Documentation",
  docsSections: "Sections",
  searchDocs: "Search docs",
  searchHint: "Esc to close · ↑ ↓ to move · Enter to open",
  searchEmpty: "No results.",
  searchResults: "Results",
  onThisPage: "On this page",
  previous: "Previous",
  next: "Next",
  pagination: "Pagination",
  continueTo: "Continue to Getting started.",
} as const;

export type SiteMessageKey = keyof typeof en;
export type SiteMessages = Record<SiteMessageKey, string>;
