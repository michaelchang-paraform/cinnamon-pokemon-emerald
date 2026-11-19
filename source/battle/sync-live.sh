#!/bin/sh
# copies extension-battle into the live Cinnamon folder
set -e
cd "$(dirname "$0")/../.."
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
# Cinnamon silently skips a page file whose compiled code is past roughly 60 KB, so refuse to ship one
if [ -x "$BUN" ]; then
  for f in extension-battle/*.ts; do
    size=$("$BUN" build "$f" --target=browser --format=iife | wc -c | tr -d ' ')
    if [ "$size" -gt 55000 ]; then echo "$f compiles to $size bytes (limit 55000): split it" >&2; exit 1; fi
  done
fi
for f in extension-battle/*.css; do
  size=$(wc -c < "$f" | tr -d ' ')
  if [ "$size" -gt 500000 ]; then echo "$f is $size bytes (limit 500000): split it" >&2; exit 1; fi
done
LIVE="${CINNAMON_HOME:-$HOME/.config/claude-cinnamon}"
mkdir -p "$LIVE/extensions/pokemon-battle"
rsync -a --delete extension-battle/ "$LIVE/extensions/pokemon-battle/"
echo "synced to $LIVE/extensions/pokemon-battle"
