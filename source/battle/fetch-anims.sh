#!/bin/sh
# fetches what build-assets.mjs reads beyond the sparse graphics checkout: the ball-open particle sheet and
# palette, the anim scripts (move sound timings), the entrance, throw, shake and particle code it records, and
# the tables it reads, from the pinned pokeemerald commit
# (personal use only, see extension-battle/SPRITES-NOTICE.txt)
set -eu
cd "$(dirname "$0")"
RAW="https://raw.githubusercontent.com/pret/pokeemerald/${POKEEMERALD_COMMIT:-9103e529c2fbdd7add4a1ff3350c6c1f92112c42}"
OUT="download/pret-anims"
mkdir -p "$OUT"
for name in particles circle_impact; do
  [ -s "$OUT/$name.png" ] || curl -fsSL -o "$OUT/$name.png" "$RAW/graphics/battle_anims/sprites/$name.png"
done
for path in data/battle_anim_scripts.s src/pokemon_animation.c include/pokemon_animation.h src/trig.c \
  src/battle_anim_throw.c src/battle_anim_mons.c src/pokeball.c src/data.c src/palette.c src/battle_main.c \
  include/pokeball.h \
  include/constants/pokemon.h include/constants/rgb.h; do
  mkdir -p "$OUT/$(dirname "$path")"
  [ -s "$OUT/$path" ] || curl -fsSL -o "$OUT/$path" "$RAW/$path"
done
echo "anims $(find "$OUT" -type f | wc -l | tr -d ' ')"
