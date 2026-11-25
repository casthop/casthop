export type DeviceSet = {
  cameras: MediaDeviceInfo[];
  mics: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
};

export async function listDevices(): Promise<DeviceSet> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    cameras: devices.filter((d) => d.kind === "videoinput"),
    mics: devices.filter((d) => d.kind === "audioinput"),
    speakers: devices.filter((d) => d.kind === "audiooutput"),
  };
}

export function silentAudioTrack(): MediaStreamTrack {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.0002;
  osc.connect(gain).connect(dest);
  osc.start();
  return dest.stream.getAudioTracks()[0]!;
}

export function placeholderStream(name: string, hue: number): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 540;
  const ctx = canvas.getContext("2d")!;
  let t = 0;
  const draw = () => {
    t += 1;
    const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    g.addColorStop(0, `hsl(${hue} 16% ${26 + Math.sin(t / 50) * 3}%)`);
    g.addColorStop(1, `hsl(${(hue + 36) % 360} 20% 16%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2 - 18, 72, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(canvas.width / 2, canvas.height / 2 + 130, 110, 80, 0, Math.PI, 0, true);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "600 22px 'Public Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(name, canvas.width / 2, canvas.height - 36);
    requestAnimationFrame(draw);
  };
  draw();
  const video = canvas.captureStream(15);
  return new MediaStream([...video.getVideoTracks(), silentAudioTrack()]);
}

export async function openUserMedia(opts: { cameraId?: string; micId?: string }): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: opts.micId ? { deviceId: { exact: opts.micId } } : true,
      video: opts.cameraId
        ? { deviceId: { exact: opts.cameraId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch {
    return placeholderStream("Camera", 220);
  }
}

export function meterLevel(stream: MediaStream): { getLevel: () => number; stop: () => void } {
  const audio = stream.getAudioTracks()[0];
  if (!audio) return { getLevel: () => 0, stop: () => undefined };
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(new MediaStream([audio]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  return {
    getLevel: () => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (const v of data) sum += v;
      return Math.min(1, sum / data.length / 48);
    },
    stop: () => {
      void ctx.close();
    },
  };
}

export function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) % 360;
  return h;
}
