import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Logo } from "../components/Logo";
import { getReplay, setReplayVisibility, type PublicReplay, type ReplayVisibility } from "../lib/api";

function formatLength(ms: number | null): string {
  if (ms == null || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m === 0) return `${rem}s`;
  return rem ? `${m} min ${rem}s` : `${m} min`;
}

export function Watch() {
  const { id = "" } = useParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [replay, setReplay] = useState<PublicReplay | null>(null);
  const [error, setError] = useState<"signin" | "private" | "missing" | "play" | "">("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReplay(null);
    setError("");
    getReplay(id)
      .then((row) => {
        if (!cancelled) setReplay(row);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "";
        if (msg === "sign in required") setError("signin");
        else if (msg === "replay is private") setError("private");
        else setError("missing");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    const video = videoRef.current;
    const url = replay?.playlistUrl;
    if (!video || !url) return;
    let stop = (): void => undefined;
    let cancelled = false;
    (async () => {
      if (video.canPlayType("application/vnd.apple.mpegurl") || video.canPlayType("application/x-mpegURL")) {
        video.src = url;
        return;
      }
      const { default: Hls } = await import("hls.js");
      if (cancelled || !Hls.isSupported()) {
        if (!cancelled) setError("play");
        return;
      }
      const hls = new Hls({
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      stop = () => {
        hls.destroy();
      };
    })().catch(() => {
      if (!cancelled) setError("play");
    });
    return () => {
      cancelled = true;
      stop();
      video.removeAttribute("src");
      video.load();
    };
  }, [replay?.playlistUrl]);

  async function onVisibility(visibility: ReplayVisibility) {
    if (!replay) return;
    try {
      const next = await setReplayVisibility(replay.studioId, replay.id, visibility);
      setReplay(next);
    } catch {
      setError("play");
    }
  }

  async function onCopy() {
    const href = `${window.location.origin}/watch/${id}`;
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="home watch">
      <div className="home-inner">
        <header>
          <Logo dark />
        </header>
        {error === "signin" ? (
          <>
            <h1>Sign in to watch</h1>
            <p className="lede">This replay is private. Sign in as the owner or a co-host.</p>
            <a className="btn primary" href="/">
              Sign in
            </a>
          </>
        ) : null}
        {error === "private" ? (
          <>
            <h1>Private replay</h1>
            <p className="lede">Only the owner and co-hosts can play this recording.</p>
          </>
        ) : null}
        {error === "missing" ? (
          <>
            <h1>Replay not found</h1>
            <p className="lede">That link is expired or the recording was removed.</p>
          </>
        ) : null}
        {!error && !replay ? <p className="lede">Loading…</p> : null}
        {replay ? (
          <div className="watch-stage">
            <p className="badge-soft">{replay.visibility === "public" ? "Public" : "Private"}</p>
            <h1>{replay.title}</h1>
            <video ref={videoRef} controls playsInline aria-label={replay.title} />
            <div className="watch-meta">
              {formatLength(replay.durationMs) ? <span>{formatLength(replay.durationMs)}</span> : null}
              {replay.viewerCanEdit ? (
                <>
                  <button
                    className="btn quiet"
                    type="button"
                    onClick={() => void onVisibility(replay.visibility === "public" ? "private" : "public")}
                  >
                    {replay.visibility === "public" ? "Make private" : "Make public"}
                  </button>
                  {replay.visibility === "public" ? (
                    <button className="btn quiet" type="button" onClick={() => void onCopy()}>
                      {copied ? "Copied" : "Copy link"}
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
            {error === "play" ? <p className="err">Could not play this recording.</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
