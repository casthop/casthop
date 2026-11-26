import { useEffect, useRef, useState } from "react";
import { useI18n } from "./I18nProvider";
import { LOCALES, localeNativeName } from "./locales";

export function LanguageSwitcher({ tone = "light" }: { tone?: "light" | "dark" }) {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`lang-switch ${tone}`} ref={root}>
      <button
        type="button"
        data-testid="language-switcher"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("languageMenu")}
        onClick={() => setOpen((v) => !v)}
      >
        🌐 {localeNativeName(locale)}
      </button>
      {open ? (
        <ul role="listbox" aria-label={t("languageMenu")}>
          {LOCALES.map((id) => (
            <li key={id} role="option" aria-selected={id === locale}>
              <button
                type="button"
                data-testid={`language-option-${id}`}
                onClick={() => {
                  setLocale(id);
                  setOpen(false);
                }}
              >
                {localeNativeName(id)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
