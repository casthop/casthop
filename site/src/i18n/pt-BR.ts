import type { SiteMessages } from "./en";

const ptBR: SiteMessages = {
  skip: "Pular para o conteúdo",
  brandHome: "Página inicial do Casthop",
  navMain: "Principal",
  navDocs: "Docs",
  navGithub: "GitHub",
  navGetStarted: "Começar",
  navMenu: "Menu",
  language: "Idioma",

  metaTitle: "Casthop — estúdio ao vivo open source no navegador",
  metaDescription:
    "Estúdio ao vivo open source no navegador. Convidados entram por um link, até seis no palco, e o vídeo final vai ao ar em vários destinos RTMP, com gravação.",

  heroEyebrow: "Open source · AGPL-3.0",
  heroTitle: "Vá ao vivo pelo navegador, em todos os destinos de uma vez.",
  heroLede:
    "Casthop é um estúdio ao vivo que você mesmo opera. Chame convidados por um link, coloque até seis no palco e envie um único vídeo final para YouTube, LinkedIn e X.",
  heroRepo: "Abrir o repositório",
  heroDocs: "Ler a documentação",
  heroAlt:
    "O estúdio do apresentador no Casthop: uma cabine escura com palco para duas pessoas, um convidado nos bastidores e o botão branco Ir ao vivo.",

  featuresTitle: "O que já funciona",
  feature1Title: "Uma transcodificação, vários destinos.",
  feature1Body:
    "O Casthop manda o vídeo final para YouTube, LinkedIn e X via RTMP ao mesmo tempo. O LiveKit Egress transcodifica uma vez e replica para cada URL, e a gravação fica junto.",
  feature1Link: "Como funcionam os destinos",
  feature2Title: "Convidados entram por um link.",
  feature2Body:
    "Envie o link. Sem conta, sem instalar. Eles esperam nos bastidores até você chamar, e até seis pessoas podem estar no palco. Para apresentar, é preciso estar logado.",
  feature2Link: "Convidados",
  feature3Title: "Desfoque de fundo, no próprio navegador.",
  feature3Body:
    "O desfoque da câmera roda no dispositivo com o Selfie Segmenter do MediaPipe. O modelo só carrega quando o desfoque está ligado, e vem da sua origem — não de um CDN.",
  feature3Link: "Arquitetura",
  feature4Title: "As transmissões se recuperam sozinhas.",
  feature4Body:
    "Se o Egress ou um fluxo cair, o estúdio tenta de novo com backoff. Cada destino mostra o próprio status RTMP, então você vê qual está fora.",
  feature4Link: "Status por destino",

  ossEyebrow: "Self-host",
  ossTitle: "Você opera o plano de mídia.",
  ossP1:
    "LiveKit, Egress, Redis e uma borda RTMP sobem no Docker, na sua máquina ou no servidor. O plano de controle é um Cloudflare Worker com Durable Objects e D1. As chaves de stream ficam no Durable Object e nunca voltam para convidados.",
  ossP2:
    "O servidor é AGPL-3.0-only, então forks hospedados precisam abrir as mudanças. É um protótipo que funciona: provar o núcleo, medir, depois polir. Espere arestas, e leia as medições no repositório em vez de confiar na nossa palavra.",
  ossGithub: "Ver no GitHub",
  ossDocs: "Documentação de self-hosting",

  footerTagline: "Estúdio ao vivo open source no navegador.",
  footerDocs: "Docs",
  footerGettingStarted: "Primeiros passos",
  footerSelfHosting: "Self-hosting",
  footerConfiguration: "Configuração",
  footerArchitecture: "Arquitetura",
  footerProject: "Projeto",
  footerLicense: "O Casthop é licenciado sob AGPL-3.0-only.",

  docsChromeTitle: "Docs do Casthop",
  docsChromeDescription: "Documentação do Casthop.",
  docsTitleSuffix: "Docs do Casthop",
  docsNav: "Documentação",
  docsSections: "Seções",
  searchDocs: "Buscar na documentação",
  searchHint: "Esc fecha · ↑ ↓ navega · Enter abre",
  searchEmpty: "Nenhum resultado.",
  searchResults: "Resultados",
  onThisPage: "Nesta página",
  previous: "Anterior",
  next: "Próximo",
  pagination: "Paginação",
  continueTo: "Continuar em Primeiros passos.",
};

export default ptBR;
