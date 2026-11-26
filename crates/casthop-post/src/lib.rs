//! Recording post-processing: inspect, remux, and HLS packaging for R2 replay.

use std::fs;
use std::io;
use std::path::Path;
use std::process::{Command, Stdio};

/// HLS segment length written by `hls`. Short enough for a quick first frame, long enough
/// that a 3 Mbps VOD is not a flood of tiny objects.
pub const HLS_TIME_SEC: u32 = 4;

pub fn run<I>(args: I) -> i32
where
    I: IntoIterator<Item = String>,
{
    let mut args = args.into_iter();
    let cmd = args.next().unwrap_or_else(|| "help".into());
    match cmd.as_str() {
        "inspect" => inspect(args.next().as_deref()),
        "normalize" => {
            let src = args.next();
            let dst = args.next();
            normalize(src.as_deref(), dst.as_deref())
        }
        "hls" => {
            let src = args.next();
            let dst = args.next();
            hls(src.as_deref(), dst.as_deref())
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
    }
}

fn help() {
    eprintln!(
        "casthop-post — recording post-processing\n\
         \n\
         USAGE:\n\
           casthop-post inspect <file.mp4>\n\
           casthop-post normalize <in.mp4> <out.mp4>\n\
           casthop-post hls <in.mp4> <out-dir>\n\
         \n\
         inspect prints JSON (size, duration, codec) via ffprobe when present,\n\
         else a size-only fallback. normalize remuxes to a faststart MP4.\n\
         hls remuxes a VOD playlist (fMP4, {HLS_TIME_SEC}s targets) for the R2 replay viewer."
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
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            src,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            dst,
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

fn hls(src: Option<&str>, dst: Option<&str>) -> i32 {
    let (Some(src), Some(dst)) = (src, dst) else {
        eprintln!("hls: need <in.mp4> <out-dir>");
        return 2;
    };
    match package_hls(Path::new(src), Path::new(dst)) {
        Ok(summary) => {
            println!("{summary}");
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

/// Remux `src` to an HLS VOD directory (`index.m3u8` + fMP4 init/segments). Copy-only.
pub fn package_hls(src: &Path, dst: &Path) -> Result<String, String> {
    if !src.is_file() {
        return Err(format!("not a file: {}", src.display()));
    }
    fs::create_dir_all(dst).map_err(|err| err.to_string())?;
    let src_str = src
        .to_str()
        .ok_or_else(|| format!("not a file: {}", src.display()))?;
    let playlist = dst.join("index.m3u8");
    let playlist_str = playlist
        .to_str()
        .ok_or_else(|| format!("not a file: {}", playlist.display()))?;
    let seg_pattern = dst.join("seg%03d.m4s");
    let seg_arg = seg_pattern.to_string_lossy();
    let time = HLS_TIME_SEC.to_string();
    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            src_str,
            "-c",
            "copy",
            "-hls_time",
            &time,
            "-hls_playlist_type",
            "vod",
            "-hls_flags",
            "independent_segments",
            "-hls_segment_type",
            "fmp4",
            "-hls_fmp4_init_filename",
            "init.mp4",
            "-hls_segment_filename",
            seg_arg.as_ref(),
            playlist_str,
        ])
        .stdin(Stdio::null())
        .status()
        .map_err(|err| format!("ffmpeg not available: {err}"))?;
    if !status.success() {
        return Err(format!("ffmpeg exited {}", status.code().unwrap_or(-1)));
    }
    summarize_hls_dir(dst)
}

fn summarize_hls_dir(dst: &Path) -> Result<String, String> {
    let mut files = list_hls_files(dst).map_err(|err| err.to_string())?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let playlist = fs::read_to_string(dst.join("index.m3u8")).unwrap_or_default();
    let target = target_duration(&playlist).unwrap_or(HLS_TIME_SEC);
    let mut parts = Vec::new();
    let mut total = 0_u64;
    for (name, bytes) in &files {
        total += bytes;
        parts.push(format!(
            "{{\"name\":{},\"bytes\":{}}}",
            json_str(name),
            bytes
        ));
    }
    Ok(format!(
        "{{\"ok\":true,\"out\":{},\"targetDuration\":{},\"bytes\":{},\"files\":[{}]}}",
        json_str(&dst.to_string_lossy()),
        target,
        total,
        parts.join(",")
    ))
}

fn list_hls_files(dst: &Path) -> io::Result<Vec<(String, u64)>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dst)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        files.push((name, meta.len()));
    }
    Ok(files)
}

fn target_duration(playlist: &str) -> Option<u32> {
    for line in playlist.lines() {
        if let Some(rest) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            return rest.trim().parse().ok();
        }
    }
    None
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

#[cfg(test)]
fn ffmpeg_ok() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(test)]
fn unique_temp(name: &str) -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(std::time::Duration::from_secs(0))
        .as_nanos();
    std::env::temp_dir().join(format!("casthop-post-{name}-{stamp}"))
}

#[cfg(test)]
fn write_test_mp4(path: &Path, seconds: u32) -> bool {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let t = seconds.to_string();
    Command::new("ffmpeg")
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x180:rate=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            &t,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            path.as_os_str().to_string_lossy().as_ref(),
        ])
        .stdin(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_is_ok() {
        assert_eq!(run(["help".into()]), 0);
    }

    #[test]
    fn unknown_command_is_usage() {
        assert_eq!(run(["nope".into()]), 2);
    }

    #[test]
    fn inspect_missing_path() {
        assert_eq!(inspect(None), 2);
    }

    #[test]
    fn inspect_missing_file() {
        assert_eq!(inspect(Some("/no/such/casthop-post.mp4")), 1);
    }

    #[test]
    fn hls_usage() {
        assert_eq!(hls(None, None), 2);
    }

    #[test]
    fn hls_missing_file() {
        let dst = unique_temp("hls-missing");
        assert_eq!(
            hls(
                Some("/no/such/casthop-post.mp4"),
                Some(dst.to_str().unwrap())
            ),
            1
        );
    }

    #[test]
    fn inspect_size_fallback_without_media() {
        let dir = unique_temp("inspect");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("note.txt");
        fs::write(&path, b"hello").unwrap();
        assert_eq!(inspect(Some(path.to_str().unwrap())), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hls_packages_fmp4_vod() {
        if !ffmpeg_ok() {
            eprintln!("skip: ffmpeg not available");
            return;
        }
        let dir = unique_temp("hls");
        let src = dir.join("in.mp4");
        let out = dir.join("hls");
        assert!(write_test_mp4(&src, 2), "ffmpeg could not write a test mp4");
        let summary = package_hls(&src, &out).expect("hls");
        assert!(summary.contains("\"ok\":true"), "{summary}");
        assert!(out.join("index.m3u8").is_file());
        assert!(out.join("init.mp4").is_file());
        let playlist = fs::read_to_string(out.join("index.m3u8")).unwrap();
        assert!(playlist.contains("#EXTM3U"));
        assert!(playlist.contains("#EXT-X-ENDLIST"));
        assert!(playlist.contains("init.mp4"));
        let segs: Vec<_> = fs::read_dir(&out)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("m4s"))
            .collect();
        assert!(!segs.is_empty(), "expected at least one fMP4 segment");
        let _ = fs::remove_dir_all(&dir);
    }
}
