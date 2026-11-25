import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  ConnectionState,
  LocalParticipant,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
} from "livekit-client";
import { Aperture, Mic, MicOff, MonitorUp, UserPlus, Video, VideoOff } from "lucide-react";
import { Logo } from "../components/Logo";
import { VideoTile } from "../components/VideoTile";
import {
  getStudio,
  mintToken,
  sendChat,
  setDestinations,
  setLayout,
  setBanner,
  setLive,
  setStage,
  type PublicStudio,
} from "../lib/api";
import { loadBlurPref, saveBlurPref } from "../lib/blur-prefs";
import { startCameraBlur, type CameraBlurHandle } from "../lib/camera-blur";
import { mediaPipeline } from "../lib/effects";
import { hueFor, openUserMedia } from "../lib/media";
import { loadSession, saveSession } from "../lib/session";
import { HOST_IDENTITY } from "../../worker/security";
import type { LayoutId, ParticipantInfo, PublicDestination } from "../../worker/types";

function formatLive(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function LayoutIcon({ id }: { id: LayoutId }) {
  if (id === "solo") {
    return (
      <svg width="28" height="16" viewBox="0 0 28 16">
        <rect x="4" y="2" width="20" height="12" rx="2" fill="currentColor" />
      </svg>
    );
  }
  if (id === "screen") {
    return (
      <svg width="28" height="16" viewBox="0 0 28 16">
        <rect x="2" y="2" width="16" height="12" rx="2" fill="currentColor" />
        <rect x="20" y="2" width="6" height="5" rx="1" fill="currentColor" />
        <rect x="20" y="9" width="6" height="5" rx="1" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="28" height="16" viewBox="0 0 28 16">
      <rect x="2" y="2" width="11" height="12" rx="2" fill="currentColor" />
      <rect x="15" y="2" width="11" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

function DestBadge({ kind }: { kind: string }) {
  if (kind === "youtube") return <span className="badge yt">YT</span>;
  if (kind === "linkedin") return <span className="badge in">in</span>;
  if (kind === "x") return <span className="badge x">X</span>;
  return <span className="badge rtmp">RTMP</span>;
}

export function Studio() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const hostKey = params.get("host") ?? loadSession(id)?.hostKey;
  const isHost = Boolean(hostKey);
  const publishingRef = useRef(false);
  const studioLiveRef = useRef(true);

  const [studio, setStudio] = useState<PublicStudio | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [peers, setPeers] = useState<(RemoteParticipant | LocalParticipant)[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [blurOn, setBlurOn] = useState(false);
  const [blurBusy, setBlurBusy] = useState(false);
  const originalVideoRef = useRef<MediaStreamTrack | null>(null);
  const blurHandleRef = useRef<CameraBlurHandle | null>(null);
  const [error, setError] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const identityRef = useRef<string>("");
  const nameRef = useRef<string>(isHost ? "Host" : "Guest");

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const saved = loadSession(id);
    setBlurOn(loadBlurPref(saved?.cameraId ?? ""));
  }, [id]);

  useEffect(() => {
    const fromUrl = params.get("host");
    if (!fromUrl) return;
    const saved = loadSession(id);
    saveSession({
      studioId: id,
      identity: saved?.identity ?? "",
      name: saved?.name ?? "Host",
      role: "host",
      hostKey: fromUrl,
      guestSecret: saved?.guestSecret,
      cameraId: saved?.cameraId,
      micId: saved?.micId,
    });
    history.replaceState(null, "", location.pathname);
  }, [id, params]);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let timer = 0;
    let delay = 500;
    const apply = (next: PublicStudio) => setStudio((prev) => mergeStudio(prev, next));
    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/studios/${id}/ws`);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as { type: string; state?: PublicStudio };
        if (msg.type === "state" && msg.state) apply(msg.state);
      };
      ws.onopen = () => {
        delay = 500;
      };
      ws.onclose = () => {
        if (closed) return;
        void getStudio(id, hostKey ?? undefined).then(apply).catch(() => undefined);
        timer = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 8000);
      };
    };
    connect();
    getStudio(id, hostKey ?? undefined).then(apply).catch((err) => setError(err.message));
    return () => {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, [id, hostKey]);

  useEffect(() => {
    studioLiveRef.current = true;
    let cancelled = false;
    let current: Room | null = null;
    (async () => {
      const saved = loadSession(id);
      const name = saved?.name ?? (isHost ? "Host" : "Guest");
      nameRef.current = name;
      const minted = await mintToken(id, {
        name,
        role: isHost ? "host" : "guest",
        hostKey: hostKey ?? undefined,
        identity: saved?.guestSecret ? saved.identity : undefined,
        guestSecret: saved?.guestSecret,
      });
      if (cancelled) return;
      identityRef.current = minted.identity;
      saveSession({
        studioId: id,
        identity: minted.identity,
        name: minted.name,
        role: minted.role,
        hostKey: hostKey ?? undefined,
        guestSecret: minted.guestSecret ?? saved?.guestSecret,
        cameraId: saved?.cameraId,
        micId: saved?.micId,
      });
      const lk = new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: { resolution: VideoPresets.h720 },
        publishDefaults: {
          simulcast: true,
          videoCodec: "vp8",
          videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
          dtx: true,
        },
      });
      const bump = () => {
        setPeers([lk.localParticipant, ...Array.from(lk.remoteParticipants.values())]);
      };
      lk.on(RoomEvent.ParticipantConnected, bump);
      lk.on(RoomEvent.ParticipantDisconnected, bump);
      lk.on(RoomEvent.TrackSubscribed, bump);
      lk.on(RoomEvent.TrackUnsubscribed, bump);
      lk.on(RoomEvent.LocalTrackPublished, bump);
      lk.on(RoomEvent.LocalTrackUnpublished, bump);
      lk.on(RoomEvent.TrackMuted, bump);
      lk.on(RoomEvent.TrackUnmuted, bump);
      lk.on(RoomEvent.DataReceived, (payload, participant) => {
        try {
          if (participant?.identity !== HOST_IDENTITY) return;
          const msg = JSON.parse(new TextDecoder().decode(payload)) as { type?: string; on?: boolean };
          if (msg.type === "publish" && msg.on) void publishLocal(lk);
        } catch {
          /* ignore */
        }
      });
      await lk.connect(minted.url, minted.token);
      if (cancelled) {
        lk.disconnect();
        return;
      }
      current = lk;
      setRoom(lk);
      bump();
      if (minted.canPublish) await publishLocal(lk);
    })().catch((err) => setError(err instanceof Error ? err.message : "Could not connect"));
    return () => {
      cancelled = true;
      studioLiveRef.current = false;
      blurHandleRef.current?.stop();
      blurHandleRef.current = null;
      originalVideoRef.current?.stop();
      originalVideoRef.current = null;
      current?.disconnect();
    };
  }, [id, hostKey, isHost]);

  useEffect(() => {
    if (!room || !studio) return;
    const me = studio.participants.find((p) => p.identity === identityRef.current);
    if (me?.onStage && room.localParticipant.videoTrackPublications.size === 0) {
      void publishLocal(room);
    }
  }, [studio, room]);

  const stagePeople = useMemo(() => {
    const listed = studio?.participants.filter((p) => p.onStage) ?? [];
    if (listed.length) {
      return listed
        .map((info) => ({ info, participant: peers.find((p) => p.identity === info.identity) }))
        .slice(0, 6);
    }
    return peers.slice(0, 6).map((p) => ({
      info: { identity: p.identity, name: p.name || p.identity, role: "guest", onStage: true, joinedAt: 0 } satisfies ParticipantInfo,
      participant: p,
    }));
  }, [studio, peers]);

  const backstage = studio?.participants ?? [];

  function studioOpen(lk: Room): boolean {
    return studioLiveRef.current && lk.state !== ConnectionState.Disconnected;
  }

  async function publishLocal(lk: Room) {
    if (publishingRef.current) return;
    if (lk.localParticipant.getTrackPublication(Track.Source.Camera)?.track) return;
    publishingRef.current = true;
    try {
      const saved = loadSession(id);
      const raw = await openUserMedia({ cameraId: saved?.cameraId, micId: saved?.micId });
      if (!studioOpen(lk)) {
        raw.getTracks().forEach((t) => t.stop());
        return;
      }
      const processed = await mediaPipeline.process(raw);
      if (!studioOpen(lk)) {
        processed.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = processed.getVideoTracks()[0];
      if (video) {
        originalVideoRef.current = video;
        const settingsId = video.getSettings().deviceId ?? "";
        const wantBlur = loadBlurPref(saved?.cameraId ?? "", settingsId);
        setBlurOn(wantBlur);
        let publishVideo = video;
        if (wantBlur) {
          try {
            const handle = await startCameraBlur(video);
            if (!studioOpen(lk)) {
              handle.stop();
              return;
            }
            blurHandleRef.current?.stop();
            blurHandleRef.current = handle;
            publishVideo = handle.track;
          } catch (err) {
            console.warn("casthop blur", err);
          }
        }
        if (!studioOpen(lk)) return;
        await lk.localParticipant.publishTrack(publishVideo, {
          source: Track.Source.Camera,
          simulcast: true,
        });
      }
      const audio = processed.getAudioTracks()[0];
      if (audio && studioOpen(lk)) {
        await lk.localParticipant.publishTrack(audio, { source: Track.Source.Microphone });
      }
    } finally {
      publishingRef.current = false;
    }
  }

  async function toggleMic() {
    const next = !micOn;
    setMicOn(next);
    await room?.localParticipant.setMicrophoneEnabled(next);
  }

  async function toggleCam() {
    const next = !camOn;
    setCamOn(next);
    await room?.localParticipant.setCameraEnabled(next);
  }

  async function toggleBlur() {
    if (blurBusy) return;
    const next = !blurOn;
    const savedId = loadSession(id)?.cameraId ?? "";
    const deviceId = originalVideoRef.current?.getSettings().deviceId ?? savedId;
    saveBlurPref(deviceId, next);
    if (savedId && savedId !== deviceId) saveBlurPref(savedId, next);
    setBlurOn(next);
    const local = room?.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
    const original = originalVideoRef.current;
    if (!local || !original) return;
    setBlurBusy(true);
    let handle: CameraBlurHandle | undefined;
    try {
      if (next) {
        handle = await startCameraBlur(original);
        if (!studioLiveRef.current) {
          handle.stop();
          return;
        }
        await local.replaceTrack(handle.track, { userProvidedTrack: true });
        blurHandleRef.current?.stop();
        blurHandleRef.current = handle;
        handle = undefined;
      } else {
        await local.replaceTrack(original, { userProvidedTrack: true });
        blurHandleRef.current?.stop();
        blurHandleRef.current = null;
      }
    } catch (err) {
      handle?.stop();
      setError(err instanceof Error ? err.message : "Blur failed");
      setBlurOn(!next);
      saveBlurPref(deviceId, !next);
    } finally {
      setBlurBusy(false);
    }
  }

  async function shareScreen() {
    try {
      await room?.localParticipant.setScreenShareEnabled(true);
      if (hostKey) await setLayout(id, hostKey, "screen");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Screen share failed");
    }
  }

  async function onLayout(layout: LayoutId) {
    if (!hostKey) return;
    try {
      await setLayout(id, hostKey, layout);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Layout failed");
    }
  }

  async function onGoLive() {
    if (!hostKey) return;
    setError("");
    try {
      await setLive(id, hostKey, !studio?.live);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Live failed");
    }
  }

  async function onChat(e: FormEvent) {
    e.preventDefault();
    const text = chatDraft.trim();
    if (!text) return;
    setChatDraft("");
    try {
      const saved = loadSession(id);
      await sendChat(id, {
        text,
        identity: identityRef.current,
        guestSecret: saved?.guestSecret,
        hostKey: hostKey ?? undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat failed");
    }
  }

  async function copyInvite() {
    const url = `${location.origin}/join/${id}`;
    await navigator.clipboard.writeText(url);
    setInviteOpen(true);
  }

  async function promote(identity: string, on: boolean) {
    if (!hostKey) return;
    try {
      await setStage(id, hostKey, identity, on);
      const payload = new TextEncoder().encode(JSON.stringify({ type: "publish", on }));
      await room?.localParticipant.publishData(payload, { destinationIdentities: [identity] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stage update failed");
    }
  }

  if (!studio) {
    return (
      <div className="studio">
        <header className="topbar">
          <Logo />
          <div className="center">{error || "Opening studio…"}</div>
        </header>
      </div>
    );
  }

  const liveMs = studio.live && studio.liveStartedAt ? now - studio.liveStartedAt : 0;

  return (
    <div className="studio">
      <header className="topbar">
        <Logo />
        <div className="center">
          Studio · {studio.title}
        </div>
        <div className="right">
          <span className={`live-pill ${studio.live ? "on" : ""}`}>
            <span className="dot" />
            {studio.live ? `Live · ${formatLive(liveMs)}` : "Ready · not live"}
          </span>
          {isHost ? (
            <button className="settings" type="button" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
          ) : null}
        </div>
      </header>
      <div className="body">
        <div className="stage-col">
          <section className="preview" aria-label="Program preview">
            <div className="preview-label">PREVIEW</div>
            <div className={`program ${programClass(studio.layout, stagePeople.length)}`}>
              {studio.layout === "screen" ? (
                <>
                  <VideoTile
                    participant={stagePeople.find((p) => p.participant?.getTrackPublication(Track.Source.ScreenShare))?.participant}
                    label="Screen"
                  />
                  <div className="cams">
                    {stagePeople.slice(0, 3).map((p) => (
                      <VideoTile key={p.info.identity} participant={p.participant} label={p.info.name} local={p.participant instanceof LocalParticipant} />
                    ))}
                  </div>
                </>
              ) : (
                visibleStage(studio.layout, stagePeople).map((p) => (
                  <VideoTile
                    key={p.info.identity}
                    participant={p.participant}
                    label={p.info.name}
                    local={p.participant instanceof LocalParticipant}
                  />
                ))
              )}
              {stagePeople.length === 0 ? <VideoTile label="Empty stage" /> : null}
            </div>
            <div className="lower-third">
              {studio.bannerTitle}
              <span>· {studio.bannerSubtitle}</span>
            </div>
          </section>

          {isHost ? (
            <div className="layouts">
              <span>Layout</span>
              {(
                [
                  ["solo", "Solo"],
                  ["side", "Side by side"],
                  ["screen", "Screen + cams"],
                ] as const
              ).map(([key, label]) => (
                <div className="layout-wrap" key={key}>
                  <button
                    type="button"
                    className={`layout-btn ${studio.layout === key ? "active" : ""}`}
                    onClick={() => onLayout(key)}
                    aria-label={label}
                    aria-pressed={studio.layout === key}
                  >
                    <LayoutIcon id={key} />
                  </button>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="layouts">{studio.participants.find((p) => p.identity === identityRef.current)?.onStage ? "You are on stage" : "Backstage — waiting for the host"}</p>
          )}

          <section className="backstage">
            <h3>Backstage · {backstage.length}</h3>
            <div className="back-row">
              {backstage.map((p) => (
                <button
                  key={p.identity}
                  type="button"
                  className={`mini ${p.onStage ? "on" : ""}`}
                  style={{ background: `linear-gradient(160deg, hsl(${hueFor(p.identity)} 18% 38%), hsl(${hueFor(p.identity) + 40} 20% 20%))` }}
                  onClick={() => isHost && promote(p.identity, !p.onStage)}
                >
                  <span className="tag">
                    {p.name}
                    {p.onStage ? " · on stage" : ""}
                  </span>
                </button>
              ))}
              {isHost ? (
                <button type="button" className="invite-slot" onClick={copyInvite}>
                  + Invite guest
                </button>
              ) : null}
            </div>
          </section>

          <div className="controls">
            <button className={`ctrl ${micOn ? "" : "off"}`} type="button" onClick={toggleMic}>
              {micOn ? <Mic size={16} /> : <MicOff size={16} />} Mic
            </button>
            <button className={`ctrl ${camOn ? "" : "off"}`} type="button" onClick={toggleCam}>
              {camOn ? <Video size={16} /> : <VideoOff size={16} />} Camera
            </button>
            <button
              className={`ctrl ${blurOn ? "" : "off"}`}
              type="button"
              onClick={() => void toggleBlur()}
              aria-pressed={blurOn}
              disabled={blurBusy}
            >
              <Aperture size={16} /> Blur
            </button>
            <button className="ctrl" type="button" onClick={shareScreen}>
              <MonitorUp size={16} /> Share screen
            </button>
            {isHost ? (
              <button className="ctrl" type="button" onClick={copyInvite}>
                <UserPlus size={16} /> Invite guest
              </button>
            ) : null}
            {isHost ? (
              <button className={`go-live ${studio.live ? "end" : ""}`} type="button" onClick={onGoLive}>
                <span className="orb" />
                {studio.live ? "End live" : "Go Live"}
              </button>
            ) : null}
          </div>
          {error ? <p className="err">{error}</p> : null}
        </div>

        <aside className="side">
          <div className="side-head">
            <h3>Destinations</h3>
            {isHost ? (
              <button className="add" type="button" onClick={() => setSettingsOpen(true)}>
                + Add
              </button>
            ) : null}
          </div>
          <div>
            {studio.destinations.map((d) => (
              <div className="dest" key={d.id}>
                <DestBadge kind={d.kind} />
                <div className="meta">
                  <b>{d.label}</b>
                  <small>{d.detail}</small>
                </div>
                <button
                  type="button"
                  className={`toggle ${d.enabled ? "on" : ""}`}
                  disabled={!isHost}
                  aria-pressed={d.enabled}
                  aria-label={`${d.enabled ? "Disable" : "Enable"} ${d.label}`}
                  onClick={() => {
                    if (!hostKey) return;
                    const next = studio.destinations.map((x) => (x.id === d.id ? { ...x, enabled: !x.enabled } : x));
                    void setDestinations(id, hostKey, next).then(setStudio).catch((err) => setError(err.message));
                  }}
                >
                  <i />
                </button>
              </div>
            ))}
          </div>
          <div className="chat">
            <div className="side-head">
              <h3>Live chat</h3>
              <small style={{ color: "var(--faint)" }}>Studio + destinations</small>
            </div>
            {studio.chat.length === 0 ? (
              <p>
                <span className="src">YT</span>
                <span className="who">Viewer A</span>
                Destination comments land here once webhooks are wired. Studio chat works now.
              </p>
            ) : null}
            {studio.chat.map((m) => (
              <p key={m.id}>
                <span className="src">{m.source === "studio" ? "IN" : m.source.slice(0, 2).toUpperCase()}</span>
                <span className="who">{m.name}</span>
                {m.text}
              </p>
            ))}
          </div>
          <form onSubmit={onChat}>
            <input
              className="reply"
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              placeholder="Reply to all destinations…"
            />
          </form>
        </aside>
      </div>

      {settingsOpen && hostKey ? (
        <SettingsPanel
          studio={studio}
          onClose={() => setSettingsOpen(false)}
          onSave={async (next) => {
            try {
              const saved = await setDestinations(id, hostKey, next.destinations);
              await setBanner(id, hostKey, {
                title: next.title,
                bannerTitle: next.bannerTitle,
                bannerSubtitle: next.bannerSubtitle,
              });
              setStudio(saved);
              setSettingsOpen(false);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Save failed");
            }
          }}
        />
      ) : null}

      {inviteOpen ? (
        <div className="panel" onClick={() => setInviteOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Invite guest</h2>
            <p>No account needed. Share this link:</p>
            <input readOnly value={`${location.origin}/join/${id}`} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn primary" type="button" onClick={() => setInviteOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SettingsPanel({
  studio,
  onClose,
  onSave,
}: {
  studio: PublicStudio;
  onClose: () => void;
  onSave: (next: { title: string; bannerTitle: string; bannerSubtitle: string; destinations: PublicDestination[] }) => void;
}) {
  const [title, setTitle] = useState(studio.title);
  const [bannerTitle, setBannerTitle] = useState(studio.bannerTitle);
  const [bannerSubtitle, setBannerSubtitle] = useState(studio.bannerSubtitle);
  const [destinations, setDest] = useState(studio.destinations);

  return (
    <div className="panel" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <label>
          Studio title
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Lower third
          <input value={bannerTitle} onChange={(e) => setBannerTitle(e.target.value)} />
        </label>
        <label>
          Lower third detail
          <input value={bannerSubtitle} onChange={(e) => setBannerSubtitle(e.target.value)} />
        </label>
        {destinations.map((d, i) => (
          <label key={d.id}>
            {d.label} RTMP URL
            <input
              value={d.url ?? ""}
              onChange={(e) => {
                const next = destinations.slice();
                next[i] = { ...d, url: e.target.value };
                setDest(next);
              }}
            />
          </label>
        ))}
        <button
          className="btn primary"
          type="button"
          onClick={() => onSave({ title, bannerTitle, bannerSubtitle, destinations })}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function programClass(layout: LayoutId, n: number): string {
  if (layout === "solo") return "solo";
  if (layout === "screen") return "screen";
  if (n <= 2) return "side";
  if (n <= 4) return "grid4";
  return "grid6";
}

function visibleStage<T>(layout: LayoutId, people: T[]): T[] {
  if (layout === "solo") return people.slice(0, 1);
  return people.slice(0, 6);
}

function mergeStudio(prev: PublicStudio | null, next: PublicStudio): PublicStudio {
  if (!prev) return next;
  return {
    ...next,
    destinations: next.destinations.map((d) => {
      const old = prev.destinations.find((x) => x.id === d.id);
      return { ...d, url: d.url || old?.url };
    }),
  };
}
