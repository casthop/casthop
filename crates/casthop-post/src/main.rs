//! Recording / egress post-processing helper.
//!
//! Inspects MP4/fMP4 files from LiveKit Egress or MediaMTX and optionally
//! remuxes them with ffmpeg. This is the v0 server-side Rust hot-path helper;
//! RTMP fan-out stays on Egress until we split a dedicated ingest service.

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

fn main() {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_else(|| "help".into());
    let rc = match cmd.as_str() {
        "inspect" => inspect(args.next().as_deref()),
        "normalize" => {
            let src = args.next();
            let dst = args.next();
            normalize(src.as_deref(), dst.as_deref())
        }
        "help" | "-h" | "--help" => {
            help();
            0
        }
        other => {
            eprintln!("unknown command: {other}");
            help();
            2
        }
    };
    std::process::exit(rc);
}

fn help() {
    eprintln!(
        "casthop-post — recording post-processing\n\
         \n\
         USAGE:\n\
           casthop-post inspect <file.mp4>\n\
           casthop-post normalize <in.mp4> <out.mp4>\n\
         \n\
         inspect prints JSON (size, duration, codec) via ffprobe when present,\n\
         else a size-only fallback. normalize remuxes to a faststart MP4."
    );
}

fn inspect(path: Option<&str>) -> i32 {
    let Some(path) = path else {
        eprintln!("inspect: missing path");
        return 2;
    };
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };
    if let Some(probe) = ffprobe(path) {
        println!("{probe}");
        return 0;
    }
    println!(
        "{{\"path\":{},\"bytes\":{},\"ffprobe\":false}}",
        json_str(path),
        meta.len()
    );
    0
}

fn normalize(src: Option<&str>, dst: Option<&str>) -> i32 {
    let (Some(src), Some(dst)) = (src, dst) else {
        eprintln!("normalize: need <in> <out>");
        return 2;
    };
    if !Path::new(src).is_file() {
        eprintln!("not a file: {src}");
        return 1;
    }
    if let Some(parent) = Path::new(dst).parent() {
        let _ = fs::create_dir_all(parent);
    }
    let status = Command::new("ffmpeg")
        .args([
            "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-c", "copy", "-movflags",
            "+faststart", dst,
        ])
        .stdin(Stdio::null())
        .status();
    match status {
        Ok(s) if s.success() => {
            println!("{{\"ok\":true,\"out\":{}}}", json_str(dst));
            0
        }
        Ok(s) => {
            eprintln!("ffmpeg exited {}", s.code().unwrap_or(-1));
            1
        }
        Err(err) => {
            eprintln!("ffmpeg not available: {err}");
            1
        }
    }
}

fn ffprobe(path: &str) -> Option<String> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    Some(format!(
        "{{\"path\":{},\"bytes\":{},\"ffprobe\":{}}}",
        json_str(path),
        fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        raw.trim()
    ))
}

fn json_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}
