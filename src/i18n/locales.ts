export const LOCALES = ["en", "pt-BR", "es", "fr", "de", "ja"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const STORAGE_KEY = "casthop.locale";

const NATIVE_NAME: Record<Locale, string> = {
  en: "English",
  "pt-BR": "Português",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  ja: "日本語",
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function localeNativeName(locale: Locale): string {
  return NATIVE_NAME[locale];
}

export function htmlLang(locale: Locale): string {
  return locale;
}

export function intlTag(locale: Locale): string {
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

export function persistLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* private mode */
  }
}

export function readSavedLocale(): Locale | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && isLocale(saved)) return saved;
  } catch {
    /* private mode */
  }
  return null;
}

export function detectBrowserLocale(languages: readonly string[] = []): Locale {
  for (const tag of languages) {
    const matched = matchLocale(tag);
    if (matched) return matched;
  }
  return DEFAULT_LOCALE;
}

export function readOrDetectLocale(): Locale {
  const saved = readSavedLocale();
  if (saved) return saved;
  const languages =
    typeof navigator === "undefined" ? [] : navigator.languages.length ? navigator.languages : [navigator.language];
  return detectBrowserLocale(languages);
}
