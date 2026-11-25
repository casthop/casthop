#!/usr/bin/env bash
# Measure glass-to-glass delay, CPU, and bandwidth for 2 / 4 / 6 on-stage publishers.
# Requires: docker compose stack, npm run dev, livekit-cli (`lk`), ffmpeg, curl, python3.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="${MEASURE_OUT:-$ROOT/data/measure}"
mkdir -p "$OUT"
APP="${APP_URL:-http://127.0.0.1:5173}"
LK_URL="${LIVEKIT_HTTP_URL:-http://127.0.0.1:7880}"
LK_WS="${PUBLIC_LIVEKIT_URL:-ws://127.0.0.1:7880}"
API_KEY="${LIVEKIT_API_KEY:-devkey}"
API_SECRET="${LIVEKIT_API_SECRET:-casthop_dev_secret_not_for_production_use_32b}"
SAMPLE_SECS="${SAMPLE_SECS:-45}"

log() { printf '[measure] %s\n' "$*"; }

wait_http() {
  local url="$1" name="$2" n=0
  until curl -sf -o /dev/null "$url" || curl -s -o /dev/null -w '' "$url"; do
    n=$((n + 1))
    if [[ $n -gt 60 ]]; then
      log "timeout waiting for $name at $url"
      return 1
    fi
    sleep 1
  done
}

log "waiting for app and livekit"
wait_http "$APP/api/health" app
wait_http "$LK_URL" livekit

cookie_jar="$OUT/cookies.txt"
rm -f "$cookie_jar"
magic=$(curl -sf -c "$cookie_jar" -X POST "$APP/api/auth/magic-link" -H 'content-type: application/json' \
  -d '{"email":"measure@example.com"}')
login=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("devLogin",""))' <<<"$magic")
if [[ -z "$login" ]]; then
  log "magic link did not return devLogin; sign in first or use local default keys"
  exit 1
fi
curl -sf -c "$cookie_jar" -b "$cookie_jar" -o /dev/null -X POST "$APP$login"
create=$(curl -sf -c "$cookie_jar" -b "$cookie_jar" -X POST "$APP/api/studios" -H 'content-type: application/json' \
  -d '{"title":"Measurement session"}')
id=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$create")
log "studio $id"

# Host token so the room exists and someone is subscribed locally via lk.
lk room join --url "$LK_WS" --api-key "$API_KEY" --api-secret "$API_SECRET" \
  --identity "measure-host" --publish-demo "$id" >/tmp/lk-host.log 2>&1 &
host_pid=$!
sleep 2

run_n() {
  local n="$1"
  local pids=()
  log "=== ${n} on stage ==="
  # host already publishing, add n-1 guests
  local extra=$((n - 1))
  for i in $(seq 1 "$extra"); do
    lk room join --url "$LK_WS" --api-key "$API_KEY" --api-secret "$API_SECRET" \
      --identity "guest-$n-$i" --publish-demo "$id" >/tmp/lk-g-$n-$i.log 2>&1 &
    pids+=($!)
  done
  sleep 4

  log "go live"
  live_json=$(curl -s -c "$cookie_jar" -b "$cookie_jar" -X POST "$APP/api/studios/$id/live" \
    -H 'content-type: application/json' -d '{"live":true}') || true
  printf '%s\n' "$live_json" >"$OUT/live-$n.json"
  sleep 6

  # docker stats snapshot over SAMPLE_SECS
  sudo docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}}' >"$OUT/docker-$n-start.txt" || true
  sleep "$SAMPLE_SECS"
  sudo docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}}' >"$OUT/docker-$n-end.txt" || true

  # RTMP / HLS presence
  curl -sI "http://127.0.0.1:8888/live/youtube/index.m3u8" | head -n 12 >"$OUT/hls-$n.txt" || true
  if command -v ffprobe >/dev/null; then
    ffprobe -v error -show_entries format=duration,bit_rate -of default=nw=1 \
      "http://127.0.0.1:8888/live/youtube/index.m3u8" >"$OUT/ffprobe-$n.txt" 2>&1 || true
  fi

  # LiveKit room stats via CLI if available
  lk room list --url "$LK_URL" --api-key "$API_KEY" --api-secret "$API_SECRET" >"$OUT/rooms-$n.txt" 2>&1 || true

  curl -s -c "$cookie_jar" -b "$cookie_jar" -X POST "$APP/api/studios/$id/live" \
    -H 'content-type: application/json' -d '{"live":false}' >/dev/null || true

  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 2
}

run_n 2
run_n 4
run_n 6

kill "$host_pid" 2>/dev/null || true

# recordings
ls -lah data/recordings >"$OUT/recordings.txt" 2>/dev/null || true
ls -lah data/rtmp >"$OUT/rtmp-recordings.txt" 2>/dev/null || true
if command -v ffmpeg >/dev/null; then
  bash "$ROOT/scripts/check-silent-audio.sh" >"$OUT/silent-audio.txt" 2>&1 || true
fi

log "wrote $OUT"
find "$OUT" -type f | sort
