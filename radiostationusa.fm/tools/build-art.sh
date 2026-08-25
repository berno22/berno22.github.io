#!/usr/bin/env bash
# Downloads square 640x640 program art for every entry in art.json into art/.
# art.json shape: { "<slug>": { "url": "<remote cnbc url>", "local": "art/<slug>.<ext>" } }
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p art

# Canonical ad/fallback logo tile (SXM-rendered CNBC brand square)
LOGO_KEY='if/68/68a5fed8ea323a848dd0014bb8c9ddb3_1782186558.png'
LOGO_URL="https://imgsrv-sxm-prod-device.streaming.siriusxm.com/$(python3 -c "import base64,json;print(base64.b64encode(json.dumps({'key':'$LOGO_KEY','edits':[{'resize':{'width':640,'height':640}}]}).encode()).decode())")"
curl -sf -A "Mozilla/5.0" -o art/logo.png "$LOGO_URL" && echo "ok   logo -> art/logo.png"

python3 - <<'PY'
import json, subprocess, sys

m = json.load(open('art.json'))
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

def square_url(u):
    i = u.find('?')
    from urllib.parse import urlparse, parse_qsl, urlencode
    if i < 0:
        return u + '?w=640&h=640', 'jpg'
    base, q = u[:i], dict(parse_qsl(u[i+1:]))
    ext = 'png' if base.lower().endswith('.png') else 'jpg'
    q['w'] = '640'; q['h'] = '640'
    return base + '?' + urlencode(q), ext

changed = False
for slug, ent in m.items():
    if isinstance(ent, str):          # migrate old string shape
        ent = {'url': ent}; changed = True
    if ent.get('local'):
        print(f"skip {slug} ({ent['local']})")
        continue
    u, ext = square_url(ent['url'])
    dest = f"art/{slug}.{ext}"
    r = subprocess.run(['curl', '-sf', '-A', UA, '-o', dest, u])
    if r.returncode != 0:
        print(f"FAIL {slug}"); continue
    ent['local'] = dest; changed = True
    print(f"ok   {slug} -> {dest}")

if changed:
    json.dump(m, open('art.json','w'), indent=2)
    open('art.json','a').write('\n')
PY
ls -la art/
