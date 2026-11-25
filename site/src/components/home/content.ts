// Same copy as the live home page, kept here so the previews compare hero only.
export const features = [
  { n: "01", title: "One encode, several destinations.", body: "Casthop sends the composite to YouTube, LinkedIn and X over RTMP at the same time. LiveKit Egress transcodes once and fans out to every URL, and a recording is kept alongside.", link: { href: "/docs/destinations", label: "How destinations work" } },
  { n: "02", title: "Guests join from a link.", body: "Send the guest link. No account, no install. Guests wait backstage until you bring them on, and up to six people can be on stage together. Hosting itself needs a signed-in account.", link: { href: "/docs/guests", label: "Guests" } },
  { n: "03", title: "Background blur, in the browser.", body: "Camera blur runs on the device using MediaPipe's Selfie Segmenter. The model loads only when blur is on, and it is served from your own origin, not a CDN.", link: { href: "/docs/architecture", label: "Architecture" } },
  { n: "04", title: "Streams recover on their own.", body: "If Egress or a stream drops, the studio retries with backoff. Each destination row shows its own RTMP status, so you can see which one is down.", link: { href: "/docs/destinations", label: "Per-destination status" } },
];

export const variants = [
  { key: "a", label: "A", name: "Aurora", href: "/hero-a" },
  { key: "b", label: "B", name: "Grid", href: "/hero-b" },
  { key: "c", label: "C", name: "Fan-out", href: "/hero-c" },
] as const;

export type VariantKey = (typeof variants)[number]["key"];
