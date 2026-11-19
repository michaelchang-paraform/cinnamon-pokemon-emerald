#!/bin/sh
# downloads the pret/pokeemerald party icons and trainer overworld sprites that build-assets.mjs needs
# into source/partners/download/pret (personal use only, see extension-partners/SPRITES-NOTICE.txt)
set -eu
cd "$(dirname "$0")"
COMMIT="${POKEEMERALD_COMMIT:-9103e529c2fbdd7add4a1ff3350c6c1f92112c42}"
RAW="https://raw.githubusercontent.com/pret/pokeemerald/$COMMIT"
API="https://api.github.com/repos/pret/pokeemerald/contents"
# the battle checkout (build.sh makes it first) already lists the species folders: no GitHub API call then
LOCAL="../battle/download/pokeemerald/graphics/pokemon"
OUT="download/pret"
mkdir -p "$OUT/icons" "$OUT/people" "$OUT/fronts" "$OUT/summary" "$OUT/naming" "$OUT/types" "$OUT/src" "$OUT/battle" "$OUT/fonts" "$OUT/anim"

fetch() {
  [ -s "$2" ] && return 0
  curl -fsSL -o "$2" "$RAW/$1"
}
# for a file that is not upstream for every species: HTTP 404 is fine, any other failure stops the script
optional() {
  [ -s "$2" ] && return 0
  code=$(curl -sSL -o "$2" -w '%{http_code}' "$RAW/$1") || return 1
  [ "$code" = 200 ] || { rm -f "$2"; [ "$code" = 404 ]; }
}

if [ -d "$LOCAL" ]; then
  NAMES=$(cd "$LOCAL" && for d in */; do d="${d%/}"; case "$d" in (icon_palettes|question_mark|egg) ;; (*) echo "$d" ;; esac; done)
else
  curl -fsSL "$API/graphics/pokemon?ref=$COMMIT" -o "$OUT/pokemon-dirs.json"
  NAMES=$(python3 -I -c "import json,sys; print(' '.join(x['name'] for x in json.load(open(sys.argv[1])) if x['type'] == 'dir' and x['name'] not in ('icon_palettes', 'question_mark', 'egg')))" "$OUT/pokemon-dirs.json")
fi
for name in $NAMES; do
  if [ "$name" = "unown" ]; then
    fetch "graphics/pokemon/unown/a/icon.png" "$OUT/icons/unown.png"
    fetch "graphics/pokemon/unown/a/front.png" "$OUT/fronts/unown.png"
    fetch "graphics/pokemon/unown/a/anim_front.png" "$OUT/anim/unown.png"
  else
    fetch "graphics/pokemon/$name/icon.png" "$OUT/icons/$name.png"
    optional "graphics/pokemon/$name/front.png" "$OUT/fronts/$name.png"
    optional "graphics/pokemon/$name/anim_front.png" "$OUT/anim/$name.png"
  fi
  optional "graphics/pokemon/$name/normal.pal" "$OUT/fronts/$name.normal.pal"
  optional "graphics/pokemon/$name/shiny.pal" "$OUT/fronts/$name.shiny.pal"
done

R="graphics/summary_screen"
for f in tiles.png page_info.bin page_skills.bin page_battle_moves.bin a_button.png b_button.png; do fetch "$R/$f" "$OUT/summary/$f"; done
R="graphics/naming_screen"
for f in background.bin keyboard_upper.bin keyboard_lower.bin keyboard_symbols.bin keyboard.pal menu.png menu.pal buttons.pal cursor.pal \
  page_swap_upper.pal page_swap_lower.pal page_swap_others.pal page_swap_frame.png page_swap_upper.png page_swap_lower.png page_swap_others.png \
  back_button.png ok_button.png page_swap_button.png cursor.png input_arrow.png underscore.png; do fetch "$R/$f" "$OUT/naming/$f"; done
for t in normal fight flying poison ground rock bug ghost steel mystery fire water grass electric psychic ice dragon dark; do fetch "graphics/types/$t.png" "$OUT/types/$t.png"; done
for f in healthbox_singles_player.png hpbar.png; do fetch "graphics/battle_interface/$f" "$OUT/battle/$f"; done
fetch "graphics/fonts/latin_small.png" "$OUT/fonts/latin_small.png"
fetch "graphics/fonts/latin_normal.png" "$OUT/fonts/latin_normal.png"
fetch "graphics/battle_interface/text_pp.pal" "$OUT/battle/text_pp.pal"
fetch "graphics/battle_anims/sprites/gold_stars.png" "$OUT/battle/gold_stars.png"
fetch "graphics/summary_screen/move_select.png" "$OUT/summary/move_select.png"
fetch "src/data/pokemon_graphics/front_pic_anims.h" "$OUT/src/front_pic_anims.h"
fetch "src/fonts.c" "$OUT/src/fonts.c"
for f in data/text/move_descriptions.h data/text/move_names.h data/text/abilities.h data/pokemon/species_info.h; do fetch "src/$f" "$OUT/src/$(basename "$f")"; done

for i in 0 1 2; do fetch "graphics/pokemon/icon_palettes/icon_palette_$i.pal" "$OUT/icon_palette_$i.pal"; done
fetch "src/pokemon_icon.c" "$OUT/pokemon_icon.c"

for name in brendan/walking may/walking youngster lass bug_catcher hiker black_belt hex_maniac team_aqua/aqua_member_m team_magma/magma_member_m \
  team_aqua/aqua_member_f team_magma/magma_member_f beauty camper picnicker expert_m expert_f \
  fisherman gentleman pokefan_m pokefan_f psychic_m rich_boy running_triathlete_m running_triathlete_f sailor school_kid_m \
  swimmer_m swimmer_f twin; do
  fetch "graphics/object_events/pics/people/$name.png" "$OUT/people/$(echo "$name" | tr / _).png"
done
echo "icons $(ls "$OUT/icons" | wc -l | tr -d ' '), people $(ls "$OUT/people" | wc -l | tr -d ' ')"
