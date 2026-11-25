#!/usr/bin/env bash
# Fail if an Egress MP4's audio is digital silence (mean_volume <= -90 dB).
# Usage: bash scripts/check-silent-audio.sh [file.mp4]
# If no file is given, uses the newest data/recordings/*.mp4.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
file="${1:-}"
if [[ -z "$file" ]]; then
  file="$(ls -1t "$ROOT"/data/recordings/*.mp4 2>/dev/null | head -1 || true)"
fi
if [[ -z "$file" || ! -f "$file" ]]; then
  echo "No recording to check. Pass an MP4 or run a live session first."
  exit 0
fi
if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg is required for volumedetect"
  exit 1
fi

echo "checking $file"
log="$(ffmpeg -hide_banner -i "$file" -af volumedetect -f null - 2>&1 || true)"
printf '%s\n' "$log"
mean="$(printf '%s\n' "$log" | sed -n 's/.*mean_volume: \([-0-9.]*\) dB.*/\1/p' | tail -1)"
if [[ -z "$mean" ]]; then
  echo "volumedetect did not report mean_volume (missing audio stream?)"
  exit 1
fi
echo "mean_volume=${mean} dB"
python3 - "$mean" <<'PY'
import sys
mean = float(sys.argv[1])
if mean <= -90:
    sys.exit(f"silent audio: mean_volume {mean} dB (threshold -90 dB)")
print("audio present")
PY
