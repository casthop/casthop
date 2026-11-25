import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { createStudio } from "../lib/api";

export function Home() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("Weekly product update");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const studio = await createStudio(title);
      navigate(`/studio/${studio.id}?host=${encodeURIComponent(studio.hostKey)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open a studio");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="home">
      <div className="home-inner">
        <header>
          <Logo dark />
        </header>
        <h1>Open a studio</h1>
        <p className="lede">Guests join from a link. No account. Up to six people on stage, live to several RTMP destinations.</p>
        <form onSubmit={onSubmit}>
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
      </div>
    </div>
  );
}
