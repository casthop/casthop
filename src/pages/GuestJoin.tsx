import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Aperture, Check, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { Logo } from "../components/Logo";
import { getHealth, getStudio, mintToken } from "../lib/api";
import { loadBlurPref, saveBlurPref } from "../lib/blur-prefs";
import { startCameraBlur, type CameraBlurHandle } from "../lib/camera-blur";
import { attachWorkletMeter } from "../lib/effects";
import { listDevices, openUserMedia, type DeviceSet } from "../lib/media";
import { saveSession } from "../lib/session";
import { LocalPreview } from "../components/VideoTile";

export function GuestJoin() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [title, setTitle] = useState("Weekly product update");
  const [name, setName] = useState("Guest");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<DeviceSet>({ cameras: [], mics: [], speakers: [] });
  const [cameraId, setCameraId] = useState("");
  const [micId, setMicId] = useState("");
  const [speakerId, setSpeakerId] = useState("");
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [blurOn, setBlurOn] = useState(false);
  const [level, setLevel] = useState(0);
  const [camOk, setCamOk] = useState(false);
  const [micOk, setMicOk] = useState(false);
  const [net, setNet] = useState("Checking");
  const [resLabel, setResLabel] = useState("—");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getStudio(id)
      .then((s) => setTitle(s.title))
      .catch(() => undefined);
    getHealth()
      .then((h) => setNet(h.livekit.ok ? "Good" : "LiveKit down"))
      .catch(() => setNet("Unreachable"));
  }, [id]);

  useEffect(() => {
    setBlurOn(loadBlurPref(cameraId));
  }, [cameraId]);

  useEffect(() => {
    let stopMeter = () => undefined;
    let cancelled = false;
    let blurHandle: CameraBlurHandle | null = null;
    let media: MediaStream | null = null;
    (async () => {
      media = await openUserMedia({ cameraId: cameraId || undefined, micId: micId || undefined });
      if (cancelled) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      let preview: MediaStream = media;
      if (blurOn) {
        const videoTrack = media.getVideoTracks()[0];
        if (videoTrack) {
          try {
            blurHandle = await startCameraBlur(videoTrack);
            preview = new MediaStream([blurHandle.track, ...media.getAudioTracks()]);
          } catch (err) {
            console.warn("casthop blur", err);
          }
        }
      }
      if (cancelled) {
        blurHandle?.stop();
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      setStream(preview);
      const video = media.getVideoTracks()[0];
      const settings = video?.getSettings();
      setCamOk(Boolean(video));
      setResLabel(settings?.height ? `${settings.height}p` : "720p");
      const audio = media.getAudioTracks()[0];
      setMicOk(Boolean(audio));
      const meter = await attachWorkletMeter(media);
      if (cancelled) {
        meter.stop();
        return;
      }
      const timer = window.setInterval(() => setLevel(meter.getLevel()), 80);
      stopMeter = () => {
        meter.stop();
        window.clearInterval(timer);
      };
      const listed = await listDevices();
      setDevices(listed);
      setCameraId((cur) => cur || listed.cameras[0]?.deviceId || "");
      setMicId((cur) => cur || listed.mics[0]?.deviceId || "");
      setSpeakerId((cur) => cur || listed.speakers[0]?.deviceId || "");
    })();
    return () => {
      cancelled = true;
      blurHandle?.stop();
      stopMeter();
      media?.getTracks().forEach((t) => t.stop());
    };
  }, [cameraId, micId, blurOn]);

  useEffect(() => {
    stream?.getVideoTracks().forEach((t) => {
      t.enabled = camOn;
    });
    stream?.getAudioTracks().forEach((t) => {
      t.enabled = micOn;
    });
  }, [camOn, micOn, stream]);

  const bars = useMemo(() => Math.max(1, Math.round(level * 5)), [level]);

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const token = await mintToken(id, { name: name.trim() || "Guest", role: "guest" });
      saveSession({
        studioId: id,
        identity: token.identity,
        name: token.name,
        role: "guest",
        guestSecret: token.guestSecret,
        cameraId,
        micId,
      });
      stream?.getTracks().forEach((t) => t.stop());
      navigate(`/studio/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="guest">
      <header className="guest-top">
        <Logo dark />
        <div className="invited">
          Invited to <strong>{title}</strong>
        </div>
      </header>
      <div className="guest-grid">
        <div>
          <div className="cam-frame">
            <span className="cam-chip">Camera preview</span>
            <LocalPreview stream={stream} />
            <div className="cam-tools">
              <button type="button" aria-label={micOn ? "Mute microphone" : "Unmute microphone"} onClick={() => setMicOn((v) => !v)}>
                {micOn ? <Mic size={16} /> : <MicOff size={16} />}
              </button>
              <button type="button" aria-label={camOn ? "Turn camera off" : "Turn camera on"} onClick={() => setCamOn((v) => !v)}>
                {camOn ? <Video size={16} /> : <VideoOff size={16} />}
              </button>
              <button
                type="button"
                className={blurOn ? "on" : undefined}
                aria-label="Background blur"
                aria-pressed={blurOn}
                onClick={() => {
                  const next = !blurOn;
                  saveBlurPref(cameraId, next);
                  setBlurOn(next);
                }}
              >
                <Aperture size={16} />
              </button>
            </div>
            <div className="levels" aria-hidden="true">
              {"▮".repeat(bars)}
              {"▯".repeat(5 - bars)}
            </div>
          </div>
          <div className="device-row">
            <label>
              Camera
              <select value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
                {(devices.cameras.length ? devices.cameras : [{ deviceId: "", label: "Built-in camera" }]).map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || "Built-in camera"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Microphone
              <select value={micId} onChange={(e) => setMicId(e.target.value)}>
                {(devices.mics.length ? devices.mics : [{ deviceId: "", label: "Default microphone" }]).map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || "Default microphone"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Speaker
              <select value={speakerId} onChange={(e) => setSpeakerId(e.target.value)}>
                {(devices.speakers.length ? devices.speakers : [{ deviceId: "", label: "Default output" }]).map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || "Default output"}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <form onSubmit={onJoin}>
          <div className="badge-soft">Guest invite</div>
          <h1>Join the studio</h1>
          <p className="sub">No download or account needed. You’ll wait backstage until the host brings you on stage.</p>
          <label className="field">
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </label>
          <div className="checks">
            <div className="check">
              <Check className="markok" size={18} />
              <span>Camera working</span>
              <span className="val">{camOk ? resLabel : "No camera"}</span>
            </div>
            <div className="check">
              <Check className="markok" size={18} />
              <span>Microphone picking up audio</span>
              <span className="val">{micOk ? "Test sound" : "No mic"}</span>
            </div>
            <div className="check">
              <Check className="markok" size={18} />
              <span>Connection check</span>
              <span className="val">{net}</span>
            </div>
          </div>
          <button className="btn primary wide" type="submit" disabled={busy}>
            {busy ? "Joining…" : "Join backstage"}
          </button>
          {error ? <p className="err">{error}</p> : null}
          <p className="footnote">Runs in your browser · Works on desktop and mobile</p>
        </form>
      </div>
    </div>
  );
}
