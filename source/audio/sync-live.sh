#!/bin/sh
# copies extension-audio into the live Cinnamon folder, after checking the sizes Cinnamon silently refuses
set -e
cd "$(dirname "$0")/../.."
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
if [ ! -x "$BUN" ]; then echo "bun not found: can't check compiled page sizes" >&2; exit 1; fi
# a page file past about 60 KB compiled is dropped, a CSS file past about 785 KB is dropped
for f in extension-audio/*.ts; do
  size=$("$BUN" build "$f" --target=browser --format=iife | wc -c | tr -d ' ')
  if [ "$size" -gt 55000 ]; then echo "$f compiles to $size bytes (limit 55000): split it" >&2; exit 1; fi
  echo "$f $size"
done
for f in extension-audio/*.css; do
  size=$(wc -c < "$f" | tr -d ' ')
  if [ "$size" -gt 500000 ]; then echo "$f is $size bytes (limit 500000): split it" >&2; exit 1; fi
  echo "$f $size"
done
LIVE="${CINNAMON_HOME:-$HOME/.config/claude-cinnamon}"
mkdir -p "$LIVE/extensions/pokemon-audio"
rsync -a --delete --exclude .cinnamon-source.json extension-audio/ "$LIVE/extensions/pokemon-audio/"
echo "synced to $LIVE/extensions/pokemon-audio"
