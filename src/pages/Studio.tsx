import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ConnectionState,
  LocalParticipant,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
} from "livekit-client";
import { Link, Mic, MicOff, MonitorUp, Video, VideoOff, X } from "lucide-react";
import { VideoTile } from "../components/VideoTile";
import { LanguageSwitcher, useI18n, type MessageKey } from "../i18n";
import {
  createClip,
  getConfig,
  acceptCohostInvite,
  getStudio,
  inviteCohost,
  listCohosts,
  mintToken,
  pinChat,
  sendChat,
  setDestinations,
  setLayout,
  setBanner,
  setLive,
  setSeparateRecordings,
  setStage,
  isoDownloadPath,
  listRecordings,
  type PublicStudio,
  type RecordingList,
  type StudioMember,
  type StudioView,
} from "../lib/api";
import { loadClipSeconds, saveClipSeconds, type ClipSeconds } from "../lib/clip-seconds";
import { loadBlurPref, saveBlurPrefPair } from "../lib/blur-prefs";
import { startCameraBlur, type CameraBlurHandle } from "../lib/camera-blur";
import { loadDenoisePref, saveDenoisePrefPair } from "../lib/denoise-prefs";
import { processWithPipeline, type PipelineHandle } from "../lib/effects";
import { fxBackendForDenoise } from "../lib/fx";
import { openUserMedia } from "../lib/media";
import { loadSession, saveSession } from "../lib/session";
import { canConnectToStudio } from "../lib/studio-entry";
import { SHOT_LIVE_MS, shotFromUrl, shotStudio } from "../lib/studio-shot";
import { IsoRecorder } from "../lib/iso-recorder";
import { isHostIdentity } from "../../worker/security";
import { destAspectOf, type DestAspect, type IsoTrack, type LayoutId, type ParticipantInfo, type PublicDestination } from "../../worker/types";
import { outputPhase } from "../../worker/egress";

type PanelId = "chat" | "destinations" | "lower-third" | "settings" | "recordings";
type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

function destStatusLabel(
  t: Translate,
  status: PublicStudio["destinations"][number]["status"] | undefined,
  error: string | null | undefined,
): string {
  if (status === "connecting") return t("destStarting");
  if (status === "live") return t("destLive");
  if (status === "retrying") return error ? t("destReconnectingError", { error }) : t("destReconnecting");
  if (status === "failed") return error ? t("destFailedError", { error }) : t("destFailed");
  if (status === "stopped") return t("destStopped");
  return "";
}

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
      <svg viewBox="0 0 28 16" aria-hidden="true">
        <rect x="5" y="1.5" width="18" height="13" rx="2" fill="currentColor" />
      </svg>
    );
  }
  if (id === "screen") {
    return (
      <svg viewBox="0 0 28 16" aria-hidden="true">
        <rect x="2" y="1.5" width="16" height="13" rx="2" fill="currentColor" />
        <rect x="20" y="1.5" width="6" height="6" rx="1" fill="currentColor" />
        <rect x="20" y="8.5" width="6" height="6" rx="1" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 28 16" aria-hidden="true">
      <rect x="2" y="1.5" width="11" height="13" rx="2" fill="currentColor" />
      <rect x="15" y="1.5" width="11" height="13" rx="2" fill="currentColor" />
    </svg>
  );
}

function destGlyph(kind: string): string {
  if (kind === "youtube") return "YT";
  if (kind === "linkedin") return "in";
  if (kind === "x") return "X";
  return "RTMP";
}

function pinWho(pin: { name: string; source: string }): string {
  if (pin.source === "youtube") return `${pin.name} · YouTube`;
  if (pin.source === "twitch") return `${pin.name} · Twitch`;
  if (pin.source === "kick") return `${pin.name} · Kick`;
  if (pin.source === "linkedin") return `${pin.name} · LinkedIn`;
  if (pin.source === "x") return `${pin.name} · X`;
  return pin.name;
}

function tileTone(index: number): "cam1" | "cam2" | "cam3" {
  if (index % 3 === 1) return "cam2";
  if (index % 3 === 2) return "cam3";
  return "cam1";
}

function emptyCustom(destinations: PublicDestination[]): PublicDestination | undefined {
  return destinations.find((d) => d.kind === "custom" && !d.url);
}

function newCustomDest(url: string, existing: PublicDestination[], t: Translate): PublicDestination {
  const n = existing.filter((d) => d.kind === "custom").length + 1;
  return {
    id: `custom-${n}`,
    kind: "custom",
    label: n > 1 ? t("destRtmpN", { n }) : t("destCustomRtmp"),
    detail: t("destCustom"),
    enabled: true,
    hasKey: Boolean(url),
    urlMasked: "",
    url,
    status: "idle",
    error: null,
    aspect: "landscape",
  };
}

function AspectToggle({
  label,
  value,
  disabled,
  onChange,
  t,
}: {
  label: string;
  value: DestAspect;
  disabled?: boolean;
  onChange: (next: DestAspect) => void;
  t: Translate;
}) {
  const aspect = destAspectOf({ aspect: value });
  return (
    <div className="aspect" role="group" aria-label={`${label} ${t("destAspect")}`}>
      <button
        type="button"
        className={aspect === "landscape" ? "on" : undefined}
        aria-pressed={aspect === "landscape"}
        aria-label={`${label} ${t("destAspectLandscape")}`}
        disabled={disabled}
        onClick={() => onChange("landscape")}
      >
        16:9
      </button>
      <button
        type="button"
        className={aspect === "portrait" ? "on" : undefined}
        aria-pressed={aspect === "portrait"}
        aria-label={`${label} ${t("destAspectPortrait")}`}
        disabled={disabled}
        onClick={() => onChange("portrait")}
      >
        9:16
      </button>
    </div>
  );
}

function outputStatusLabel(t: Translate, phase: ReturnType<typeof outputPhase>): string {
  if (phase === "live") return t("destOutputLive");
  if (phase === "connecting") return t("destOutputStarting");
  if (phase === "retrying") return t("destOutputRetrying");
  if (phase === "failed") return t("destOutputFailed");
  if (phase === "off") return t("destOutputOff");
  return "";
}

export function Studio() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const publishingRef = useRef(false);
  const studioLiveRef = useRef(true);
  const shot = useMemo(() => shotFromUrl(), []);

  const [studio, setStudio] = useState<StudioView | null>(() => (shot ? shotStudio(shot) : null));
  const isHost = studio?.viewerRole === "owner" || studio?.viewerRole === "cohost";
  const [entry, setEntry] = useState<"pending" | "ok" | "gate">(shot ? "ok" : "pending");
  const [cohostInvite, setCohostInvite] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [entryId, setEntryId] = useState(id);
  if (entryId !== id) {
    setEntryId(id);
    setEntry(shot ? "ok" : "pending");
  }
  const [room, setRoom] = useState<Room | null>(null);
  const [peers, setPeers] = useState<(RemoteParticipant | LocalParticipant)[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [blurOn, setBlurOn] = useState(false);
  const [blurBusy, setBlurBusy] = useState(false);
  const [denoiseOn, setDenoiseOn] = useState(true);
  const [denoiseBusy, setDenoiseBusy] = useState(false);
  const originalVideoRef = useRef<MediaStreamTrack | null>(null);
  const originalAudioRef = useRef<MediaStreamTrack | null>(null);
  const denoiseHandleRef = useRef<PipelineHandle | null>(null);
  const blurHandleRef = useRef<CameraBlurHandle | null>(null);
  const [error, setError] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [youtubeChat, setYoutubeChat] = useState(Boolean(shot));
  const [panel, setPanel] = useState<PanelId | null>(shot === "chat" ? "chat" : null);
  const [goLiveOpen, setGoLiveOpen] = useState(shot === "golive");
  const [addRtmp, setAddRtmp] = useState(false);
  const [rtmpDraft, setRtmpDraft] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [clipSeconds, setClipSeconds] = useState<ClipSeconds>(loadClipSeconds);
  const [clipping, setClipping] = useState(false);
  const [clipNote, setClipNote] = useState("");
  const [now, setNow] = useState(Date.now());
  const identityRef = useRef<string>(shot ? "host" : "");
  const nameRef = useRef<string>(shot ? "Ana Souza" : "");
  const isHostRef = useRef(Boolean(shot));
  const dlgRef = useRef<HTMLDivElement>(null);
  const onClipRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (shot) return;
    const saved = loadSession(id);
    setBlurOn(loadBlurPref(saved?.cameraId ?? ""));
    setDenoiseOn(loadDenoisePref(saved?.micId ?? ""));
  }, [id, shot]);

  useEffect(() => {
    if (shot) return;
    void getConfig()
      .then((cfg) => setYoutubeChat(cfg.destinationChat.youtube))
      .catch(() => setYoutubeChat(false));
  }, [shot]);

  const isoOnStage = Boolean(studio?.participants.some((p) => p.identity === identityRef.current && p.onStage));
  const isoActive = Boolean(
    studio?.separateRecordings &&
      studio.isoSessionId &&
      isoOnStage &&
      (studio.livePhase === "starting" || studio.livePhase === "live" || studio.livePhase === "retrying"),
  );

  useEffect(() => {
    if (shot || !isoActive || !room || !studio?.isoSessionId) return;
    const sessionId = studio.isoSessionId;
    let cancelled = false;
    let rec: IsoRecorder | null = null;
    let interval = 0;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const saved = loadSession(id);
      rec = new IsoRecorder(
        id,
        sessionId,
        {
          identity: identityRef.current,
          name: nameRef.current,
          guestSecret: saved?.guestSecret,
        },
        () => setError(t("errIsoUpload")),
      );
      const tick = () => {
        if (cancelled) return;
        void rec?.sync(localIsoStreams(room, originalVideoRef.current, originalAudioRef.current));
      };
      tick();
      interval = window.setInterval(tick, 2000);
    }, 50);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(interval);
      void rec?.stop();
    };
  }, [shot, id, isoActive, room, studio?.isoSessionId, t]);

  useEffect(() => {
    if (shot) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let timer = 0;
    let delay = 500;
    const apply = (next: PublicStudio, viewerRole?: StudioView["viewerRole"]) =>
      setStudio((prev) => mergeStudio(prev, next, viewerRole ?? prev?.viewerRole ?? "guest"));
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
        void getStudio(id)
          .then((s) => apply(s, s.viewerRole))
          .catch(() => undefined);
        timer = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 8000);
      };
    };
    connect();
    getStudio(id)
      .then((s) => {
        apply(s, s.viewerRole);
        setCohostInvite(Boolean(s.cohostInvite));
        setEntry(canConnectToStudio(s.viewerRole, loadSession(id)) ? "ok" : "gate");
      })
      .catch((err) => setError(err.message));
    return () => {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, [id, shot]);

  useEffect(() => {
    if (entry !== "ok" || shot) return;
    studioLiveRef.current = true;
    let cancelled = false;
    let current: Room | null = null;
    let refreshTimer = 0;
    (async () => {
      const snap = studio ?? (await getStudio(id));
      if (cancelled) return;
      const host = snap.viewerRole === "owner" || snap.viewerRole === "cohost";
      isHostRef.current = host;
      const saved = loadSession(id);
      const name = saved?.name ?? (host ? t("studioHostName") : t("guestDefaultName"));
      nameRef.current = name;
      const minted = await mintToken(id, {
        name,
        role: host ? "host" : "guest",
        identity: !host && saved?.guestSecret ? saved.identity : undefined,
        guestSecret: !host ? saved?.guestSecret : undefined,
      });
      if (cancelled) return;
      identityRef.current = minted.identity;
      saveSession({
        studioId: id,
        identity: minted.identity,
        name: minted.name,
        role: minted.role,
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
      lk.on(RoomEvent.ParticipantPermissionsChanged, () => {
        if (!lk.localParticipant.permissions?.canPublish) return;
        if (lk.localParticipant.videoTrackPublications.size > 0) return;
        void publishLocal(lk);
      });
      lk.on(RoomEvent.DataReceived, (payload, participant) => {
        try {
          if (!participant?.identity || !isHostIdentity(participant.identity)) return;
          const msg = JSON.parse(new TextDecoder().decode(payload)) as { type?: string; on?: boolean };
          if (msg.type === "publish" && msg.on) void publishLocal(lk);
        } catch {
          /* ignore */
        }
      });
      async function refreshHostToken() {
        const next = await mintToken(id, { name: nameRef.current, role: "host" });
        scheduleRefresh(next.expiresIn);
        return next;
      }
      function scheduleRefresh(expiresIn: number) {
        window.clearTimeout(refreshTimer);
        const waitMs = Math.max(30_000, (expiresIn - 120) * 1000);
        refreshTimer = window.setTimeout(() => {
          void refreshHostToken().catch((err) => {
            if (cancelled) return;
            setError(err instanceof Error ? err.message : t("errRefresh"));
            current?.disconnect();
          });
        }, waitMs);
      }
      lk.on(RoomEvent.Disconnected, () => {
        if (cancelled || !isHostRef.current) return;
        void (async () => {
          try {
            const next = await refreshHostToken();
            if (cancelled) return;
            await lk.connect(next.url, next.token);
            if (cancelled) {
              lk.disconnect();
              return;
            }
            current = lk;
            setRoom(lk);
            bump();
            if (next.canPublish) await publishLocal(lk);
          } catch (err) {
            if (!cancelled) setError(err instanceof Error ? err.message : t("errReconnect"));
          }
        })();
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
      if (host) scheduleRefresh(minted.expiresIn);
    })().catch((err) => setError(err instanceof Error ? err.message : t("errConnect")));
    return () => {
      cancelled = true;
      studioLiveRef.current = false;
      blurHandleRef.current?.stop();
      blurHandleRef.current = null;
      originalVideoRef.current?.stop();
      originalVideoRef.current = null;
      denoiseHandleRef.current?.close();
      denoiseHandleRef.current = null;
      originalAudioRef.current?.stop();
      originalAudioRef.current = null;
      window.clearTimeout(refreshTimer);
      current?.disconnect();
    };
  }, [id, entry, shot]);

  useEffect(() => {
    if (!room || !studio || shot) return;
    const me = studio.participants.find((p) => p.identity === identityRef.current);
    if (!me?.onStage) return;
    if (room.localParticipant.videoTrackPublications.size > 0) return;
    if (room.localParticipant.permissions?.canPublish === false) return;
    void publishLocal(room);
  }, [studio, room, shot]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (goLiveOpen) {
        setGoLiveOpen(false);
        setAddRtmp(false);
        return;
      }
      if (inviteOpen) {
        setInviteOpen(false);
        return;
      }
      if (panel) setPanel(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goLiveOpen, inviteOpen, panel]);

  useEffect(() => {
    function typing(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "c" && e.key !== "C") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (typing(e.target)) return;
      const host = studio?.viewerRole === "owner" || studio?.viewerRole === "cohost";
      const phase = studio?.livePhase ?? (studio?.live ? "live" : "idle");
      if (!host || phase !== "live" || shot || clipping) return;
      e.preventDefault();
      void onClipRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [studio, shot, clipping]);

  useEffect(() => {
    if (!goLiveOpen) return;
    dlgRef.current?.focus();
  }, [goLiveOpen]);

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

  const waiting = (studio?.participants ?? []).filter((p) => !p.onStage);

  function studioOpen(lk: Room): boolean {
    return studioLiveRef.current && lk.state !== ConnectionState.Disconnected;
  }

  async function publishLocal(lk: Room) {
    if (publishingRef.current) return;
    if (lk.localParticipant.getTrackPublication(Track.Source.Camera)?.track) return;
    publishingRef.current = true;
    let raw: MediaStream | null = null;
    let processed: MediaStream | null = null;
    let pipeline: PipelineHandle | undefined;
    let handle: CameraBlurHandle | undefined;
    let published = false;
    try {
      const saved = loadSession(id);
      raw = await openUserMedia({ cameraId: saved?.cameraId, micId: saved?.micId });
      if (!studioOpen(lk)) return;
      const rawAudio = raw.getAudioTracks()[0] ?? null;
      originalAudioRef.current = rawAudio;
      const settingsMic = rawAudio?.getSettings().deviceId ?? "";
      const wantDenoise = loadDenoisePref(saved?.micId ?? "", settingsMic);
      setDenoiseOn(wantDenoise);
      pipeline = await processWithPipeline(raw, fxBackendForDenoise(wantDenoise));
      processed = pipeline.stream;
      if (!studioOpen(lk)) return;
      const video = processed.getVideoTracks()[0];
      if (video) {
        originalVideoRef.current = video;
        const settingsId = video.getSettings().deviceId ?? "";
        const wantBlur = loadBlurPref(saved?.cameraId ?? "", settingsId);
        setBlurOn(wantBlur);
        let publishVideo = video;
        if (wantBlur) {
          try {
            handle = await startCameraBlur(video);
            if (!studioOpen(lk)) return;
            blurHandleRef.current?.stop();
            blurHandleRef.current = handle;
            publishVideo = handle.track;
            handle = undefined;
          } catch (err) {
            handle?.stop();
            handle = undefined;
            console.warn("casthop blur", err);
            setBlurOn(false);
            setError(err instanceof Error ? err.message : t("errBlur"));
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
        if (audio !== rawAudio) denoiseHandleRef.current = pipeline;
      }
      published = studioOpen(lk);
    } finally {
      publishingRef.current = false;
      if (!published) {
        handle?.stop();
        blurHandleRef.current?.stop();
        blurHandleRef.current = null;
        originalVideoRef.current = null;
        originalAudioRef.current = null;
        denoiseHandleRef.current = null;
        pipeline?.close();
        processed?.getTracks().forEach((t) => t.stop());
        raw?.getTracks().forEach((t) => t.stop());
      }
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

  async function toggleDenoise() {
    if (denoiseBusy) return;
    const next = !denoiseOn;
    const savedId = loadSession(id)?.micId ?? "";
    const deviceId = originalAudioRef.current?.getSettings().deviceId ?? savedId;
    saveDenoisePrefPair(deviceId, savedId, next);
    setDenoiseOn(next);
    const local = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
    const original = originalAudioRef.current;
    if (!local || !original) return;
    setDenoiseBusy(true);
    let pipeline: PipelineHandle | undefined;
    try {
      if (fxBackendForDenoise(next) === "off") {
        await local.replaceTrack(original, { userProvidedTrack: true });
        denoiseHandleRef.current?.close();
        denoiseHandleRef.current = null;
      } else {
        pipeline = await processWithPipeline(new MediaStream([original]), fxBackendForDenoise(true));
        const track = pipeline.stream.getAudioTracks()[0];
        if (!track || !studioLiveRef.current) {
          pipeline.close();
          return;
        }
        await local.replaceTrack(track, { userProvidedTrack: true });
        const prev = denoiseHandleRef.current;
        denoiseHandleRef.current = track === original ? null : pipeline;
        if (track === original) pipeline.close();
        prev?.close();
      }
    } catch (err) {
      if (pipeline && denoiseHandleRef.current !== pipeline) pipeline.close();
      setError(err instanceof Error ? err.message : t("errNoise"));
      setDenoiseOn(!next);
      saveDenoisePrefPair(deviceId, savedId, !next);
    } finally {
      setDenoiseBusy(false);
    }
  }

  async function toggleBlur() {
    if (blurBusy) return;
    const next = !blurOn;
    const savedId = loadSession(id)?.cameraId ?? "";
    const deviceId = originalVideoRef.current?.getSettings().deviceId ?? savedId;
    saveBlurPrefPair(deviceId, savedId, next);
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
      setError(err instanceof Error ? err.message : t("errBlur"));
      setBlurOn(!next);
      saveBlurPrefPair(deviceId, savedId, !next);
    } finally {
      setBlurBusy(false);
    }
  }

  async function shareScreen() {
    try {
      await room?.localParticipant.setScreenShareEnabled(true);
      if (isHostRef.current) await setLayout(id, "screen");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errScreen"));
    }
  }

  async function onLayout(layout: LayoutId) {
    if (!isHost) return;
    setStudio((prev) => (prev ? { ...prev, layout } : prev));
    if (shot) return;
    try {
      const next = await setLayout(id, layout);
      setStudio((prev) => mergeStudio(prev, next, prev?.viewerRole ?? "guest"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errLayout"));
    }
  }

  async function onToggleIso() {
    if (!isHost || !studio) return;
    const next = !studio.separateRecordings;
    setStudio((prev) => (prev ? { ...prev, separateRecordings: next } : prev));
    if (shot) return;
    try {
      const saved = await setSeparateRecordings(id, next);
      setStudio((prev) => mergeStudio(prev, saved, prev?.viewerRole ?? "guest"));
    } catch (err) {
      setStudio((prev) => (prev ? { ...prev, separateRecordings: !next } : prev));
      setError(err instanceof Error ? err.message : t("errIso"));
    }
  }

  async function persistDestinations(next: PublicDestination[]) {
    if (!studio) return;
    if (shot) {
      setStudio((prev) => (prev ? { ...prev, destinations: next } : prev));
      return;
    }
    const saved = await setDestinations(id, next);
    setStudio((prev) => mergeStudio(prev, saved, prev?.viewerRole ?? "guest"));
  }

  async function onToggleDest(destId: string) {
    if (!isHost || !studio) return;
    const next = studio.destinations.map((x) => (x.id === destId ? { ...x, enabled: !x.enabled } : x));
    try {
      await persistDestinations(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errDestinations"));
    }
  }

  async function onDestAspect(destId: string, aspect: DestAspect) {
    if (!isHost || !studio) return;
    const next = studio.destinations.map((x) => (x.id === destId ? { ...x, aspect } : x));
    try {
      await persistDestinations(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errDestinations"));
    }
  }

  async function onAddRtmp(url: string) {
    if (!isHost || !studio) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    const vacant = emptyCustom(studio.destinations);
    const next = vacant
      ? studio.destinations.map((d) => (d.id === vacant.id ? { ...d, url: trimmed, enabled: true, hasKey: true } : d))
      : [...studio.destinations, newCustomDest(trimmed, studio.destinations, t)];
    try {
      await persistDestinations(next);
      setRtmpDraft("");
      setAddRtmp(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errAddDest"));
    }
  }

  async function onGoLive() {
    if (!isHost || !studio) return;
    setError("");
    const phaseNow = studio.livePhase ?? (studio.live ? "live" : "idle");
    if (phaseNow === "failed") return;
    const busy = phaseNow === "live" || phaseNow === "starting" || phaseNow === "retrying" || phaseNow === "stopping";
    if (busy) {
      await onEndLive();
      return;
    }
    setGoLiveOpen(true);
  }

  async function onConfirmGoLive() {
    if (!isHost || !studio) return;
    setError("");
    setGoLiveOpen(false);
    if (shot) {
      setStudio((prev) =>
        prev
          ? {
              ...prev,
              live: true,
              livePhase: "live",
              liveStartedAt: Date.now() - SHOT_LIVE_MS,
            }
          : prev,
      );
      return;
    }
    try {
      await setSeparateRecordings(id, studio.separateRecordings);
      await setLive(id, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errLive"));
    }
  }

  async function onRetryLive() {
    if (!isHost || !studio) return;
    setError("");
    try {
      await setLive(id, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errLive"));
    }
  }

  async function onEndLive() {
    if (!isHost || !studio) return;
    setError("");
    if (shot) {
      setStudio((prev) => (prev ? { ...prev, live: false, livePhase: "idle", liveStartedAt: null } : prev));
      return;
    }
    try {
      await setLive(id, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errLive"));
    }
  }

  async function onChat(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fromForm = String(new FormData(e.currentTarget).get("text") ?? "").trim();
    const text = fromForm || chatDraft.trim();
    if (!text) return;
    setChatDraft("");
    if (shot) {
      setStudio((prev) => {
        if (!prev) return prev;
        const msg = {
          id: `c-${prev.chat.length + 1}`,
          from: identityRef.current,
          name: nameRef.current,
          text,
          at: Date.now(),
          source: "studio" as const,
        };
        return { ...prev, chat: [...prev.chat, msg] };
      });
      return;
    }
    try {
      const saved = loadSession(id);
      const next = await sendChat(id, {
        text,
        identity: identityRef.current,
        guestSecret: saved?.guestSecret,
      });
      setStudio((prev) => mergeStudio(prev, next, prev?.viewerRole ?? "guest"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errChat"));
    }
  }

  async function onPin(chatId: string | null) {
    if (!isHost) return;
    if (shot) {
      setStudio((prev) => {
        if (!prev) return prev;
        if (!chatId) return { ...prev, pinnedChat: null };
        const m = prev.chat.find((c) => c.id === chatId);
        return { ...prev, pinnedChat: m ? { id: m.id, name: m.name, text: m.text, source: m.source } : null };
      });
      return;
    }
    try {
      const saved = await pinChat(id, chatId);
      setStudio((prev) => mergeStudio(prev, saved, prev?.viewerRole ?? "guest"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errPin"));
    }
  }

  async function copyInvite() {
    const url = `${location.origin}/join/${id}`;
    await navigator.clipboard.writeText(url);
    setInviteOpen(true);
  }

  async function promote(identity: string, on: boolean) {
    if (!isHost) return;
    if (shot) {
      setStudio((prev) =>
        prev
          ? {
              ...prev,
              participants: prev.participants.map((p) => (p.identity === identity ? { ...p, onStage: on } : p)),
            }
          : prev,
      );
      return;
    }
    try {
      const next = await setStage(id, identity, on);
      const { warning, ...state } = next;
      setStudio((prev) => mergeStudio(prev, state, prev?.viewerRole ?? "guest"));
      setError(warning ?? "");
      const payload = new TextEncoder().encode(JSON.stringify({ type: "publish", on }));
      await room?.localParticipant.publishData(payload, { destinationIdentities: [identity] });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errStage"));
    }
  }

  async function onClip() {
    if (shot || clipping) return;
    setClipping(true);
    setClipNote("");
    try {
      await createClip(id, clipSeconds);
      setClipNote("saved");
      window.setTimeout(() => setClipNote((cur) => (cur === "saved" ? "" : cur)), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errClip"));
    } finally {
      setClipping(false);
    }
  }
  onClipRef.current = onClip;

  function onClipSeconds(next: ClipSeconds) {
    setClipSeconds(next);
    saveClipSeconds(next);
  }

  function togglePanel(next: PanelId) {
    setPanel((cur) => (cur === next ? null : next));
  }

  async function onAcceptCohost() {
    setAccepting(true);
    setError("");
    try {
      await acceptCohostInvite(id);
      const s = await getStudio(id);
      setStudio((prev) => mergeStudio(prev, s, s.viewerRole));
      setCohostInvite(false);
      setEntry(canConnectToStudio(s.viewerRole, loadSession(id)) ? "ok" : "gate");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cohostInviteFailed"));
    } finally {
      setAccepting(false);
    }
  }

  if (entry === "gate" && cohostInvite) {
    return (
      <div className="studio">
        <StudioTop title={studio?.title ?? t("studioFallback")} live={false} timer="" />
        <div className="scrim">
          <div className="dlg gate-dlg">
            <p className="lead">{t("cohostInviteNote")}</p>
            {error ? (
              <p className="lead" role="alert">
                {error}
              </p>
            ) : null}
            <footer>
              <button className="btn primary" type="button" disabled={accepting} onClick={() => void onAcceptCohost()}>
                {t("cohostInviteAccept")}
              </button>
            </footer>
          </div>
        </div>
      </div>
    );
  }

  if (entry === "gate") {
    return (
      <div className="studio">
        <StudioTop title={studio?.title ?? t("studioFallback")} live={false} timer="" />
        <div className="scrim">
          <div className="dlg gate-dlg">
            <header>
              <h2>{t("gateTitle")}</h2>
            </header>
            <p className="lead">{t("gateBody")}</p>
            <footer>
              <button className="btn ghost" type="button" onClick={() => navigate("/")}>
                {t("gateSignIn")}
              </button>
              <button className="btn primary" type="button" onClick={() => navigate(`/join/${id}`)}>
                {t("gateJoin")}
              </button>
            </footer>
          </div>
        </div>
      </div>
    );
  }

  if (!studio || entry !== "ok") {
    return (
      <div className="studio">
        <StudioTop title={error || t("studioOpening")} live={false} timer="" />
      </div>
    );
  }

  const liveMs = studio.live && studio.liveStartedAt ? Math.max(0, now - studio.liveStartedAt) : 0;
  const phase = studio.livePhase ?? (studio.live ? "live" : "idle");
  const liveOn = phase === "live";
  const liveBusy = phase === "live" || phase === "starting" || phase === "retrying" || phase === "stopping";
  const liveError = studio.liveError;
  const enabledCount = studio.destinations.filter((d) => d.enabled).length;
  const meOnStage = studio.participants.find((p) => p.identity === identityRef.current)?.onStage;
  const timerText = shot === "chat" ? formatLive(SHOT_LIVE_MS) : liveOn ? formatLive(liveMs) : "";

  function statusText(): string {
    if (phase === "starting") return t("liveStarting");
    if (phase === "retrying") return liveError ? t("liveReconnectingError", { error: liveError }) : t("liveReconnecting");
    if (phase === "stopping") return t("liveStopping");
    if (phase === "failed") return liveError ? t("liveFailedError", { error: liveError }) : t("liveFailed");
    if (liveOn) return t("liveLive");
    return t("liveNotLive");
  }

  return (
    <div className={`studio${panel ? " open" : ""}`}>
      <header className="top">
        <a className="brand" href="/" aria-label={t("brandHome")}>
          <span className="mark" aria-hidden="true" />
          <span className="slash">/</span>
          <h1 className="title">{studio.title}</h1>
        </a>
        <div className="spacer" />
        <LanguageSwitcher tone="dark" />
        <div
          className={`status${liveOn ? " on" : ""}${phase === "retrying" ? " retry" : ""}${phase === "failed" ? " fail" : ""}`}
        >
          <span className="dot" />
          <span className="live-pill">
            {statusText()}
            {liveOn && timerText ? (
              <>
                {" "}
                <span className="mono">{timerText}</span>
              </>
            ) : null}
          </span>
        </div>
        {isHost && liveOn ? (
          <div className="clip-bar">
            <div className="seg clip-len" role="group" aria-label={t("clipLength")}>
              {([30, 60] as const).map((sec) => (
                <button
                  key={sec}
                  type="button"
                  className={clipSeconds === sec ? "on" : undefined}
                  aria-pressed={clipSeconds === sec}
                  onClick={() => onClipSeconds(sec)}
                >
                  {t("clipSeconds", { seconds: sec })}
                </button>
              ))}
            </div>
            <button
              className="btn ghost"
              type="button"
              data-testid="clip"
              aria-keyshortcuts="c"
              title={t("clipHint", { seconds: clipSeconds })}
              aria-label={t("clipLast", { seconds: clipSeconds })}
              onClick={() => void onClip()}
              disabled={clipping}
            >
              {clipping ? t("clipSaving") : clipNote === "saved" ? t("clipSaved") : t("clip")}
            </button>
          </div>
        ) : null}
        {isHost && phase === "failed" ? (
          <>
            <button className="btn ghost" type="button" onClick={() => void onRetryLive()} disabled={!room && !shot}>
              {t("liveRetry")}
            </button>
            <button className="btn end" type="button" onClick={() => void onEndLive()}>
              {t("liveEnd")}
            </button>
          </>
        ) : isHost ? (
          <span>
            <button
              className={liveBusy ? "btn end" : "btn primary go-live-open"}
              type="button"
              data-testid="go-live"
              onClick={() => void onGoLive()}
              disabled={phase === "starting" || phase === "stopping" || (!liveBusy && !room && !shot)}
            >
              {liveBusy ? t("liveEnd") : t("liveGo")}
            </button>
          </span>
        ) : null}
      </header>

      <main className="main">
        <div className="stagewrap">
          <section className={`program ${programClass(studio.layout, stagePeople.length)}`} aria-label={t("programPreview")}>
            {studio.layout === "screen" ? (
              <>
                <VideoTile
                  booth
                  tone="cam1"
                  participant={stagePeople.find((p) => p.participant?.getTrackPublication(Track.Source.ScreenShare))?.participant}
                  label={t("screen")}
                />
                <div className="cams">
                  {stagePeople.slice(0, 3).map((p, i) => (
                    <VideoTile
                      key={p.info.identity}
                      booth
                      tone={tileTone(i)}
                      participant={p.participant}
                      label={p.info.name}
                      local={p.participant instanceof LocalParticipant}
                    />
                  ))}
                </div>
              </>
            ) : (
              visibleStage(studio.layout, stagePeople).map((p, i) => (
                <VideoTile
                  key={p.info.identity}
                  booth
                  tone={tileTone(i)}
                  participant={p.participant}
                  label={p.info.name}
                  local={p.participant instanceof LocalParticipant}
                />
              ))
            )}
            {stagePeople.length === 0 ? <VideoTile booth tone="cam1" label={t("emptyStage")} /> : null}
            <div className="l3">
              <b>{studio.bannerTitle}</b>
              <span>{studio.bannerSubtitle}</span>
            </div>
            {studio.pinnedChat ? (
              <div className="pinov" role="status" aria-label={t("pinnedFrom", { name: studio.pinnedChat.name })}>
                <span className="who">{pinWho(studio.pinnedChat)}</span>
                {studio.pinnedChat.text}
              </div>
            ) : null}
          </section>
        </div>

        <div className="row">
          <div>
            {isHost ? (
              <div className="seg" role="group" aria-label={t("layout")}>
                {(
                  [
                    ["solo", t("layoutSolo")],
                    ["side", t("layoutSide")],
                    ["screen", t("layoutScreen")],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={studio.layout === key ? "on" : undefined}
                    onClick={() => void onLayout(key)}
                    aria-label={label}
                    aria-pressed={studio.layout === key}
                    title={label}
                  >
                    <LayoutIcon id={key} />
                  </button>
                ))}
              </div>
            ) : (
              <p className="guest-note">
                {meOnStage ? t("onStage") : t("waitingHost")}
                {isoActive ? ` · ${t("isoGuestNote")}` : ""}
              </p>
            )}
          </div>
          <div className="dock">
            <button className={`ctl icon${micOn ? "" : " off"}`} type="button" onClick={() => void toggleMic()} title={t("mic")} aria-label={t("mic")} aria-pressed={micOn}>
              {micOn ? <Mic className="i" size={16} strokeWidth={1.6} /> : <MicOff className="i" size={16} strokeWidth={1.6} />}
            </button>
            <button className={`ctl icon${camOn ? "" : " off"}`} type="button" onClick={() => void toggleCam()} title={t("camera")} aria-label={t("camera")} aria-pressed={camOn}>
              {camOn ? <Video className="i" size={16} strokeWidth={1.6} /> : <VideoOff className="i" size={16} strokeWidth={1.6} />}
            </button>
            <button className="ctl" type="button" onClick={() => void shareScreen()} title={t("shareScreen")} aria-label={t("share")}>
              <MonitorUp className="i" size={16} strokeWidth={1.6} />
              <span>{t("share")}</span>
            </button>
            <span className="sep" />
            <button
              className={`ctl${denoiseOn ? "" : " dim"}`}
              type="button"
              onClick={() => void toggleDenoise()}
              title={t("noiseSuppression")}
              aria-label={t("noise")}
              aria-pressed={denoiseOn}
              disabled={denoiseBusy}
            >
              <span className="chk" />
              <small>{t("noise")}</small>
            </button>
            <button
              className={`ctl${blurOn ? "" : " dim"}`}
              type="button"
              onClick={() => void toggleBlur()}
              title={t("backgroundBlur")}
              aria-label={t("blur")}
              aria-pressed={blurOn}
              disabled={blurBusy}
            >
              <span className="chk" />
              <small>{t("blur")}</small>
            </button>
          </div>
          <div className="right">
            {isHost ? (
              <button className="btn ghost" type="button" onClick={() => void copyInvite()}>
                <Link className="i" size={16} strokeWidth={1.6} />
                {t("inviteGuest")}
              </button>
            ) : null}
          </div>
        </div>

        <div className="back">
          <span className="lbl">{t("backstage")}</span>
          {waiting.map((p) => (
            <div className="gchip" key={p.identity}>
              <div className={`thumb ${tileTone(2)}`}>
                <div className="person">
                  <div className="head" />
                  <div className="body" />
                </div>
              </div>
              <span className="n">{p.name}</span>
              {isHost ? (
                <button className="act" type="button" aria-label={t("addNamedToStage", { name: p.name })} onClick={() => void promote(p.identity, true)}>
                  {t("addToStage")}
                </button>
              ) : null}
            </div>
          ))}
          <span className="hint">{t("backstageHint")}</span>
        </div>
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
      </main>

      {panel ? (
        <aside className="sidepanel" aria-label={panelLabel(panel, t)}>
          <div className="ph">
            <h3>
              {panelTitle(panel, t)}
              {panel === "chat" && (isHost && youtubeChat) ? <span className="sub">{t("chatStudioYoutube")}</span> : null}
            </h3>
            <button className="btn quiet" type="button" aria-label={t("closePanel")} onClick={() => setPanel(null)}>
              <X className="i" size={16} strokeWidth={1.6} />
            </button>
          </div>
          {panel === "chat" ? (
            <ChatPanel
              studio={studio}
              isHost={isHost}
              chatDraft={chatDraft}
              onDraft={setChatDraft}
              onChat={onChat}
              onPin={onPin}
            />
          ) : null}
          {panel === "destinations" ? (
            <DestinationsPanel
              studio={studio}
              isHost={isHost}
              addRtmp={addRtmp}
              rtmpDraft={rtmpDraft}
              onDraft={setRtmpDraft}
              onToggleAdd={() => setAddRtmp((v) => !v)}
              onAdd={() => void onAddRtmp(rtmpDraft)}
              onToggle={onToggleDest}
              onAspect={onDestAspect}
              onSaveUrls={async (next) => {
                try {
                  await persistDestinations(next);
                } catch (err) {
                  setError(err instanceof Error ? err.message : t("errSave"));
                }
              }}
            />
          ) : null}
          {panel === "lower-third" && isHost ? (
            <LowerThirdPanel
              studio={studio}
              onSave={async (bannerTitle, bannerSubtitle) => {
                try {
                  if (shot) {
                    setStudio((prev) => (prev ? { ...prev, bannerTitle, bannerSubtitle } : prev));
                    return;
                  }
                  await setBanner(id, { bannerTitle, bannerSubtitle });
                  setStudio((prev) => (prev ? { ...prev, bannerTitle, bannerSubtitle } : prev));
                } catch (err) {
                  setError(err instanceof Error ? err.message : t("errSave"));
                }
              }}
            />
          ) : null}
          {panel === "recordings" && isHost ? <RecordingsPanel studioId={shot ? studio.id : id} /> : null}
          {panel === "settings" && isHost ? (
            <SettingsPanel
              studioId={shot ? studio.id : id}
              studio={studio}
              canInvite={studio.viewerRole === "owner" && !shot}
              onTitle={async (title) => {
                try {
                  if (shot) {
                    setStudio((prev) => (prev ? { ...prev, title } : prev));
                    return;
                  }
                  await setBanner(id, { title });
                  setStudio((prev) => (prev ? { ...prev, title } : prev));
                } catch (err) {
                  setError(err instanceof Error ? err.message : t("errSave"));
                }
              }}
            />
          ) : null}
        </aside>
      ) : null}

      <nav className="rail" aria-label={t("panels")}>
        <button
          type="button"
          className={panel === "chat" ? "on" : undefined}
          data-testid="rail-chat"
          title={t("panelChat")}
          aria-label={t("panelChat")}
          aria-pressed={panel === "chat"}
          onClick={() => togglePanel("chat")}
        >
          <ChatIcon />
          {studio.chat.length > 0 && panel !== "chat" ? <span className="badge" /> : null}
        </button>
        <button
          type="button"
          className={panel === "destinations" ? "on" : undefined}
          data-testid="rail-destinations"
          title={t("panelDestinations")}
          aria-label={t("panelDestinations")}
          aria-pressed={panel === "destinations"}
          onClick={() => togglePanel("destinations")}
        >
          <RadioIcon />
        </button>
        {isHost ? (
          <button
            type="button"
            className={panel === "lower-third" ? "on" : undefined}
            data-testid="rail-lower-third"
            title={t("panelLowerThird")}
            aria-label={t("panelLowerThird")}
            aria-pressed={panel === "lower-third"}
            onClick={() => togglePanel("lower-third")}
          >
            <TypeIcon />
          </button>
        ) : null}
        {isHost ? (
          <button
            type="button"
            className={panel === "recordings" ? "on" : undefined}
            data-testid="rail-recordings"
            title={t("panelRecordings")}
            aria-label={t("panelRecordings")}
            aria-pressed={panel === "recordings"}
            onClick={() => togglePanel("recordings")}
          >
            <RecordingsIcon />
          </button>
        ) : null}
        <span className="grow" />
        {isHost ? (
          <button
            type="button"
            className={panel === "settings" ? "on" : undefined}
            data-testid="rail-settings"
            title={t("panelSettings")}
            aria-label={t("panelSettings")}
            aria-pressed={panel === "settings"}
            onClick={() => togglePanel("settings")}
          >
            <SettingsIcon />
          </button>
        ) : null}
      </nav>

      {goLiveOpen && isHost ? (
        <div
          className="scrim"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setGoLiveOpen(false);
              setAddRtmp(false);
            }
          }}
        >
          <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="golive-title" ref={dlgRef} tabIndex={-1}>
            <header>
              <h2 id="golive-title">{t("liveGo")}</h2>
              <button
                className="btn quiet"
                type="button"
                aria-label={t("close")}
                onClick={() => {
                  setGoLiveOpen(false);
                  setAddRtmp(false);
                }}
              >
                <X className="i" size={16} strokeWidth={1.6} />
              </button>
            </header>
            <p className="lead">{t("liveLead")}</p>
            <div className="output-row" aria-label={t("destOutputs")}>
              <span className={`output-pill ${outputPhase(studio.destinations, "landscape")}`}>
                {t("destOutputLandscape")} {outputStatusLabel(t, outputPhase(studio.destinations, "landscape"))}
              </span>
              <span className={`output-pill ${outputPhase(studio.destinations, "portrait")}`}>
                {t("destOutputPortrait")} {outputStatusLabel(t, outputPhase(studio.destinations, "portrait"))}
              </span>
            </div>
            {studio.destinations.map((d) => (
              <div className="dest" key={d.id}>
                <span className="k">{destGlyph(d.kind)}</span>
                <div className="t">
                  <b>{d.label}</b>
                  <small>
                    {d.detail}
                    <span className={`dest-status ${d.status ?? "idle"}`}>{destStatusLabel(t, d.status, d.error)}</span>
                  </small>
                  {isHost ? (
                    <AspectToggle
                      label={d.label}
                      value={destAspectOf(d)}
                      onChange={(aspect) => void onDestAspect(d.id, aspect)}
                      t={t}
                    />
                  ) : null}
                </div>
                <button
                  type="button"
                  className={`sw${d.enabled ? " on" : ""}`}
                  aria-pressed={d.enabled}
                  aria-label={d.enabled ? t("destDisable", { label: d.label }) : t("destEnable", { label: d.label })}
                  onClick={() => void onToggleDest(d.id)}
                />
              </div>
            ))}
            {addRtmp ? (
              <form
                className="dest add-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onAddRtmp(rtmpDraft);
                }}
              >
                <label className="t">
                  {t("destRtmpUrl")}
                  <input
                    value={rtmpDraft}
                    onChange={(e) => setRtmpDraft(e.target.value)}
                    placeholder={t("destRtmpPlaceholder")}
                    autoFocus
                  />
                </label>
                <button className="btn ghost" type="submit">
                  {t("add")}
                </button>
              </form>
            ) : null}
            <div className="dest">
              <div className="t">
                <b>{t("isoSeparate")}</b>
                <small>{t("isoSeparateLead")}</small>
              </div>
              <button
                type="button"
                className={`sw${studio.separateRecordings ? " on" : ""}`}
                aria-pressed={studio.separateRecordings}
                aria-label={studio.separateRecordings ? t("isoSeparateOff") : t("isoSeparateOn")}
                onClick={() => void onToggleIso()}
              />
            </div>
            <footer>
              <button className="add" type="button" onClick={() => setAddRtmp(true)}>
                {t("destAddRtmp")}
              </button>
              <button
                className="btn primary go-live"
                type="button"
                onClick={() => void onConfirmGoLive()}
                disabled={!shot && !room}
              >
                {enabledCount ? t("liveGoOn", { count: enabledCount }) : t("liveGo")}
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {inviteOpen ? (
        <div className="scrim" onClick={() => setInviteOpen(false)}>
          <div className="dlg" role="dialog" aria-labelledby="invite-title" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2 id="invite-title">{t("inviteGuest")}</h2>
              <button className="btn quiet" type="button" aria-label={t("close")} onClick={() => setInviteOpen(false)}>
                <X className="i" size={16} strokeWidth={1.6} />
              </button>
            </header>
            <p className="lead">{t("inviteLead")}</p>
            <div className="dest">
              <input readOnly value={`${location.origin}/join/${id}`} onFocus={(e) => e.currentTarget.select()} />
            </div>
            <footer>
              <span />
              <button className="btn primary" type="button" onClick={() => setInviteOpen(false)}>
                {t("done")}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StudioTop({ title, live, timer }: { title: string; live: boolean; timer: string }) {
  const { t } = useI18n();
  return (
    <header className="top">
      <a className="brand" href="/" aria-label={t("brandHome")}>
        <span className="mark" aria-hidden="true" />
        <span className="slash">/</span>
        <span className="title">{title}</span>
      </a>
      <div className="spacer" />
      <LanguageSwitcher tone="dark" />
      <div className={`status${live ? " on" : ""}`}>
        <span className="dot" />
        {live ? (
          <>
            {t("liveLive")} {timer ? <span className="mono">{timer}</span> : null}
          </>
        ) : (
          t("liveNotLive")
        )}
      </div>
    </header>
  );
}

function ChatPanel({
  studio,
  isHost,
  chatDraft,
  onDraft,
  onChat,
  onPin,
}: {
  studio: PublicStudio;
  isHost: boolean;
  chatDraft: string;
  onDraft: (value: string) => void;
  onChat: (e: FormEvent<HTMLFormElement>) => void;
  onPin: (id: string | null) => void;
}) {
  const { t, formatDateTime } = useI18n();
  return (
    <>
      <div className="msgs">
        {studio.chat.length === 0 ? <p className="empty-chat">{t("chatEmpty")}</p> : null}
        {studio.chat.map((m) => {
          const pinned = studio.pinnedChat?.id === m.id;
          return (
            <div key={m.id} className={`msg${pinned ? " pinned" : ""}`}>
              <div className="meta">
                <span className="src">{chatSourceLabel(m.source)}</span>
                <time dateTime={new Date(m.at).toISOString()} title={formatDateTime(m.at)}>
                  {m.name}
                </time>
                {isHost && pinned ? (
                  <button type="button" className="pinbtn" aria-label={t("unpinComment")} onClick={() => onPin(null)}>
                    <PinIcon />
                    {t("unpin")}
                  </button>
                ) : isHost ? (
                  <button type="button" className="pinbtn" aria-label={t("pinComment")} onClick={() => onPin(m.id)}>
                    <PinIcon />
                    {t("pin")}
                  </button>
                ) : null}
              </div>
              <span className="body">{m.text}</span>
            </div>
          );
        })}
      </div>
      <form className="compose" onSubmit={onChat}>
        <div className="input-row">
          <input
            name="text"
            aria-label={t("chatStudioLabel")}
            value={chatDraft}
            onChange={(e) => onDraft(e.target.value)}
            placeholder={t("chatPlaceholder")}
          />
          <button type="submit" className="send" aria-label={t("send")}>
            <SendIcon />
          </button>
        </div>
      </form>
    </>
  );
}

function DestinationsPanel({
  studio,
  isHost,
  addRtmp,
  rtmpDraft,
  onDraft,
  onToggleAdd,
  onAdd,
  onToggle,
  onAspect,
  onSaveUrls,
}: {
  studio: PublicStudio;
  isHost: boolean;
  addRtmp: boolean;
  rtmpDraft: string;
  onDraft: (value: string) => void;
  onToggleAdd: () => void;
  onAdd: () => void;
  onToggle: (id: string) => void;
  onAspect: (id: string, aspect: DestAspect) => void;
  onSaveUrls: (next: PublicDestination[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState(studio.destinations);
  useEffect(() => {
    setRows(studio.destinations);
  }, [studio.destinations]);

  const landPhase = outputPhase(studio.destinations, "landscape");
  const portPhase = outputPhase(studio.destinations, "portrait");

  return (
    <div className="panel-body">
      <div className="output-row" aria-label={t("destOutputs")}>
        <span className={`output-pill ${landPhase}`}>
          {t("destOutputLandscape")} {outputStatusLabel(t, landPhase)}
        </span>
        <span className={`output-pill ${portPhase}`}>
          {t("destOutputPortrait")} {outputStatusLabel(t, portPhase)}
        </span>
      </div>
      <p className="dest-hint">{t("destAspectHint")}</p>
      {rows.map((d, i) => (
        <div className="dest" key={d.id}>
          <span className="k">{destGlyph(d.kind)}</span>
          <div className="t">
            <b>{d.label}</b>
            <small>
              {d.detail}
              <span className={`dest-status ${d.status ?? "idle"}`}>{destStatusLabel(t, d.status, d.error)}</span>
            </small>
            {isHost ? (
              <AspectToggle
                label={d.label}
                value={destAspectOf(d)}
                onChange={(aspect) => {
                  const next = rows.slice();
                  next[i] = { ...d, aspect };
                  setRows(next);
                  void onAspect(d.id, aspect);
                }}
                t={t}
              />
            ) : null}
            {isHost ? (
              <label>
                {t("destRtmpUrlNamed", { label: d.label })}
                <input
                  value={d.url ?? ""}
                  onChange={(e) => {
                    const next = rows.slice();
                    next[i] = { ...d, url: e.target.value };
                    setRows(next);
                  }}
                />
              </label>
            ) : null}
          </div>
          <button
            type="button"
            className={`sw${d.enabled ? " on" : ""}`}
            disabled={!isHost}
            aria-pressed={d.enabled}
            aria-label={d.enabled ? t("destDisable", { label: d.label }) : t("destEnable", { label: d.label })}
            onClick={() => onToggle(d.id)}
          />
        </div>
      ))}
      {isHost && addRtmp ? (
        <form
          className="dest add-row"
          onSubmit={(e) => {
            e.preventDefault();
            onAdd();
          }}
        >
          <label className="t">
            {t("destRtmpUrl")}
            <input value={rtmpDraft} onChange={(e) => onDraft(e.target.value)} placeholder={t("destRtmpPlaceholder")} />
          </label>
          <button className="btn ghost" type="submit">
            {t("add")}
          </button>
        </form>
      ) : null}
      {isHost ? (
        <div className="panel-actions">
          <button className="add" type="button" onClick={onToggleAdd}>
            {t("destAddRtmp")}
          </button>
          <button className="btn primary" type="button" onClick={() => void onSaveUrls(rows)}>
            {t("save")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function LowerThirdPanel({
  studio,
  onSave,
}: {
  studio: PublicStudio;
  onSave: (bannerTitle: string, bannerSubtitle: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [bannerTitle, setBannerTitle] = useState(studio.bannerTitle);
  const [bannerSubtitle, setBannerSubtitle] = useState(studio.bannerSubtitle);
  return (
    <form
      className="panel-body stack"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(bannerTitle, bannerSubtitle);
      }}
    >
      <label>
        {t("lowerThird")}
        <input value={bannerTitle} onChange={(e) => setBannerTitle(e.target.value)} />
      </label>
      <label>
        {t("lowerThirdDetail")}
        <input value={bannerSubtitle} onChange={(e) => setBannerSubtitle(e.target.value)} />
      </label>
      <button className="btn primary" type="submit">
        {t("save")}
      </button>
    </form>
  );
}

function RecordingsPanel({ studioId }: { studioId: string }) {
  const { t, formatDateTime } = useI18n();
  const [data, setData] = useState<RecordingList | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      listRecordings(studioId)
        .then((next) => {
          if (!cancelled) setData(next);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [studioId]);

  const tracks = [...(data?.tracks ?? [])].sort((a, b) => b.startedAt - a.startedAt);
  const empty = !data?.mixed && tracks.length === 0;

  return (
    <div className="panel-body stack rec-list">
      {empty ? <p className="empty-chat">{t("isoEmpty")}</p> : null}
      {data?.mixed?.filename ? (
        <div className="rec-row">
          <div className="t">
            <b>{t("isoMixed")}</b>
            <small>{t("isoMixedHint", { path: data.mixed.filename })}</small>
          </div>
        </div>
      ) : null}
      {tracks.map((track) => (
        <IsoTrackRow key={track.id} studioId={studioId} track={track} t={t} formatDateTime={formatDateTime} />
      ))}
    </div>
  );
}

function IsoTrackRow({
  studioId,
  track,
  t,
  formatDateTime,
}: {
  studioId: string;
  track: IsoTrack;
  t: Translate;
  formatDateTime: (value: number | Date) => string;
}) {
  const kind = track.kind === "screen" ? t("isoKindScreen") : t("isoKindCamera");
  const mb = Math.max(0.1, Math.round((track.bytes / (1024 * 1024)) * 10) / 10);
  return (
    <div className="rec-row">
      <div className="t">
        <b>{t("isoTrackLine", { name: track.name, kind })}</b>
        <small>
          {formatDateTime(track.startedAt)}
          {" · "}
          {t("isoSizeMb", { n: mb })}
          {track.complete ? "" : ` · ${t("isoIncomplete")}`}
        </small>
      </div>
      {track.chunks > 0 ? (
        <a className="btn ghost rec-dl" href={isoDownloadPath(studioId, track.id)}>
          {t("isoDownload")}
        </a>
      ) : null}
    </div>
  );
}

function SettingsPanel({
  studioId,
  studio,
  canInvite,
  onTitle,
}: {
  studioId: string;
  studio: PublicStudio;
  canInvite: boolean;
  onTitle: (title: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(studio.title);
  const [inviteEmail, setInviteEmail] = useState("");
  const [members, setMembers] = useState<StudioMember[]>([]);
  const [pending, setPending] = useState<{ email: string }[]>([]);
  const [inviteNote, setInviteNote] = useState("");

  useEffect(() => {
    if (!canInvite) return;
    listCohosts(studioId)
      .then((data) => {
        setMembers(data.members);
        setPending(data.pending);
      })
      .catch(() => undefined);
  }, [studioId, canInvite]);

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setInviteNote("");
    try {
      await inviteCohost(studioId, inviteEmail);
      setInviteEmail("");
      setInviteNote(t("inviteSent"));
      const data = await listCohosts(studioId);
      setMembers(data.members);
      setPending(data.pending);
    } catch (err) {
      setInviteNote(err instanceof Error ? err.message : t("inviteFailed"));
    }
  }

  return (
    <div className="panel-body stack">
      <div className="lang-field">
        <span>{t("language")}</span>
        <LanguageSwitcher tone="dark" />
      </div>
      <label>
        {t("settingsTitle")}
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <button className="btn primary" type="button" onClick={() => void onTitle(title)}>
        {t("save")}
      </button>
      {canInvite ? (
        <form className="cohost-form" onSubmit={onInvite}>
          <label>
            {t("inviteCohost")}
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder={t("invitePlaceholder")}
            />
          </label>
          <button className="btn ghost" type="submit">
            {t("invite")}
          </button>
          {inviteNote ? <p className="sent-note">{inviteNote}</p> : null}
          <ul className="cohost-list">
            {members.map((m) => (
              <li key={m.accountId}>
                {t("memberLine", { name: m.name, role: m.role === "owner" ? t("roleOwner") : t("roleCohost") })}
              </li>
            ))}
            {pending.map((p) => (
              <li key={p.email}>{t("pendingLine", { email: p.email })}</li>
            ))}
          </ul>
        </form>
      ) : null}
    </div>
  );
}

function panelLabel(panel: PanelId, t: Translate): string {
  if (panel === "lower-third") return t("panelLowerThird");
  if (panel === "destinations") return t("panelDestinations");
  if (panel === "settings") return t("panelSettings");
  if (panel === "recordings") return t("panelRecordings");
  return t("panelChat");
}

function panelTitle(panel: PanelId, t: Translate): string {
  return panelLabel(panel, t);
}

function chatSourceLabel(source: string): string {
  if (source === "studio") return "IN";
  if (source === "youtube") return "YT";
  if (source === "twitch") return "TW";
  if (source === "kick") return "KI";
  if (source === "linkedin") return "in";
  if (source === "x") return "X";
  return source.slice(0, 2).toUpperCase();
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

function mergeStudio(
  prev: StudioView | null,
  next: PublicStudio,
  viewerRole: StudioView["viewerRole"],
): StudioView {
  const merged: StudioView = { ...next, viewerRole };
  if (!prev) return merged;
  return {
    ...merged,
    destinations: next.destinations.map((d) => {
      const old = prev.destinations.find((x) => x.id === d.id);
      return { ...d, url: d.url || old?.url };
    }),
  };
}

function localIsoStreams(
  room: Room,
  originalVideo: MediaStreamTrack | null,
  originalAudio: MediaStreamTrack | null,
): { camera: MediaStream | null; screen: MediaStream | null } {
  const camera = new MediaStream();
  const video =
    originalVideo ?? room.localParticipant.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack ?? null;
  const audio =
    originalAudio ?? room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack ?? null;
  if (video && video.readyState === "live") camera.addTrack(video);
  if (audio && audio.readyState === "live") camera.addTrack(audio);
  const screen = new MediaStream();
  const share = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack ?? null;
  const shareAudio =
    room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track?.mediaStreamTrack ?? null;
  if (share && share.readyState === "live") screen.addTrack(share);
  if (shareAudio && shareAudio.readyState === "live") screen.addTrack(shareAudio);
  return {
    camera: camera.getTracks().length ? camera : null,
    screen: screen.getTracks().length ? screen : null,
  };
}

function ChatIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function RadioIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M16.247 7.761a6 6 0 0 1 0 8.478" />
      <path d="M19.075 4.933a10 10 0 0 1 0 14.134" />
      <path d="M4.925 19.067a10 10 0 0 1 0-14.134" />
      <path d="M7.753 16.239a6 6 0 0 1 0-8.478" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

function TypeIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M12 4v16" />
      <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" />
      <path d="M9 20h6" />
    </svg>
  );
}

function RecordingsIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <rect x="3" y="5" width="18" height="14" rx="2" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M14 17H5" />
      <path d="M19 7h-9" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </svg>
  );
}

