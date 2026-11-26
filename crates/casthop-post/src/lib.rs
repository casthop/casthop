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
        "clip" => {
            let src = args.next();
            let dst = args.next();
            let seconds = args.next();
            clip_cmd(src.as_deref(), dst.as_deref(), seconds.as_deref())
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
           casthop-post clip <hls-dir> <out-dir> <seconds>\n\
         \n\
         inspect prints JSON (size, duration, codec) via ffprobe when present,\n\
         else a size-only fallback. normalize remuxes to a faststart MP4.\n\
         hls remuxes a VOD playlist (fMP4, {HLS_TIME_SEC}s targets) for the R2 replay viewer.\n\
         clip copies the last 30 or 60 seconds of an HLS directory."
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

fn clip_cmd(src: Option<&str>, dst: Option<&str>, seconds: Option<&str>) -> i32 {
    let (Some(src), Some(dst), Some(seconds)) = (src, dst, seconds) else {
        eprintln!("clip: need <hls-dir> <out-dir> <seconds>");
        return 2;
    };
    let secs: u32 = match seconds.parse::<u32>() {
        Ok(n) if n == 30 || n == 60 => n,
        _ => {
            eprintln!("clip: seconds must be 30 or 60");
            return 2;
        }
    };
    match clip_hls_dir(Path::new(src), Path::new(dst), secs) {
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

/// Copy the last `seconds` of an HLS VOD/EVENT directory (playlist + listed files).
pub fn clip_hls_dir(src: &Path, dst: &Path, seconds: u32) -> Result<String, String> {
    let playlist_path = src.join("index.m3u8");
    let text = fs::read_to_string(&playlist_path).map_err(|err| err.to_string())?;
    let sliced = slice_hls_playlist(&text, seconds)?;
    fs::create_dir_all(dst).map_err(|err| err.to_string())?;
    for name in &sliced.files {
        if name == "index.m3u8" {
            continue;
        }
        let from = src.join(name);
        if !from.is_file() {
            return Err(format!("missing {name}"));
        }
        fs::copy(&from, dst.join(name)).map_err(|err| err.to_string())?;
    }
    fs::write(dst.join("index.m3u8"), sliced.playlist).map_err(|err| err.to_string())?;
    summarize_hls_dir(dst)
}

struct HlsSlice {
    playlist: String,
    files: Vec<String>,
}

fn slice_hls_playlist(text: &str, seconds: u32) -> Result<HlsSlice, String> {
    if !text.starts_with("#EXTM3U") {
        return Err("playlist must start with #EXTM3U".into());
    }
    let mut segments: Vec<(f64, String)> = Vec::new();
    let mut map_uri: Option<String> = None;
    let mut target: u32 = HLS_TIME_SEC;
    let mut version = "7".to_string();
    let mut pending: Option<f64> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("#EXT-X-VERSION:") {
            let v = rest.trim();
            if !v.is_empty() {
                version = v.to_string();
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            if let Ok(n) = rest.trim().parse::<u32>() {
                if n > 0 {
                    target = n;
                }
            }
            continue;
        }
        if line.starts_with("#EXT-X-MAP:") {
            if let Some(start) = line.find("URI=\"") {
                let rest = &line[start + 5..];
                if let Some(end) = rest.find('"') {
                    map_uri = Some(rest[..end].to_string());
                }
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            let n = rest.split(',').next().unwrap_or("").parse::<f64>();
            pending = n.ok().filter(|v| *v > 0.0);
            continue;
        }
        if !line.is_empty() && !line.starts_with('#') {
            if let Some(dur) = pending.take() {
                segments.push((dur, line.to_string()));
            }
        }
    }
    if segments.is_empty() {
        return Err("no program yet".into());
    }
    let mut acc = 0.0;
    let mut kept: Vec<(f64, String)> = Vec::new();
    for (dur, uri) in segments.into_iter().rev() {
        kept.push((dur, uri));
        acc += dur;
        if acc >= f64::from(seconds) {
            break;
        }
    }
    kept.reverse();
    let mut max_target = target;
    for (dur, _) in &kept {
        let ceil = dur.ceil() as u32;
        if ceil > max_target {
            max_target = ceil;
        }
    }
    let mut lines = vec![
        "#EXTM3U".into(),
        format!("#EXT-X-VERSION:{version}"),
        format!("#EXT-X-TARGETDURATION:{max_target}"),
        "#EXT-X-PLAYLIST-TYPE:VOD".into(),
        "#EXT-X-INDEPENDENT-SEGMENTS".into(),
    ];
    let mut files = Vec::new();
    if let Some(map) = &map_uri {
        lines.push(format!("#EXT-X-MAP:URI=\"{map}\""));
        files.push(map.clone());
    }
    for (dur, uri) in &kept {
        lines.push(format!("#EXTINF:{dur:.1},"));
        lines.push(uri.clone());
        if !files.iter().any(|f| f == uri) {
            files.push(uri.clone());
        }
    }
    files.push("index.m3u8".into());
    lines.push("#EXT-X-ENDLIST".into());
    lines.push(String::new());
    Ok(HlsSlice {
        playlist: lines.join("\n"),
        files,
    })
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
    fn clip_usage() {
        assert_eq!(clip_cmd(None, None, None), 2);
        assert_eq!(clip_cmd(Some("/tmp"), Some("/tmp/out"), Some("15")), 2);
    }

    #[test]
    fn clip_slices_last_segments() {
        let dir = unique_temp("clip-in");
        let _ = fs::create_dir_all(&dir);
        let mut playlist = String::from(
            "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI=\"init.mp4\"\n",
        );
        fs::write(dir.join("init.mp4"), b"init").unwrap();
        for i in 0..16 {
            playlist.push_str(&format!("#EXTINF:4.0,\nseg{i}.m4s\n"));
            fs::write(dir.join(format!("seg{i}.m4s")), format!("seg{i}")).unwrap();
        }
        fs::write(dir.join("index.m3u8"), playlist).unwrap();
        let out = unique_temp("clip-out");
        let summary = clip_hls_dir(&dir, &out, 30).expect("clip");
        assert!(summary.contains("\"ok\":true"), "{summary}");
        let cut = fs::read_to_string(out.join("index.m3u8")).unwrap();
        assert!(cut.contains("#EXT-X-ENDLIST"));
        assert!(cut.contains("seg15.m4s"));
        assert!(cut.contains("seg8.m4s"));
        assert!(!cut.contains("seg7.m4s"));
        assert!(out.join("init.mp4").is_file());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&out);
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
