#!/bin/sh
# downloads the pret/pokeemerald files that item-list.py and build-items.mjs read, pinned to one commit,
# into download/pret/pokeemerald (personal use only, see extension-theme/SPRITES-NOTICE.txt)
set -eu
cd "$(dirname "$0")"
COMMIT="${POKEEMERALD_COMMIT:-9103e529c2fbdd7add4a1ff3350c6c1f92112c42}"
OUT="download/pret/pokeemerald"
[ -s "$OUT/src/data/items.h" ] && exit 0
mkdir -p "$OUT"
curl -fsSL "https://codeload.github.com/pret/pokeemerald/tar.gz/$COMMIT" | tar -xzf - -C "$OUT" --strip-components=1 \
  "pokeemerald-$COMMIT/include/constants/items.h" \
  "pokeemerald-$COMMIT/src/data/items.h" \
  "pokeemerald-$COMMIT/src/data/item_icon_table.h" \
  "pokeemerald-$COMMIT/src/data/graphics/items.h" \
  "pokeemerald-$COMMIT/src/data/pokemon/species_info.h" \
  "pokeemerald-$COMMIT/src/data/wild_encounters.json" \
  "pokeemerald-$COMMIT/graphics/items" \
  "pokeemerald-$COMMIT/data"
echo "pokeemerald $COMMIT: $(ls "$OUT/graphics/items/icons" | wc -l | tr -d ' ') item icons"
