#!/bin/sh
# copies extension-partners into the live Cinnamon folder, after checking the sizes Cinnamon silently refuses
set -e
cd "$(dirname "$0")/../.."
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
if [ ! -x "$BUN" ]; then echo "bun not found: can't check compiled page sizes" >&2; exit 1; fi
# a page file past about 60 KB compiled is dropped, a CSS file past about 785 KB is dropped
for f in extension-partners/*.ts; do
  # a page file that fails to compile is dropped by Cinnamon: refuse the sync
  if ! "$BUN" build "$f" --target=browser --format=iife > /tmp/pkp-build.js 2> /tmp/pkp-build.err; then cat /tmp/pkp-build.err >&2; echo "$f does not compile: not synced" >&2; rm -f /tmp/pkp-build.js /tmp/pkp-build.err; exit 1; fi
  size=$(wc -c < /tmp/pkp-build.js | tr -d ' ')
  rm -f /tmp/pkp-build.js /tmp/pkp-build.err
  if [ "$size" -gt 55000 ]; then echo "$f compiles to $size bytes (limit 55000): split it" >&2; exit 1; fi
  echo "$f $size"
done
for f in extension-partners/*.css; do
  size=$(wc -c < "$f" | tr -d ' ')
  if [ "$size" -gt 500000 ]; then echo "$f is $size bytes (limit 500000): split it" >&2; exit 1; fi
  echo "$f $size"
done
LIVE="${CINNAMON_HOME:-$HOME/.config/claude-cinnamon}"
# never hot-reload the partners during a battle in the app window
if curl -s -m 2 http://127.0.0.1:41851/health 2>/dev/null | grep -q '"status":"battling"'; then
  echo "a battle is running: not synced" >&2
  exit 1
fi
mkdir -p "$LIVE/extensions/pokemon-partners"
rsync -a --delete extension-partners/ "$LIVE/extensions/pokemon-partners/"
echo "synced to $LIVE/extensions/pokemon-partners"
