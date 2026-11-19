#!/bin/sh
set -eu
# needs fonttools + brotli (pip install fonttools brotli)
# gives the key symbols one font pixel of side bearing: in the symbol subset that the Emerald text falls back to,
# and in a copy of Departure Mono for the code font and shortcut hints (DepartureMono-Regular.woff2 stays upstream)
cd "$(dirname "$0")" || exit 1
pyftsubset DepartureMono-Regular.woff2 \
  --unicodes="U+2190-21FF,U+2300-23FF" \
  --no-hinting --desubroutinize --flavor=woff2 --output-file=DepartureSymbols.woff2
python3 key-bearings.py DepartureSymbols.woff2 50
cp DepartureMono-Regular.woff2 DepartureMono-Keys.woff2
python3 key-bearings.py DepartureMono-Keys.woff2 50
