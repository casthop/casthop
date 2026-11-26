# Casthop

Browser live studio. A host signs in, opens a room they own, guests join from a link with no account, up to six people sit on stage, and the composite goes out to several RTMP destinations (16:9 and optional 9:16 from the same studio) with a recording kept. Hosts can also keep a per-person audio/video file from each browser, uploaded during the show next to the mixed recording.

Audience: people who already stream talks, office hours, or product updates and do not want StreamYard’s lock-in.

Operate mode. The two primary surfaces are the host studio (dark booth) and the guest join screen (light, before the booth).

Media hot paths (noise suppression, VAD/meters, layout compositor) are Rust compiled to WebAssembly. TypeScript stays on the UI and Worker glue. LiveKit remains the SFU.
