import { useEffect, useRef, useState } from "react";
import { LocalVideoTrack, Room, RoomEvent, Track, VideoPresets } from "livekit-client";
import { getMe, mintToken } from "../lib/api";

export function Probe() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [log, setLog] = useState("connecting…");

  useEffect(() => {
    let cancelled = false;
    const rooms: Room[] = [];
    (async () => {
      const signedIn = await getMe().catch(() => null);
      if (!signedIn) {
        if (!import.meta.env.DEV) throw new Error("sign in required for probe");
        const magic = (await fetch("/api/auth/magic-link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email: "probe@example.com" }),
        }).then((r) => r.json())) as { devLogin?: string };
        if (magic.devLogin) {
          await fetch(magic.devLogin, { method: "POST", credentials: "same-origin" });
        }
      }
      const created = (await fetch("/api/studios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ title: "Latency probe" }),
      }).then((r) => r.json())) as { id: string; error?: string };
      if (!created.id) throw new Error(created.error || "sign in required for probe");
      const pubTok = await mintToken(created.id, { name: "ProbePub", role: "host" });
      const subTok = await mintToken(created.id, { name: "ProbeSub", role: "guest" });
      if (cancelled) return;
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;
      const draw = (flash: boolean) => {
        ctx.fillStyle = flash ? "#ffffff" : "#1a2744";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = flash ? "#111" : "#fff";
        ctx.font = "42px sans-serif";
        ctx.fillText(flash ? "FLASH" : new Date().toISOString().slice(11, 23), 36, 200);
      };
      draw(false);
      const stream = canvas.captureStream(30);

      const pub = new Room({ adaptiveStream: false, dynacast: false, videoCaptureDefaults: { resolution: VideoPresets.h720 } });
      const sub = new Room({ adaptiveStream: false, dynacast: false });
      rooms.push(pub, sub);
      sub.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Video) track.attach(videoRef.current!);
      });
      await pub.connect(pubTok.url, pubTok.token);
      await sub.connect(subTok.url, subTok.token);
      const lv = new LocalVideoTrack(stream.getVideoTracks()[0]!);
      await pub.localParticipant.publishTrack(lv, { simulcast: true });

      const samples: number[] = [];
      let flashAt = 0;
      const probe = document.createElement("canvas");
      probe.width = 64;
      probe.height = 36;
      const pctx = probe.getContext("2d", { willReadFrequently: true })!;
      const flasher = window.setInterval(() => {
        flashAt = performance.now();
        draw(true);
        window.setTimeout(() => draw(false), 180);
      }, 2500);
      const loop = () => {
        const video = videoRef.current;
        if (video && video.videoWidth) {
          pctx.drawImage(video, 0, 0, probe.width, probe.height);
          const pix = pctx.getImageData(8, 8, 1, 1).data;
          const lum = (pix[0] + pix[1] + pix[2]) / 3;
          if (lum > 180 && flashAt) {
            samples.push(performance.now() - flashAt);
            flashAt = 0;
            const sorted = [...samples].sort((a, b) => a - b);
            const p50 = sorted[Math.floor(sorted.length * 0.5)];
            setLog(`SFU hop samples=${samples.length} last=${samples.at(-1)?.toFixed(0)}ms p50=${p50?.toFixed(0)}ms`);
          }
        }
        if (!cancelled) requestAnimationFrame(loop);
      };
      loop();
      return () => window.clearInterval(flasher);
    })().catch((err) => setLog(String(err)));
    return () => {
      cancelled = true;
      rooms.forEach((r) => r.disconnect());
    };
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: "Public Sans, sans-serif", background: "#121316", minHeight: "100dvh" }}>
      <h1>Latency probe</h1>
      <p>{log}</p>
      <canvas ref={canvasRef} width={640} height={360} />
      <video ref={videoRef} autoPlay playsInline muted width={320} height={180} />
    </div>
  );
}
