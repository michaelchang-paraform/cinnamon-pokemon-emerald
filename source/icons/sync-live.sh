#!/bin/sh
# copies the icons extension into the live Cinnamon folder; refuses files over the size limits
set -e
cd "$(dirname "$0")/../.."
LIVE="${CINNAMON_HOME:-$HOME/.config/claude-cinnamon}"
for file in extension-icons/*.css; do
  [ "$(wc -c < "$file")" -le 500000 ] || { echo "$file is over 500 KB"; exit 1; }
done
compiled=$(bun build extension-icons/page.ts --target=browser 2>/dev/null | wc -c)
[ "$compiled" -gt 0 ] && [ "$compiled" -le 55000 ] || { echo "page.ts compiles to $compiled bytes, limit 55000"; exit 1; }
mkdir -p "$LIVE/extensions/pokemon-icons"
rsync -a --delete extension-icons/ "$LIVE/extensions/pokemon-icons/"
echo "synced to $LIVE"
