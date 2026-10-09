#!/usr/bin/env bash
# Generate small real MP4 test videos for local dev/QA. No external hotlinking.
set -euo pipefail
OUT="${1:-$HOME/workspace/kudiwatch/data/seed-videos}"
mkdir -p "$OUT"

gen() {
  local name="$1" dur="$2" text="$3"
  local out="$OUT/$name"
  if [ -f "$out" ]; then echo "exists: $out"; return; fi
  ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc=size=480x270:rate=15:duration=$dur" \
    -f lavfi -i "sine=frequency=440:duration=$dur" \
    -vf "drawtext=text='$text':fontsize=28:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.6" \
    -c:v libx264 -preset veryfast -b:v 400k -pix_fmt yuv420p \
    -c:a aac -b:a 32k -shortest \
    "$out"
  echo "wrote: $out ($(du -h "$out" | cut -f1))"
}

gen "demo-30s.mp4" 30 "KudiWatch demo ad 30s"
gen "demo-75s.mp4" 75 "KudiWatch demo ad 75s"
gen "demo-120s.mp4" 120 "KudiWatch demo ad 120s"
