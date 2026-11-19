#!/bin/sh
set -eu
# needs fonttools + brotli (pip install fonttools brotli)
# Galmuri9 by quiple (OFL 1.1), from the galmuri npm package dist/Galmuri9.ttf, saved as download/Galmuri9.ttf
# keeps Hangul (jamo, CJK punctuation, compatibility jamo, all 11,172 syllables) plus the arrows and keyboard symbols Emerald lacks
cd "$(dirname "$0")" || exit 1
pyftsubset download/Galmuri9.ttf \
  --unicodes="U+1100-11FF,U+2190-21FF,U+2300-23FF,U+3000-303F,U+3130-318F,U+AC00-D7A3" \
  --no-hinting --desubroutinize --flavor=woff2 --output-file=Galmuri9-Hangul.woff2
python3 alias-galmuri.py Galmuri9-Hangul.woff2
python3 key-bearings.py Galmuri9-Hangul.woff2 100
