import { en, type SiteMessageKey, type SiteMessages } from "./en";
import de from "./de";
import es from "./es";
import fr from "./fr";
import ja from "./ja";
import ptBR from "./pt-BR";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales";

const catalogs: Record<Locale, SiteMessages> = {
  en,
  "pt-BR": ptBR,
  es,
  fr,
  de,
  ja,
};

export function messagesFor(locale: string): SiteMessages {
  if (isLocale(locale)) return catalogs[locale];
  return catalogs[DEFAULT_LOCALE];
}

export function t(
  locale: string,
  key: SiteMessageKey,
  vars?: Record<string, string | number>,
): string {
  const catalog = messagesFor(locale);
  const template = catalog[key] ?? en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!(name in vars)) return whole;
    const value = vars[name];
    if (typeof value === "number") {
      const tag = isLocale(locale) ? locale : "en";
      return new Intl.NumberFormat(tag).format(value);
    }
    return value;
  });
}

export const siteCatalogs = catalogs;

export {
  DEFAULT_LOCALE,
  LOCALES,
  SITE_URL,
  STORAGE_KEY,
  absoluteUrl,
  htmlLang,
  isLocale,
  localeNativeName,
  localeShortCode,
  matchLocale,
  otherLocales,
  stripLocale,
  withLocale,
  type Locale,
} from "./locales";
export { en, type SiteMessageKey, type SiteMessages } from "./en";
