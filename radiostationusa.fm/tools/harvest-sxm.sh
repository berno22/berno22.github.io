#!/usr/bin/env bash
# Harvests SiriusXM program-art keys for the CNBC channel by sampling the
# lookAround EPG repeatedly (it only exposes the CURRENTLY-airing show).
# Usage:
#   tools/harvest-sxm.sh            # single sample
#   tools/harvest-sxm.sh 24 300     # 24 samples, 300s apart (~2h)
set -euo pipefail
cd "$(dirname "$0")/.."

SAMPLES="${1:-1}"
INTERVAL="${2:-0}"
EPG="https://lookaround-cache-prod.streaming.siriusxm.com/playbackservices/v1/live/lookAround"
GUID="2b6effb8-eb0e-7421-d7bb-d843a9ff3ce1"

for i in $(seq 1 "$SAMPLES"); do
  curl -sf --compressed "$EPG?channelGuid=$GUID&deviceType=WEB" -A "Mozilla/5.0" -o /tmp/opencode/sxm-sample.json || true
  python3 - <<'PY'
import json, os, re

def norm(x):
    return re.sub(r'[^a-z0-9]+', '', (x or '').lower())

seed_path = 'sxm-keys.json'
try:
    seed = json.load(open(seed_path))
except Exception:
    seed = {}

try:
    d = json.load(open('/tmp/opencode/sxm-sample.json'))
    ch = d['channels']['2b6effb8-eb0e-7421-d7bb-d843a9ff3ce1']
except Exception:
    print('sample unreadable'); raise SystemExit

new = 0
for s in ch.get('shows', []):
    name, img = s.get('name'), (s.get('image') or {}).get('url')
    k = norm(name)
    if k and img and seed.get(k) != img:
        seed[k] = img; new += 1
        print(f"learned: {name} -> {img}")

if new:
    json.dump(seed, open(seed_path, 'w'), indent=2, sort_keys=True)
    open(seed_path, 'a').write('\n')
print(f"total keys: {len(seed)}")
PY
  [ "$i" -lt "$SAMPLES" ] && sleep "$INTERVAL"
done
