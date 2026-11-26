export const LOCALES = ["en", "pt-BR", "es", "fr", "de", "ja"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const SITE_URL = "https://casthop.com";

export const STORAGE_KEY = "casthop.locale";

const NATIVE_NAME: Record<Locale, string> = {
  en: "English",
  "pt-BR": "Português",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  ja: "日本語",
};

const SHORT_CODE: Record<Locale, string> = {
  en: "EN",
  "pt-BR": "PT",
  es: "ES",
  fr: "FR",
  de: "DE",
  ja: "JA",
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function localeNativeName(locale: Locale): string {
  return NATIVE_NAME[locale];
}

export function localeShortCode(locale: Locale): string {
  return SHORT_CODE[locale];
}

export function htmlLang(locale: Locale): string {
  return locale;
}

export function matchLocale(tag: string): Locale | null {
  const lower = tag.toLowerCase().replaceAll("_", "-");
  if (lower === "pt-br" || lower.startsWith("pt-br-") || lower === "pt" || lower.startsWith("pt-")) return "pt-BR";
  if (lower === "es" || lower.startsWith("es-")) return "es";
  if (lower === "fr" || lower.startsWith("fr-")) return "fr";
  if (lower === "de" || lower.startsWith("de-")) return "de";
  if (lower === "ja" || lower.startsWith("ja-")) return "ja";
  if (lower === "en" || lower.startsWith("en-")) return "en";
  return null;
}

export function withLocale(locale: Locale, path: string): string {
  const trimmed = path.trim() || "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (locale === "en") return withSlash;
  if (withSlash === "/") return `/${locale}/`;
  return `/${locale}${withSlash}`;
}

export function stripLocale(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] && isLocale(parts[0]) && parts[0] !== "en") {
    const rest = parts.slice(1).join("/");
    return rest ? `/${rest}` : "/";
  }
  return pathname || "/";
}

export function absoluteUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${SITE_URL}${p}`;
}

export function otherLocales(): Locale[] {
  return LOCALES.filter((l) => l !== "en");
}
