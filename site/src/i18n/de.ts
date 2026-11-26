import type { SiteMessages } from "./en";

const de: SiteMessages = {
  skip: "Zum Inhalt springen",
  brandHome: "Casthop-Startseite",
  navMain: "Hauptnavigation",
  navDocs: "Docs",
  navGithub: "GitHub",
  navGetStarted: "Loslegen",
  navMenu: "Menü",
  language: "Sprache",

  metaTitle: "Casthop – Open-Source-Livestudio im Browser",
  metaDescription:
    "Open-Source-Livestudio im Browser. Gäste kommen über einen Link, bis zu sechs auf der Bühne, das Composite geht live an mehrere RTMP-Ziele, mit Aufzeichnung.",

  heroEyebrow: "Open Source · AGPL-3.0",
  heroTitle: "Geh live aus einem Browser-Tab – überall gleichzeitig.",
  heroLede:
    "Casthop ist ein Livestudio, das du selbst betreibst. Hol Gäste per Link dazu, stell bis zu sechs auf die Bühne und schick ein Composite an YouTube, LinkedIn und X.",
  heroRepo: "Repo öffnen",
  heroDocs: "Dokumentation lesen",
  heroAlt:
    "Das Casthop-Hoststudio: eine dunkle Kabine mit einer Bühne für zwei Personen, ein Gast hinter der Bühne und ein weißer „Live gehen“-Button.",

  featuresTitle: "Was es heute kann",
  feature1Title: "Ein Encode, mehrere Ziele.",
  feature1Body:
    "Casthop schickt das Composite gleichzeitig per RTMP an YouTube, LinkedIn und X. LiveKit Egress transkodiert einmal und verteilt an jede URL, und eine Aufnahme bleibt liegen.",
  feature1Link: "So funktionieren Ziele",
  feature2Title: "Gäste kommen über einen Link.",
  feature2Body:
    "Schick den Gastlink. Kein Konto, keine Installation. Sie warten hinter der Bühne, bis du sie dazuholst, und bis zu sechs Personen können gemeinsam auf der Bühne stehen. Hosting selbst braucht ein angemeldetes Konto.",
  feature2Link: "Gäste",
  feature3Title: "Hintergrundunschärfe, im Browser.",
  feature3Body:
    "Die Kameraunschärfe läuft auf dem Gerät mit MediaPipes Selfie Segmenter. Das Modell lädt nur, wenn Unschärfe an ist, und kommt von deinem eigenen Origin, nicht von einem CDN.",
  feature3Link: "Architektur",
  feature4Title: "Streams erholen sich von allein.",
  feature4Body:
    "Fällt Egress oder ein Stream aus, versucht das Studio es mit Backoff erneut. Jede Zielzeile zeigt ihren eigenen RTMP-Status, so siehst du, welches Ziel ausgefallen ist.",
  feature4Link: "Status pro Ziel",

  ossEyebrow: "Self-host",
  ossTitle: "Du betreibst die Media-Ebene.",
  ossP1:
    "LiveKit, Egress, Redis und ein RTMP-Edge laufen in Docker auf deinem Rechner oder Server. Die Control Plane ist ein Cloudflare Worker mit Durable Objects und D1. Stream-Keys bleiben im Durable Object und kommen nie zu Gästen zurück.",
  ossP2:
    "Der Server steht unter AGPL-3.0-only, gehostete Forks müssen ihre Änderungen offenlegen. Das ist ein funktionierender Prototyp: Kern beweisen, messen, dann polieren. Rechne mit Ecken und Kanten und lies die Messwerte im Repo, statt uns einfach zu glauben.",
  ossGithub: "Auf GitHub ansehen",
  ossDocs: "Self-Hosting-Doku",

  footerTagline: "Open-Source-Livestudio im Browser.",
  footerDocs: "Docs",
  footerGettingStarted: "Erste Schritte",
  footerSelfHosting: "Self-Hosting",
  footerConfiguration: "Konfiguration",
  footerArchitecture: "Architektur",
  footerProject: "Projekt",
  footerLicense: "Casthop steht unter AGPL-3.0-only.",

  docsChromeTitle: "Casthop-Dokumentation",
  docsChromeDescription: "Dokumentation zu Casthop.",
  docsTitleSuffix: "Casthop-Docs",
  docsNav: "Dokumentation",
  docsSections: "Bereiche",
  searchDocs: "Dokumentation durchsuchen",
  searchHint: "Esc zum Schließen · ↑ ↓ zum Navigieren · Enter zum Öffnen",
  searchEmpty: "Keine Treffer.",
  searchResults: "Ergebnisse",
  onThisPage: "Auf dieser Seite",
  previous: "Zurück",
  next: "Weiter",
  pagination: "Seitennavigation",
  continueTo: "Weiter mit „Erste Schritte“.",
};

export default de;
