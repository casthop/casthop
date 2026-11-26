import { useEffect, useRef, useState } from "react";
import type { Participant, TrackPublication } from "livekit-client";
import { ParticipantEvent, Track } from "livekit-client";
import { useI18n } from "../i18n";

// Publications exist before the MediaStreamTrack is subscribed; listen so we attach then.
const VIDEO_EVENTS = [
  ParticipantEvent.TrackSubscribed,
  ParticipantEvent.TrackUnsubscribed,
  ParticipantEvent.TrackPublished,
  ParticipantEvent.TrackUnpublished,
  ParticipantEvent.LocalTrackPublished,
  ParticipantEvent.LocalTrackUnpublished,
  ParticipantEvent.TrackMuted,
  ParticipantEvent.TrackUnmuted,
] as const;

function videoPublication(participant?: Participant): TrackPublication | undefined {
  if (!participant) return undefined;
  const cam = participant.getTrackPublication(Track.Source.Camera);
  const screen = participant.getTrackPublication(Track.Source.ScreenShare);
  return screen?.track ? screen : cam;
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
  const { t } = useI18n();
  const ref = useRef<HTMLVideoElement>(null);
  const [tile, setTile] = useState({ hasVideo: false, micOff: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let attached: TrackPublication["track"];

    const sync = () => {
      const pub = videoPublication(participant);
      const track = pub?.track;
      if (attached !== track) {
        attached?.detach(el);
        attached = track;
        if (track) track.attach(el);
        else el.srcObject = null;
      }
      setTile({
        hasVideo: Boolean(track && !pub?.isMuted),
        micOff: Boolean(participant && !participant.isMicrophoneEnabled),
      });
    };

    sync();
    if (!participant) {
      return () => {
        attached?.detach(el);
        el.srcObject = null;
      };
    }

    for (const ev of VIDEO_EVENTS) participant.on(ev, sync);
    return () => {
      for (const ev of VIDEO_EVENTS) participant.off(ev, sync);
      attached?.detach(el);
      el.srcObject = null;
    };
  }, [participant]);

  return (
    <div className={["tile", tone, booth ? "booth" : ""].filter(Boolean).join(" ")}>
      <video ref={ref} autoPlay playsInline muted={local || muted} aria-label={label} />
      {!tile.hasVideo && booth ? (
        <div className="person" aria-hidden="true">
          <div className="head" />
          <div className="body" />
        </div>
      ) : null}
      {!tile.hasVideo && !booth ? (
        <div className="silhouette" aria-hidden="true">
          <svg viewBox="0 0 80 80">
            <circle cx="40" cy="30" r="16" />
            <ellipse cx="40" cy="72" rx="28" ry="22" />
          </svg>
        </div>
      ) : null}
      <span className={booth ? "name" : "tag"}>{label}</span>
      {booth && tile.micOff ? (
        <span className="muted" title={t("micOff")}>
          <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 19v3" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <rect x="9" y="2" width="6" height="13" rx="3" />
            <path d="m2 2 20 20" />
          </svg>
          <span className="sr-only">{t("micOff")}</span>
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
