#!/bin/sh
# needs fonttools + brotli (pip install fonttools brotli); keeps Latin, Greek, Cyrillic, punctuation and symbols
cd "$(dirname "$0")" || exit 1
pyftsubset download/pokemon-emerald-pro.ttf \
  --unicodes="U+0020-007E,U+00A0-024F,U+0370-03FF,U+0400-04FF,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2200-22FF,U+2460-24FF,U+2500-25FF,U+2600-27BF" \
  --layout-features='*' --flavor=woff2 --output-file=PokemonEmeraldPro.woff2
python3 shift-emerald.py PokemonEmeraldPro.woff2
python3 key-bearings.py PokemonEmeraldPro.woff2 64
