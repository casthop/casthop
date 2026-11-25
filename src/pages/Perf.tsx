import { useEffect, useRef, useState } from "react";
import { pickComposeBackend } from "../lib/compositor";
import { percentile } from "../lib/compose-support";
import { startProgramCompose } from "../lib/program-compose";

const COLORS = ["#6d64f7", "#f59e0b", "#22c55e", "#38bdf8", "#f43f5e", "#a3e635"];

function makeTiles(count: number): { tracks: MediaStreamTrack[]; stop: () => void } {
  const canvases = Array.from({ length: count }, () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    return canvas;
  });
  const ctxs = canvases.map((c) => c.getContext("2d")!);
  let t = 0;
  let raf = 0;
  const draw = () => {
    t += 1;
    ctxs.forEach((ctx, i) => {
      ctx.fillStyle = COLORS[i % COLORS.length]!;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = "#0b0b0d";
      ctx.fillRect((t * (8 + i) + i * 40) % 560, 160, 80, 40);
      ctx.fillStyle = "#f3f4f6";
      ctx.font = "64px sans-serif";
      ctx.fillText(String(i + 1), 40, 90);
    });
    raf = requestAnimationFrame(draw);
  };
  draw();
  const streams = canvases.map((c) => c.captureStream(30));
  const tracks = streams.map((s) => {
    const track = s.getVideoTracks()[0];
    if (!track) throw new Error("captureStream failed");
    return track;
  });
  return {
    tracks,
    stop: () => {
      cancelAnimationFrame(raf);
      tracks.forEach((track) => track.stop());
      streams.forEach((s) => s.getTracks().forEach((tr) => tr.stop()));
    },
  };
}

export function Perf() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tapRef = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState("starting");

  useEffect(() => {
    const canvas = canvasRef.current;
    const tap = tapRef.current;
    if (!canvas || !tap) return;
    const q = new URLSearchParams(location.search);
    const tiles = Math.max(4, Math.min(6, Number(q.get("tiles") || 6) || 6));
    const seconds = Math.max(5, Math.min(60, Number(q.get("seconds") || 30) || 30));
    const backend = pickComposeBackend();
    const stops: Array<() => void> = [];
    const longTasks: number[] = [];
    const clicks: number[] = [];
    let stopped = false;

    window.__PERF__ = undefined;
    window.__PERF_RUNNING__ = { tiles, seconds, backend };

    const longObs = observe("longtask", (entry) => {
      longTasks.push(entry.duration);
    });
    const onClick = (ev: MouseEvent) => {
      const start = ev.timeStamp;
      requestAnimationFrame(() => {
        clicks.push(performance.now() - start);
      });
    };
    tap.addEventListener("click", onClick);

    void (async () => {
      const compose = await startProgramCompose({
        canvas,
        backend,
        mode: "grid",
        title: "Casthop",
        subtitle: "perf overlay",
      });
      if (stopped) {
        compose.stop();
        return;
      }
      const pack = makeTiles(tiles);
      stops.push(pack.stop);
      pack.tracks.forEach((track, i) => compose.addSource(`tile-${i}`, track));
      setStatus(`running · ${compose.thread} · ${tiles} tiles`);
      window.__PERF_RUNNING__ = { tiles, seconds, backend, thread: compose.thread };

      await sleep(seconds * 1000);
      if (stopped) {
        compose.stop();
        return;
      }
      const snap = await compose.snapshot();
      compose.stop();
      const skip = Math.min(90, Math.floor(snap.frameMs.length / 5));
      const frameMs = snap.frameMs.slice(skip);
      const result = {
        p50FrameMs: percentile(frameMs, 50),
        p95FrameMs: percentile(frameMs, 95),
        droppedFrames: snap.dropped,
        longTaskCount: longTasks.length,
        longTaskTotalMs: longTasks.reduce((a, b) => a + b, 0),
        inputLatencyP95Ms: percentile(clicks, 95),
        frames: snap.frames,
        thread: snap.thread,
        backend: snap.backend,
        tiles,
        seconds,
        inputClicks: clicks.length,
      };
      window.__PERF__ = result;
      setStatus("done");
    })().catch((err) => {
      setStatus(String(err));
      window.__PERF__ = { error: String(err) };
    });

    return () => {
      stopped = true;
      tap.removeEventListener("click", onClick);
      longObs?.disconnect();
      stops.forEach((stop) => stop());
    };
  }, []);

  return (
    <div style={{ background: "#121316", color: "#f3f4f6", minHeight: "100dvh", fontFamily: "Public Sans, sans-serif" }}>
      <canvas ref={canvasRef} width={1280} height={720} style={{ width: "100%", maxWidth: 1280, display: "block", background: "#0b0b0d" }} />
      <div style={{ padding: 24 }}>
        <button ref={tapRef} id="perf-tap" type="button" className="btn primary">
          Tap
        </button>
        <p id="perf-status">{status}</p>
      </div>
    </div>
  );
}

function observe(type: string, onEntry: (entry: PerformanceEntry) => void): PerformanceObserver | null {
  try {
    const obs = new PerformanceObserver((list) => {
      list.getEntries().forEach(onEntry);
    });
    obs.observe({ type, buffered: true });
    return obs;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
