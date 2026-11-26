import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type MessageKey, type Messages } from "./en";
import { formatDateTime, formatNumber, translate } from "./format";
import { loadMessages } from "./load";
import {
  htmlLang,
  persistLocale,
  readOrDetectLocale,
  type Locale,
} from "./locales";

type I18nValue = {
  locale: Locale;
  messages: Messages;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  formatNumber: (value: number) => string;
  formatDateTime: (value: number | Date) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    typeof window === "undefined" ? "en" : readOrDetectLocale(),
  );
  const [messages, setMessages] = useState<Messages>(en);

  useEffect(() => {
    persistLocale(locale);
    document.documentElement.lang = htmlLang(locale);
    if (locale === "en") {
      setMessages(en);
      return;
    }
    let cancelled = false;
    void loadMessages(locale).then((next) => {
      if (!cancelled) setMessages(next);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    persistLocale(next);
    setLocaleState(next);
  }, []);

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(messages, key, locale, vars),
    [messages, locale],
  );

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      messages,
      setLocale,
      t,
      formatNumber: (value) => formatNumber(value, locale),
      formatDateTime: (value) => formatDateTime(value, locale),
    }),
    [locale, messages, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n requires I18nProvider");
  return ctx;
}
