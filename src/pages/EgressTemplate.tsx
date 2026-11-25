import { useEffect, useRef } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import { composeFrame, pickComposeBackend, type ComposeBackend } from "../lib/compositor";
import { getStudio } from "../lib/api";
import type { LayoutMode } from "../lib/wasm";

/**
 * Headless compositor. LiveKit Egress Chrome loads this URL and waits for
 * console.log("START_RECORDING") before capturing the tab to RTMP + file.
 *
 * Audio tracks are attached unmuted so tab capture includes program sound.
 */
export function EgressTemplate() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videosRef = useRef<HTMLVideoElement[]>([]);
  const layoutRef = useRef<LayoutMode>("grid");
  const titleRef = useRef("Casthop");
  const subtitleRef = useRef("live");

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const url = q.get("url");
    const token = q.get("token");
    const initialLayout = (q.get("layout") || "grid") as LayoutMode;
    layoutRef.current = initialLayout === "solo" || initialLayout === "side" || initialLayout === "screen" ? initialLayout : "grid";
    const backend: ComposeBackend = pickComposeBackend();
    const room = new Room({ adaptiveStream: false, dynacast: false });
    const videos: HTMLVideoElement[] = [];
    const audios: HTMLMediaElement[] = [];
    videosRef.current = videos;

    const attach = (track: Track) => {
      const el = track.attach() as HTMLMediaElement;
      el.autoplay = true;
      if (track.kind === Track.Kind.Audio) {
        el.muted = false;
        (el as HTMLAudioElement).volume = 1;
        el.style.position = "absolute";
        el.style.width = "0";
        el.style.height = "0";
        el.style.opacity = "0";
        document.body.appendChild(el);
        audios.push(el);
        void el.play().catch(() => undefined);
        return;
      }
      if (track.kind !== Track.Kind.Video) return;
      const video = el as HTMLVideoElement;
      video.playsInline = true;
      video.muted = true;
      video.width = 640;
      video.height = 360;
      video.style.position = "absolute";
      video.style.left = "-9999px";
      document.body.appendChild(video);
      videos.push(video);
    };

    const detach = (track: Track) => {
      track.detach().forEach((el) => el.remove());
    };

    room.on(RoomEvent.TrackSubscribed, (track) => attach(track));
    room.on(RoomEvent.TrackUnsubscribed, (track) => detach(track));
    console.log("START_RECORDING");
    if (url && token) {
      void room.connect(url, token).catch((err) => {
        console.error("egress template connect", err);
      });
    }

    const studioId = roomFromToken(token);
    const pullMeta = () => {
      if (!studioId) return;
      void getStudio(studioId).then((s) => {
        layoutRef.current = s.layout === "solo" || s.layout === "side" || s.layout === "screen" ? s.layout : "grid";
        titleRef.current = s.bannerTitle || s.title || "Casthop";
        subtitleRef.current = s.bannerSubtitle || "live";
      });
    };
    pullMeta();
    const metaTimer = window.setInterval(pullMeta, 2000);

    let raf = 0;
    let busy = false;
    const tick = () => {
      const canvas = canvasRef.current;
      if (canvas && !busy) {
        busy = true;
        void composeFrame({
          backend,
          videos: videos.filter((v) => v.videoWidth > 0),
          mode: layoutRef.current,
          title: titleRef.current,
          subtitle: subtitleRef.current,
          canvas,
        }).finally(() => {
          busy = false;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(metaTimer);
      room.disconnect();
      videos.forEach((v) => v.remove());
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

function roomFromToken(token: string | null): string | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as { video?: { room?: string } };
    return json.video?.room ?? null;
  } catch {
    return null;
  }
}
