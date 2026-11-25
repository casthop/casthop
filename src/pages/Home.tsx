import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Logo";
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
  const [me, setMe] = useState<AccountMe | null | undefined>(undefined);
  const [github, setGithub] = useState(false);
  const [studios, setStudios] = useState<StudioRecord[]>([]);
  const [title, setTitle] = useState("Weekly product update");
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(params.get("auth") === "invalid" ? "That sign-in link is invalid or expired." : "");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await getConfig().catch(() => ({ github: false, signedIn: false, livekitUrl: "", maxOnStage: 6 }));
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
      setError(err instanceof Error ? err.message : "Could not send a link");
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const studio = await createStudio(title);
      navigate(`/studio/${studio.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open a studio");
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
          {me ? (
            <div className="home-account">
              <span>{me.email || me.name}</span>
              <button className="btn quiet" type="button" onClick={() => void onLogout()}>
                Sign out
              </button>
            </div>
          ) : null}
        </header>

        {me === undefined ? <p className="lede">Loading…</p> : null}

        {me === null ? (
          <>
            <h1>Sign in</h1>
            <p className="lede">Email a link. No password. Guests still join a studio from an invite, without an account.</p>
            {sentTo ? (
              <p className="sent-note">
                Link sent to {sentTo}. On this machine the Worker also prints the URL in the console.
              </p>
            ) : (
              <form onSubmit={onSignIn}>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-label="Email"
                  placeholder="you@example.com"
                  required
                />
                <button className="btn primary" type="submit" disabled={busy}>
                  {busy ? "Sending…" : "Email me a link"}
                </button>
                {github ? (
                  <a className="btn" href="/api/auth/github">
                    Continue with GitHub
                  </a>
                ) : null}
                {error ? <p className="err">{error}</p> : null}
              </form>
            )}
          </>
        ) : null}

        {me ? (
          <>
            <h1>Open a studio</h1>
            <p className="lede">Guests join from a link. No account. Up to six people on stage, live to several RTMP destinations.</p>
            <form onSubmit={onCreate}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Studio title"
                maxLength={80}
              />
              <button className="btn primary" type="submit" disabled={busy}>
                {busy ? "Opening…" : "Open studio"}
              </button>
              {error ? <p className="err">{error}</p> : null}
            </form>
            {studios.length ? (
              <section className="studio-list">
                <h2>Your studios</h2>
                {studios.map((s) => (
                  <a className="studio-row" key={s.id} href={`/studio/${s.id}`}>
                    <b>{s.title}</b>
                    <span>{s.role === "owner" ? "Owner" : "Co-host"}</span>
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
