# Casthop

Browser live studio. A host opens a room, guests join from a link, up to six people sit on stage, and the composite goes out to several RTMP destinations with a recording kept.

Audience: people who already stream talks, office hours, or product updates and do not want StreamYard’s lock-in.

Operate mode. The two primary surfaces are the host studio (dark booth) and the guest join screen (light, before the booth).

Media hot paths (noise suppression, VAD/meters, layout compositor) are Rust compiled to WebAssembly. TypeScript stays on the UI and Worker glue. LiveKit remains the SFU.
