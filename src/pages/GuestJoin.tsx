import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Aperture, AudioLines, Check, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { Logo } from "../components/Logo";
import { LanguageSwitcher, useI18n, type MessageKey } from "../i18n";
import { getHealth, getStudio, mintToken } from "../lib/api";
import { copyBlurPref, loadBlurPref, saveBlurPrefPair } from "../lib/blur-prefs";
import { startCameraBlur, type CameraBlurHandle } from "../lib/camera-blur";
import { copyDenoisePref, loadDenoisePref, saveDenoisePrefPair } from "../lib/denoise-prefs";
import { attachWorkletMeter } from "../lib/effects";
import { fxBackendForDenoise } from "../lib/fx";
import { listDevices, openUserMedia, type DeviceSet } from "../lib/media";
import { saveSession } from "../lib/session";
import { LocalPreview } from "../components/VideoTile";

function InvitedLabel({ template, title }: { template: string; title: string }) {
  const at = title ? template.indexOf(title) : -1;
  if (at < 0) return <>{template}</>;
  return (
    <>
      {template.slice(0, at)}
      <strong>{title}</strong>
      {template.slice(at + title.length)}
    </>
  );
}

type NetStatus = "checking" | "good" | "down" | "unreachable";

const NET_KEY: Record<NetStatus, MessageKey> = {
  checking: "guestNetChecking",
  good: "guestNetGood",
  down: "guestNetDown",
  unreachable: "guestNetUnreachable",
};

export function GuestJoin() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<DeviceSet>({ cameras: [], mics: [], speakers: [] });
  const [cameraId, setCameraId] = useState("");
  const [micId, setMicId] = useState("");
  const [speakerId, setSpeakerId] = useState("");
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [blurOn, setBlurOn] = useState(false);
  const [denoiseOn, setDenoiseOn] = useState(true);
  const [level, setLevel] = useState(0);
  const [camOk, setCamOk] = useState(false);
  const [micOk, setMicOk] = useState(false);
  const [net, setNet] = useState<NetStatus>("checking");
  const [resLabel, setResLabel] = useState("—");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Canvas preview tracks have no deviceId; keep the real camera's.
  const rawCameraIdRef = useRef("");
  const rawMicIdRef = useRef("");

  const nameValue = name ?? t("guestDefaultName");
  const studioTitle = title || t("homeDefaultTitle");

  useEffect(() => {
    getStudio(id)
      .then((s) => {
        setTitle(s.title);
        if (s.viewerRole === "owner" || s.viewerRole === "cohost") navigate(`/studio/${id}`);
      })
      .catch(() => undefined);
    getHealth()
      .then((h) => setNet(h.livekit.ok ? "good" : "down"))
      .catch(() => setNet("unreachable"));
  }, [id, navigate]);

  useEffect(() => {
    if (cameraId) copyBlurPref("", cameraId);
    setBlurOn(loadBlurPref(cameraId));
  }, [cameraId]);

  useEffect(() => {
    if (micId) copyDenoisePref("", micId);
    setDenoiseOn(loadDenoisePref(micId));
  }, [micId]);

  useEffect(() => {
    let stopMeter = () => undefined;
    let cancelled = false;
    let blurHandle: CameraBlurHandle | null = null;
    let media: MediaStream | null = null;
    (async () => {
      media = await openUserMedia({ cameraId: cameraId || undefined, micId: micId || undefined });
      if (cancelled) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      let preview: MediaStream = media;
      const videoTrack = media.getVideoTracks()[0];
      const rawId = videoTrack?.getSettings().deviceId ?? "";
      if (rawId) rawCameraIdRef.current = rawId;
      const rawMic = media.getAudioTracks()[0]?.getSettings().deviceId ?? "";
      if (rawMic) rawMicIdRef.current = rawMic;
      if (blurOn && videoTrack) {
        try {
          blurHandle = await startCameraBlur(videoTrack);
          preview = new MediaStream([blurHandle.track, ...media.getAudioTracks()]);
        } catch (err) {
          console.warn("casthop blur", err);
        }
      }
      if (cancelled) {
        blurHandle?.stop();
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      setStream(preview);
      const settings = videoTrack?.getSettings();
      setCamOk(Boolean(videoTrack));
      setResLabel(settings?.height ? `${settings.height}p` : "720p");
      const audio = media.getAudioTracks()[0];
      setMicOk(Boolean(audio));
      const meter = await attachWorkletMeter(media, fxBackendForDenoise(denoiseOn));
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
      media?.getTracks().forEach((track) => track.stop());
    };
  }, [cameraId, micId, blurOn, denoiseOn]);

  useEffect(() => {
    stream?.getVideoTracks().forEach((track) => {
      track.enabled = camOn;
    });
    stream?.getAudioTracks().forEach((track) => {
      track.enabled = micOn;
    });
  }, [camOn, micOn, stream]);

  const bars = useMemo(() => Math.max(1, Math.round(level * 5)), [level]);

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const token = await mintToken(id, { name: nameValue.trim() || t("guestDefaultName"), role: "guest" });
      saveSession({
        studioId: id,
        identity: token.identity,
        name: token.name,
        role: "guest",
        guestSecret: token.guestSecret,
        cameraId,
        micId,
      });
      stream?.getTracks().forEach((track) => track.stop());
      navigate(`/studio/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("guestJoinFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="guest">
      <header className="guest-top">
        <Logo dark />
        <div className="guest-top-end">
          <div className="invited">
            <InvitedLabel template={t("guestInvitedTo", { title: studioTitle })} title={studioTitle} />
          </div>
          <LanguageSwitcher tone="light" />
        </div>
      </header>
      <div className="guest-grid">
        <div>
          <div className="cam-frame">
            <span className="cam-chip">{t("guestCameraPreview")}</span>
            <LocalPreview stream={stream} />
            <div className="cam-tools">
              <button type="button" aria-label={micOn ? t("guestMuteMic") : t("guestUnmuteMic")} onClick={() => setMicOn((v) => !v)}>
                {micOn ? <Mic size={16} /> : <MicOff size={16} />}
              </button>
              <button
                type="button"
                className={denoiseOn ? "on" : undefined}
                aria-label={t("guestNoiseRemoval")}
                aria-pressed={denoiseOn}
                onClick={() => {
                  const next = !denoiseOn;
                  saveDenoisePrefPair(micId, rawMicIdRef.current, next);
                  setDenoiseOn(next);
                }}
              >
                <AudioLines size={16} />
              </button>
              <button type="button" aria-label={camOn ? t("guestCamOff") : t("guestCamOn")} onClick={() => setCamOn((v) => !v)}>
                {camOn ? <Video size={16} /> : <VideoOff size={16} />}
              </button>
              <button
                type="button"
                className={blurOn ? "on" : undefined}
                aria-label={t("guestBlur")}
                aria-pressed={blurOn}
                onClick={() => {
                  const next = !blurOn;
                  saveBlurPrefPair(cameraId, rawCameraIdRef.current, next);
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
              {t("guestCamera")}
              <select value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
                {(devices.cameras.length ? devices.cameras : [{ deviceId: "", label: t("guestBuiltinCamera") }]).map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || t("guestBuiltinCamera")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("guestMicrophone")}
              <select value={micId} onChange={(e) => setMicId(e.target.value)}>
                {(devices.mics.length ? devices.mics : [{ deviceId: "", label: t("guestDefaultMic") }]).map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || t("guestDefaultMic")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("guestSpeaker")}
              <select value={speakerId} onChange={(e) => setSpeakerId(e.target.value)}>
                {(devices.speakers.length ? devices.speakers : [{ deviceId: "", label: t("guestDefaultOutput") }]).map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || t("guestDefaultOutput")}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <form onSubmit={onJoin}>
          <div className="badge-soft">{t("guestInviteBadge")}</div>
          <h1>{t("guestJoinTitle")}</h1>
          <p className="sub">{t("guestJoinSub")}</p>
          <label className="field">
            {t("guestYourName")}
            <input value={nameValue} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </label>
          <div className="checks">
            <div className="check">
              <Check className="markok" size={18} />
              <span>{t("guestCamWorking")}</span>
              <span className="val">{camOk ? resLabel : t("guestNoCamera")}</span>
            </div>
            <div className="check">
              <Check className="markok" size={18} />
              <span>{t("guestMicPickingUp")}</span>
              <span className="val">{micOk ? t("guestTestSound") : t("guestNoMic")}</span>
            </div>
            <div className="check">
              <Check className="markok" size={18} />
              <span>{t("guestConnection")}</span>
              <span className="val">{t(NET_KEY[net])}</span>
            </div>
          </div>
          <button className="btn primary wide" type="submit" disabled={busy}>
            {busy ? t("guestJoining") : t("guestJoinBackstage")}
          </button>
          {error ? <p className="err">{error}</p> : null}
          <p className="footnote">{t("guestFootnote")}</p>
        </form>
      </div>
    </div>
  );
}
