import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Logo";
import { LanguageSwitcher, useI18n } from "../i18n";
import {
  createStudio,
  getConfig,
  getMe,
  listStudios,
  logout,
  requestMagicLink,
  type AccountMe,
  type StudioRecord,
} from "../lib/api";

export function Home() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { t } = useI18n();
  const [me, setMe] = useState<AccountMe | null | undefined>(undefined);
  const [github, setGithub] = useState(false);
  const [studios, setStudios] = useState<StudioRecord[]>([]);
  const [title, setTitle] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const titleValue = title ?? t("homeDefaultTitle");

  useEffect(() => {
    if (params.get("auth") === "invalid") setError(t("homeInvalidLink"));
  }, [params, t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await getConfig().catch(() => ({
        github: false,
        signedIn: false,
        livekitUrl: "",
        maxOnStage: 6,
        destinationChat: { youtube: false },
      }));
      if (cancelled) return;
      setGithub(cfg.github);
      if (!cfg.signedIn) {
        setMe(null);
        return;
      }
      try {
        const account = await getMe();
        const listed = await listStudios();
        if (cancelled) return;
        setMe(account);
        setStudios(listed.studios);
      } catch {
        if (!cancelled) setMe(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSignIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await requestMagicLink(email);
      setSentTo(email.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("homeSendFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const studio = await createStudio(titleValue);
      navigate(`/studio/${studio.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("homeOpenFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function onLogout() {
    await logout().catch(() => undefined);
    setMe(null);
    setStudios([]);
  }

  return (
    <div className="home">
      <div className="home-inner">
        <header>
          <Logo dark />
          <div className="home-tools">
            {me ? (
              <div className="home-account">
                <span>{me.email || me.name}</span>
                <button className="btn quiet" type="button" onClick={() => void onLogout()}>
                  {t("homeSignOut")}
                </button>
              </div>
            ) : null}
            <LanguageSwitcher tone="light" />
          </div>
        </header>

        {me === undefined ? <p className="lede">{t("loading")}</p> : null}

        {me === null ? (
          <>
            <h1>{t("homeSignIn")}</h1>
            <p className="lede">{t("homeSignInLede")}</p>
            {sentTo ? (
              <p className="sent-note">{t("homeLinkSent", { email: sentTo })}</p>
            ) : (
              <form onSubmit={onSignIn}>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-label={t("homeEmail")}
                  placeholder={t("homeEmailPlaceholder")}
                  required
                />
                <button className="btn primary" type="submit" disabled={busy}>
                  {busy ? t("homeSending") : t("homeEmailMe")}
                </button>
                {github ? (
                  <a className="btn" href="/api/auth/github">
                    {t("homeGitHub")}
                  </a>
                ) : null}
                {error ? <p className="err">{error}</p> : null}
              </form>
            )}
          </>
        ) : null}

        {me ? (
          <>
            <h1>{t("homeOpenStudio")}</h1>
            <p className="lede">{t("homeOpenLede")}</p>
            <form onSubmit={onCreate}>
              <input
                value={titleValue}
                onChange={(e) => setTitle(e.target.value)}
                aria-label={t("homeStudioTitle")}
                maxLength={80}
              />
              <button className="btn primary" type="submit" disabled={busy}>
                {busy ? t("homeOpening") : t("homeOpen")}
              </button>
              {error ? <p className="err">{error}</p> : null}
            </form>
            {studios.length ? (
              <section className="studio-list">
                <h2>{t("homeYourStudios")}</h2>
                {studios.map((s) => (
                  <a className="studio-row" key={s.id} href={`/studio/${s.id}`}>
                    <b>{s.title}</b>
                    <span>{s.role === "owner" ? t("roleOwner") : t("roleCohost")}</span>
                  </a>
                ))}
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
