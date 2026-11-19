#!/bin/sh
# copies the export into the live Cinnamon folder
set -e
cd "$(dirname "$0")/.."
LIVE="${CINNAMON_HOME:-$HOME/.config/claude-cinnamon}"
mkdir -p "$LIVE/extensions/pokemon-emerald" "$LIVE/themes"
rsync -a --delete extension-theme/ "$LIVE/extensions/pokemon-emerald/"
cp themes/pokemon-emerald.json "$LIVE/themes/pokemon-emerald.json"
echo "synced to $LIVE"
