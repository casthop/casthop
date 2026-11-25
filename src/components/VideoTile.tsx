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
}: {
  participant?: Participant;
  label: string;
  local?: boolean;
  muted?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const cam = participant?.getTrackPublication(Track.Source.Camera);
  const screen = participant?.getTrackPublication(Track.Source.ScreenShare);
  const pub = screen?.track ? screen : cam;

  useEffect(() => attachVideo(ref.current, pub), [pub, pub?.trackSid]);

  const hasVideo = Boolean(pub?.track && !pub.isMuted);

  return (
    <div className="tile">
      <video ref={ref} autoPlay playsInline muted={local || muted} />
      {!hasVideo && (
        <div className="silhouette" aria-hidden="true">
          <svg viewBox="0 0 80 80">
            <circle cx="40" cy="30" r="16" />
            <ellipse cx="40" cy="72" rx="28" ry="22" />
          </svg>
        </div>
      )}
      <span className="tag">{label}</span>
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
