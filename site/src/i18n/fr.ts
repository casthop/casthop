import type { SiteMessages } from "./en";

const fr: SiteMessages = {
  skip: "Aller au contenu",
  brandHome: "Accueil Casthop",
  navMain: "Principal",
  navDocs: "Docs",
  navGithub: "GitHub",
  navGetStarted: "Commencer",
  language: "Langue",

  metaTitle: "Casthop — studio live open source dans le navigateur",
  metaDescription:
    "Studio live open source dans le navigateur. Les invités arrivent par un lien, jusqu’à six sur scène, et le composite part en direct vers plusieurs destinations RTMP, avec enregistrement.",

  heroEyebrow: "Open source · AGPL-3.0",
  heroTitle: "Passez en direct depuis un onglet, partout à la fois.",
  heroLede:
    "Casthop est un studio live que vous hébergez vous-même. Faites entrer des invités par un lien, mettez jusqu’à six personnes sur scène, et envoyez un seul composite vers YouTube, LinkedIn et X.",
  heroRepo: "Ouvrir le dépôt",
  heroDocs: "Lire la documentation",
  heroAlt:
    "Le studio hôte Casthop : une cabine sombre, une scène à deux, un invité en coulisses et le bouton blanc Passer en direct.",

  featuresTitle: "Ce qui marche aujourd’hui",
  feature1Title: "Un seul encodage, plusieurs destinations.",
  feature1Body:
    "Casthop envoie le composite vers YouTube, LinkedIn et X en RTMP en même temps. LiveKit Egress transcode une fois et réplique vers chaque URL, et un enregistrement est conservé.",
  feature1Link: "Comment fonctionnent les destinations",
  feature2Title: "Les invités arrivent par un lien.",
  feature2Body:
    "Envoyez le lien. Pas de compte, rien à installer. Ils attendent en coulisses jusqu’à ce que vous les ajoutiez à la scène, jusqu’à six en même temps. Animer le studio demande un compte connecté.",
  feature2Link: "Invités",
  feature3Title: "Flou d’arrière-plan, dans le navigateur.",
  feature3Body:
    "Le flou caméra tourne sur l’appareil avec le Selfie Segmenter de MediaPipe. Le modèle ne se charge que lorsque le flou est activé, depuis votre origine, pas un CDN.",
  feature3Link: "Architecture",
  feature4Title: "Les flux se rétablissent tout seuls.",
  feature4Body:
    "Si Egress ou un flux tombe, le studio réessaie avec backoff. Chaque destination affiche son propre statut RTMP, vous voyez laquelle est en panne.",
  feature4Link: "Statut par destination",

  ossEyebrow: "Self-host",
  ossTitle: "Vous gérez le plan média.",
  ossP1:
    "LiveKit, Egress, Redis et un relais RTMP tournent dans Docker sur votre machine ou serveur. Le plan de contrôle est un Cloudflare Worker avec Durable Objects et D1. Les clés de stream restent dans le Durable Object et ne reviennent jamais aux invités.",
  ossP2:
    "Le serveur est AGPL-3.0-only : les forks hébergés doivent publier leurs changements. C’est un prototype qui marche : prouvez le noyau, mesurez, puis peaufinez. Attendez-vous à des aspérités, et lisez les mesures du dépôt plutôt que de nous croire sur parole.",
  ossGithub: "Voir sur GitHub",
  ossDocs: "Documentation self-hosting",

  footerTagline: "Studio live open source dans le navigateur.",
  footerDocs: "Documentation",
  footerGettingStarted: "Premiers pas",
  footerSelfHosting: "Self-hosting",
  footerConfiguration: "Configuration",
  footerArchitecture: "Architecture",
  footerProject: "Projet",
  footerLicense: "Casthop est sous licence AGPL-3.0-only.",

  docsChromeTitle: "Documentation Casthop",
  docsChromeDescription: "Documentation de Casthop.",
  docsTitleSuffix: "Documentation Casthop",
  docsNav: "Documentation",
  docsSections: "Sections",
  searchDocs: "Rechercher dans la doc",
  searchHint: "Échap pour fermer · ↑ ↓ pour se déplacer · Entrée pour ouvrir",
  searchEmpty: "Aucun résultat.",
  searchResults: "Résultats",
  onThisPage: "Sur cette page",
  previous: "Précédent",
  next: "Suivant",
  pagination: "Pagination",
  continueTo: "Continuer vers Premiers pas.",
};

export default fr;
