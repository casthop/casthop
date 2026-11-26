import { useEffect, useRef } from "react";
import type { Participant, TrackPublication } from "livekit-client";
import { Track } from "livekit-client";

function attachVideo(el: HTMLVideoElement | null, pub?: TrackPublication) {
  if (!el) return;
  const track = pub?.track;
  if (track) {
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }
  el.srcObject = null;
  return;
}

export function VideoTile({
  participant,
  label,
  local,
  muted,
  tone,
  booth,
}: {
  participant?: Participant;
  label: string;
  local?: boolean;
  muted?: boolean;
  tone?: "cam1" | "cam2" | "cam3";
  booth?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const cam = participant?.getTrackPublication(Track.Source.Camera);
  const screen = participant?.getTrackPublication(Track.Source.ScreenShare);
  const pub = screen?.track ? screen : cam;

  useEffect(() => attachVideo(ref.current, pub), [pub, pub?.trackSid]);

  const hasVideo = Boolean(pub?.track && !pub.isMuted);
  const micOff = Boolean(participant && !participant.isMicrophoneEnabled);

  return (
    <div className={["tile", tone, booth ? "booth" : ""].filter(Boolean).join(" ")}>
      <video ref={ref} autoPlay playsInline muted={local || muted} />
      {!hasVideo && booth ? (
        <div className="person" aria-hidden="true">
          <div className="head" />
          <div className="body" />
        </div>
      ) : null}
      {!hasVideo && !booth ? (
        <div className="silhouette" aria-hidden="true">
          <svg viewBox="0 0 80 80">
            <circle cx="40" cy="30" r="16" />
            <ellipse cx="40" cy="72" rx="28" ry="22" />
          </svg>
        </div>
      ) : null}
      <span className={booth ? "name" : "tag"}>{label}</span>
      {booth && micOff ? (
        <span className="muted" title="Microphone off">
          <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 19v3" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <rect x="9" y="2" width="6" height="13" rx="3" />
            <path d="m2 2 20 20" />
          </svg>
          <span className="sr-only">Microphone off</span>
        </span>
      ) : null}
    </div>
  );
}

export function LocalPreview({ stream, label }: { stream: MediaStream | null; label?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="tile">
      <video ref={ref} autoPlay playsInline muted />
      {!stream && (
        <div className="silhouette" aria-hidden="true">
          <svg viewBox="0 0 80 80">
            <circle cx="40" cy="30" r="16" />
            <ellipse cx="40" cy="72" rx="28" ry="22" />
          </svg>
        </div>
      )}
      {label ? <span className="tag">{label}</span> : null}
    </div>
  );
}
