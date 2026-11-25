import { useEffect, useRef } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import { composeFrame, pickComposeBackend, type ComposeBackend } from "../lib/compositor";
import type { LayoutMode } from "../lib/wasm";

/**
 * Headless compositor. LiveKit Egress Chrome loads this URL and waits for
 * console.log("START_RECORDING") before capturing the tab to RTMP + file.
 *
 * Layout math is always Rust/WASM. Pixel blit prefers WebGPU, then Canvas2D,
 * then the WASM CPU compositor (`?compose=wasm`).
 */
export function EgressTemplate() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videosRef = useRef<HTMLVideoElement[]>([]);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const url = q.get("url");
    const token = q.get("token");
    const layout = (q.get("layout") || "grid") as LayoutMode;
    const backend: ComposeBackend = pickComposeBackend();
    const room = new Room({ adaptiveStream: false, dynacast: false });
    const videos: HTMLVideoElement[] = [];
    videosRef.current = videos;

    const attach = (track: Track) => {
      if (track.kind !== Track.Kind.Video) return;
      const el = track.attach() as HTMLVideoElement;
      el.autoplay = true;
      el.playsInline = true;
      el.muted = true;
      el.width = 640;
      el.height = 360;
      el.style.position = "absolute";
      el.style.left = "-9999px";
      document.body.appendChild(el);
      videos.push(el);
    };
    room.on(RoomEvent.TrackSubscribed, (track) => attach(track));
    console.log("START_RECORDING");
    if (url && token) {
      void room.connect(url, token).catch((err) => {
        console.error("egress template connect", err);
      });
    }

    let raf = 0;
    let busy = false;
    const tick = () => {
      const canvas = canvasRef.current;
      if (canvas && !busy) {
        busy = true;
        void composeFrame({
          backend,
          videos: videos.filter((v) => v.videoWidth > 0),
          mode: layout === "solo" || layout === "side" || layout === "screen" ? layout : "grid",
          title: q.get("title") || "Casthop",
          subtitle: q.get("subtitle") || "live",
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
      room.disconnect();
      videos.forEach((v) => v.remove());
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
