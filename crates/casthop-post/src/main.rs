//! Recording / egress post-processing helper.
//!
//! Inspects MP4/fMP4 files from room composite recordings or an RTMP edge and optionally
//! remuxes them with ffmpeg. HLS packaging is for the R2 replay viewer; RTMP fan-out stays
//! on Egress until we split a dedicated ingest service.

fn main() {
    std::process::exit(casthop_post::run(std::env::args().skip(1)));
}
