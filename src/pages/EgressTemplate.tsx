import { useEffect, useRef } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import { pickComposeBackend, VERT_H, VERT_W } from "../lib/compositor";
import { startProgramCompose, type ProgramCompose } from "../lib/program-compose";
import { getStudio, sendEgressBeat } from "../lib/api";
import { startLiveProgramBuffer } from "../lib/live-program-buffer";
import { CaptionTracker } from "../lib/caption-overlay";
import { egressLayoutMode, isPortraitLayout, shouldWriteLiveBuffer } from "../lib/egress-layout";
import { HEARTBEAT_BEAT_MS } from "../../worker/egress";
import type { LayoutMode } from "../lib/wasm";

/**
 * Headless compositor. LiveKit Egress Chrome loads this URL and waits for
 * console.log("START_RECORDING") before capturing the tab to RTMP + file.
 *
 * Audio tracks are attached unmuted so tab capture includes program sound.
 * Video is composed on a Worker + OffscreenCanvas when the browser allows it.
 */
export function EgressTemplate() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const q = new URLSearchParams(location.search);
    const url = q.get("url");
    const token = q.get("token");
    const initialLayout = (q.get("layout") || "grid").toLowerCase();
    const portrait = isPortraitLayout(initialLayout);
    const writesLiveBuffer = shouldWriteLiveBuffer(initialLayout);
    const layout: LayoutMode = egressLayoutMode(initialLayout);
    const outW = portrait ? VERT_W : 1280;
    const outH = portrait ? VERT_H : 720;
    canvas.width = outW;
    canvas.height = outH;
    const backend = pickComposeBackend();
    const room = new Room({ adaptiveStream: false, dynacast: false });
    const audios: HTMLMediaElement[] = [];
    const videoEls: HTMLVideoElement[] = [];
    let compose: ProgramCompose | null = null;
    let liveBuffer: { stop: () => void; addAudio: (el: HTMLMediaElement) => void } | null = null;
    let cancelled = false;

    const attach = (track: Track) => {
      if (!compose) return;
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach() as HTMLMediaElement;
        el.autoplay = true;
        el.muted = false;
        (el as HTMLAudioElement).volume = 1;
        el.style.position = "absolute";
        el.style.width = "0";
        el.style.height = "0";
        el.style.opacity = "0";
        document.body.appendChild(el);
        audios.push(el);
        liveBuffer?.addAudio(el);
        void el.play().catch(() => undefined);
        return;
      }
      if (track.kind !== Track.Kind.Video) return;
      const id = track.sid ?? track.mediaStreamTrack.id;
      if (compose.thread === "worker") {
        compose.addSource(id, track.mediaStreamTrack);
        return;
      }
      const el = track.attach() as HTMLVideoElement;
      el.autoplay = true;
      el.playsInline = true;
      el.muted = true;
      el.width = 640;
      el.height = 360;
      el.style.position = "absolute";
      el.style.left = "-9999px";
      document.body.appendChild(el);
      videoEls.push(el);
      compose.addSource(id, el);
    };

    const detach = (track: Track) => {
      compose?.removeSource(track.sid ?? track.mediaStreamTrack.id);
      track.detach().forEach((el) => el.remove());
    };

    const fromToken = templateFromToken(token);
    const studioId = fromToken.room;
    const egressId = q.get("egressId") || fromToken.egressId;

    void (async () => {
      compose = await startProgramCompose({
        canvas,
        backend,
        mode: layout,
        title: "Casthop",
        subtitle: "live",
        width: outW,
        height: outH,
      });
      if (cancelled) {
        compose.stop();
        return;
      }
      room.on(RoomEvent.TrackSubscribed, (track) => attach(track));
      room.on(RoomEvent.TrackUnsubscribed, (track) => detach(track));
      const signalReady = () => console.log("START_RECORDING");
      if (url && token) {
        void room.connect(url, token).then(signalReady).then(() => {
          if (!cancelled && studioId && writesLiveBuffer) {
            liveBuffer = startLiveProgramBuffer({ canvas, audios, studioId, token });
          }
        }).catch((err) => {
          console.error("egress template connect", err);
        });
      } else {
        signalReady();
      }
    })();

    const captions = new CaptionTracker();
    const pullMeta = () => {
      if (!studioId) return;
      void getStudio(studioId).then((s) => {
        const next: LayoutMode = portrait
          ? "portrait"
          : s.layout === "solo" || s.layout === "side" || s.layout === "screen"
            ? s.layout
            : "grid";
        compose?.setMeta(
          next,
          s.bannerTitle || s.title || "Casthop",
          s.bannerSubtitle || "live",
          s.pinnedChat ? { name: s.pinnedChat.name, text: s.pinnedChat.text } : null,
          captions.view(s.captions, s.captionLine, Date.now()),
        );
      });
      if (token && egressId) void sendEgressBeat(studioId, token, egressId).catch(() => undefined);
    };
    pullMeta();
    const metaTimer = window.setInterval(pullMeta, HEARTBEAT_BEAT_MS);

    return () => {
      cancelled = true;
      window.clearInterval(metaTimer);
      liveBuffer?.stop();
      compose?.stop();
      room.disconnect();
      videoEls.forEach((v) => v.remove());
      audios.forEach((a) => a.remove());
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={1280}
      height={720}
      style={{
        margin: 0,
        width: "100vw",
        height: "100vh",
        background: "#0b0b0d",
        display: "block",
      }}
    />
  );
}

function templateFromToken(token: string | null): { room: string | null; egressId: string | null } {
  if (!token) return { room: null, egressId: null };
  try {
    const payload = token.split(".")[1];
    if (!payload) return { room: null, egressId: null };
    const json = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as {
      sub?: unknown;
      video?: { room?: unknown };
    };
    const room = typeof json.video?.room === "string" ? json.video.room : null;
    const egressId = typeof json.sub === "string" && json.sub ? json.sub : null;
    return { room, egressId };
  } catch {
    return { room: null, egressId: null };
  }
}
