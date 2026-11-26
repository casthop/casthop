import { en, type MessageKey, type Messages } from "./en";
import { intlTag, type Locale } from "./locales";

export function interpolate(
  template: string,
  vars: Record<string, string | number> | undefined,
  locale: Locale,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!(name in vars)) return whole;
    const value = vars[name];
    if (typeof value === "number") return formatNumber(value, locale);
    return value;
  });
}

export function translate(
  messages: Messages,
  key: MessageKey,
  locale: Locale,
  vars?: Record<string, string | number>,
): string {
  return interpolate(messages[key] ?? en[key] ?? key, vars, locale);
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlTag(locale)).format(value);
}

export function formatDateTime(value: number | Date, locale: Locale): string {
  return new Intl.DateTimeFormat(intlTag(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}
