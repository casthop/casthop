import type { SiteMessages } from "./en";

const es: SiteMessages = {
  skip: "Saltar al contenido",
  brandHome: "Inicio de Casthop",
  navMain: "Principal",
  navDocs: "Docs",
  navGithub: "GitHub",
  navGetStarted: "Empezar",
  language: "Idioma",

  metaTitle: "Casthop — estudio en vivo de código abierto en el navegador",
  metaDescription:
    "Estudio en vivo de código abierto en el navegador. Los invitados entran con un enlace, hasta seis en escena, y la composición se transmite en vivo a varios destinos RTMP, con grabación.",

  heroEyebrow: "Código abierto · AGPL-3.0",
  heroTitle: "Transmite en vivo desde una pestaña, a todas partes a la vez.",
  heroLede:
    "Casthop es un estudio en vivo que operas tú. Trae invitados con un enlace, agrega hasta seis a escena y envía una sola composición a YouTube, LinkedIn y X.",
  heroRepo: "Abrir el repositorio",
  heroDocs: "Leer la documentación",
  heroAlt:
    "El estudio del anfitrión en Casthop: una cabina oscura con escenario para dos, un invitado entre bastidores y el botón blanco Transmitir en vivo.",

  featuresTitle: "Qué hace hoy",
  feature1Title: "Una transcodificación, varios destinos.",
  feature1Body:
    "Casthop envía la composición a YouTube, LinkedIn y X por RTMP a la vez. LiveKit Egress transcodifica una vez y reparte a cada URL, y guarda una grabación.",
  feature1Link: "Cómo funcionan los destinos",
  feature2Title: "Los invitados entran con un enlace.",
  feature2Body:
    "Envía el enlace. Sin cuenta ni instalación. Esperan entre bastidores hasta que los agregues a escena, y hasta seis personas pueden estar en escena. Para presentar hace falta una cuenta.",
  feature2Link: "Invitados",
  feature3Title: "Desenfoque de fondo, en el navegador.",
  feature3Body:
    "El desenfoque de la cámara corre en el dispositivo con el Selfie Segmenter de MediaPipe. El modelo solo se carga cuando el desenfoque está activo, y se sirve desde tu origen, no desde un CDN.",
  feature3Link: "Arquitectura",
  feature4Title: "Las transmisiones se recuperan solas.",
  feature4Body:
    "Si cae Egress o un flujo, el estudio reintenta con backoff. Cada destino muestra su propio estado RTMP, así ves cuál está caído.",
  feature4Link: "Estado por destino",

  ossEyebrow: "Self-host",
  ossTitle: "Tú operas el plano de medios.",
  ossP1:
    "LiveKit, Egress, Redis y un borde RTMP corren en Docker en tu máquina o servidor. El plano de control es un Cloudflare Worker con Durable Objects y D1. Las claves de stream quedan en el Durable Object y nunca vuelven a los invitados.",
  ossP2:
    "El servidor es AGPL-3.0-only, así que los forks hospedados deben abrir sus cambios. Es un prototipo que funciona: demuestra el núcleo, mídelo y luego pule. Habrá asperezas; lee las mediciones del repo en vez de creernos.",
  ossGithub: "Ver en GitHub",
  ossDocs: "Documentación de self-hosting",

  footerTagline: "Estudio en vivo de código abierto en el navegador.",
  footerDocs: "Documentación",
  footerGettingStarted: "Primeros pasos",
  footerSelfHosting: "Self-hosting",
  footerConfiguration: "Configuración",
  footerArchitecture: "Arquitectura",
  footerProject: "Proyecto",
  footerLicense: "Casthop está licenciado bajo AGPL-3.0-only.",

  docsChromeTitle: "Documentación de Casthop",
  docsChromeDescription: "Documentación de Casthop.",
  docsTitleSuffix: "Documentación Casthop",
  docsNav: "Documentación",
  docsSections: "Secciones",
  searchDocs: "Buscar en la documentación",
  searchHint: "Esc cierra · ↑ ↓ mueve · Enter abre",
  searchEmpty: "Sin resultados.",
  searchResults: "Resultados",
  onThisPage: "En esta página",
  previous: "Anterior",
  next: "Siguiente",
  pagination: "Paginación",
  continueTo: "Seguir en Primeros pasos.",
};

export default es;
