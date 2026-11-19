#!/bin/sh
# Installs the built theme and the five extensions into Cinnamon. Run ./build.sh first.
set -eu
ROOT="$(cd "$(dirname "$0")" && pwd)"
CINNAMON="${CINNAMON:-$(command -v cinnamon || echo /opt/homebrew/opt/cinnamon/bin/cinnamon)}"
[ -x "$CINNAMON" ] || { echo "cinnamon not found: install Cinnamon first (see README.md)" >&2; exit 1; }
[ -s "$ROOT/themes/pokemon-emerald.json" ] && [ -s "$ROOT/extension-theme/fonts.css" ] || { echo "run ./build.sh first" >&2; exit 1; }

# cinnamon runs from the home folder: a bunfig.toml in the current folder can break it
cd "$HOME"
for ext in theme icons partners audio battle; do
  "$CINNAMON" ext install "$ROOT/extension-$ext" --yes
done
"$CINNAMON" theme install "$ROOT" --yes
"$CINNAMON" theme pokemon-emerald
"$CINNAMON" status
