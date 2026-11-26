import { en, type Messages } from "./en";
import type { Locale } from "./locales";

const loaders: Record<Exclude<Locale, "en">, () => Promise<{ default: Messages }>> = {
  "pt-BR": () => import("./locales/pt-BR"),
  es: () => import("./locales/es"),
  fr: () => import("./locales/fr"),
  de: () => import("./locales/de"),
  ja: () => import("./locales/ja"),
};

export async function loadMessages(locale: Locale): Promise<Messages> {
  if (locale === "en") return en;
  const mod = await loaders[locale]();
  return { ...en, ...mod.default };
}
