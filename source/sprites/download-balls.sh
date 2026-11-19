#!/bin/sh
# downloads the twelve Emerald ball sprites (graphics/balls) that build-sprites.mjs needs into download/pret/balls
# (personal use only, see extension-theme/SPRITES-NOTICE.txt)
set -e
cd "$(dirname "$0")"
RAW="https://raw.githubusercontent.com/pret/pokeemerald/master"
OUT="download/pret/balls"
mkdir -p "$OUT"
for ball in poke great ultra master safari net dive nest repeat timer luxury premier; do
  [ -s "$OUT/$ball.png" ] || curl -fsSL -o "$OUT/$ball.png" "$RAW/graphics/balls/$ball.png"
done
echo "balls $(ls "$OUT" | wc -l | tr -d ' ')"
