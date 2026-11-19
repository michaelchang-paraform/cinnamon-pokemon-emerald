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
# the move animation engine, its scripts and sprite sheets, as a shallow sparse checkout of the same commit;
# build-assets.mjs compiles and runs it (tools/battleanim) and keeps only what it records
ANIM="download/pokeemerald-anim"
COMMIT="${POKEEMERALD_COMMIT:-9103e529c2fbdd7add4a1ff3350c6c1f92112c42}"
PATTERNS="$(printf '%s\n' '/tools/preproc/' '/charmap.txt' '/asm/macros.inc' '/asm/macros/' '/constants/' '/data/battle_anim_scripts.s' \
  '/include/' '/src/battle_anim*.c' '/src/sprite.c' '/src/task.c' '/src/palette.c' '/src/gpu_regs.c' '/src/trig.c' \
  '/src/random.c' '/src/malloc.c' '/src/data/battle_anim.h' '/src/graphics.c' '/graphics_file_rules.mk' \
  '/graphics/battle_anims/sprites/*.png' '/graphics/battle_anims/sprites/*.pal' '/graphics/battle_anims/backgrounds/' \
  '/graphics/battle_anims/masks/' '/graphics/battle_anims/stat_change/' '/graphics/battle_anims/unused/' \
  '/src/bg.c' '/src/scanline_effect.c' '/src/battle_bg.c' '/src/field_weather.c' '/src/field_weather_effect.c' \
  '/graphics/weather/fog_horizontal.png' '/graphics/weather/fog.pal')"
# the checkout is fetched into a fresh directory and swapped in whole, and kept while it matches the commit and
# the path list, so a run never meets a half-made or hand-made directory
STAMP="$COMMIT $(printf '%s' "$PATTERNS" | cksum | cut -d' ' -f1)"
if [ "$(cat "$ANIM/.fetched" 2>/dev/null)" != "$STAMP" ]; then
  NEXT="$ANIM.next"
  rm -rf "$NEXT"
  mkdir -p "$NEXT"
  git -C "$NEXT" init -q
  git -C "$NEXT" remote add origin "${POKEEMERALD_REPO:-https://github.com/pret/pokeemerald.git}"
  git -C "$NEXT" config remote.origin.promisor true
  git -C "$NEXT" config remote.origin.partialclonefilter blob:none
  git -C "$NEXT" sparse-checkout init --no-cone
  printf '%s\n' "$PATTERNS" > "$NEXT/.git/info/sparse-checkout"
  git -C "$NEXT" fetch -q --filter=blob:none --depth 1 origin "$COMMIT"
  git -C "$NEXT" checkout -q FETCH_HEAD
  printf '%s\n' "$STAMP" > "$NEXT/.fetched"
  rm -rf "$ANIM"
  mv "$NEXT" "$ANIM"
fi
echo "anims $(find "$OUT" -type f | wc -l | tr -d ' ')"
