#!/bin/sh
# Build ox-tone-recall.lunaaddon. Inside it the add-on's folder is always "OX Tone Recall",
# whatever this checkout is called, so it lands in LUNA's Add Ons folder under that name.
set -eu
cd "$(dirname "$0")/.."
HERE="$PWD"
OUT="$HERE/ox-tone-recall.lunaaddon"

[ -f "link/OX Link.zip" ] || { echo "link/OX Link.zip is missing; see scripts/bundle-ox-link.sh" >&2; exit 1; }
[ -f icon.png ] || { echo "icon.png is missing; the panel finds OX Link beside it" >&2; exit 1; }

STAGE="$(mktemp -d)"
# What the Mac unpacked here (link/OX Link) must not ship: installed by LUNA its app can't run,
# and the panel would take it for unpacked and never open the zip. Set it aside while packing.
ASIDE=""
restore() {
  if [ -n "$ASIDE" ] && [ -d "$ASIDE/OX Link" ]; then mv "$ASIDE/OX Link" "$HERE/link/OX Link"; fi
  [ -L "$STAGE/OX Tone Recall" ] && rm "$STAGE/OX Tone Recall"
  [ -n "$ASIDE" ] && rmdir "$ASIDE" 2>/dev/null
  rmdir "$STAGE" 2>/dev/null || true
}
trap restore EXIT
if [ -d "link/OX Link" ]; then ASIDE="$STAGE/aside"; mkdir "$ASIDE"; mv "link/OX Link" "$ASIDE/OX Link"; fi

ln -s "$HERE" "$STAGE/OX Tone Recall"
npx ua-builder pack "$STAGE/OX Tone Recall" --out "$OUT"

unzip -l "$OUT" | grep -q "OX Tone Recall/link/OX Link.zip" || { echo "the package has no link/OX Link.zip" >&2; exit 1; }
if unzip -l "$OUT" | grep -q "OX Link.app/"; then echo "the package has an unpacked OX Link.app, which can't run once installed" >&2; exit 1; fi
