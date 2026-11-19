#!/bin/sh
# Fetches the upstream material and builds every generated file of the theme and the extensions.
# Usage: ./build.sh   (see README.md, "Build the assets")
set -eu
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

POKEEMERALD_COMMIT=9103e529c2fbdd7add4a1ff3350c6c1f92112c42
export POKEEMERALD_COMMIT
POKEAPI_COMMIT=c0542f7c51215d9672439012838c99f520596cbd
EMERALD_FONT_URL="https://raw.githubusercontent.com/pagefaultgames/pokerogue-assets/ff5bcf907ead4032534622cf62d2c56cd7988b3e/fonts/pokemon-emerald-pro.ttf"
GALMURI_FONT_URL="https://cdn.jsdelivr.net/npm/galmuri@2.40.3/dist/Galmuri9.ttf"

if [ -d "$ROOT/.venv/bin" ]; then PATH="$ROOT/.venv/bin:$PATH"; export PATH; fi

step() { printf '\n== %s\n' "$1"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)" >&2; exit 1; }; }

step "check the tools"
need node "Node.js 18 or later"
need npm "comes with Node.js"
need git "Xcode Command Line Tools"
need curl "part of macOS"
need c++ "Xcode Command Line Tools: xcode-select --install"
need clang "Xcode Command Line Tools: xcode-select --install"
need python3 "Python 3"
need pyftsubset "pip install fonttools==4.68.0 brotli==1.2.1 pillow==13.0.0"
python3 -c "import fontTools, brotli, PIL" || { echo "missing Python packages: pip install fonttools==4.68.0 brotli==1.2.1 pillow==13.0.0" >&2; exit 1; }
node -e "if (Number(process.versions.node.split('.')[0]) < 18) { console.error('Node.js 18 or later is necessary'); process.exit(1); }"

step "install the helper packages"
if [ ! -d helper/node_modules/pokemon-showdown ]; then (cd helper && npm ci); fi

# a shallow, sparse checkout of one commit: only the listed paths reach the disk
sparse_checkout() {
  dir="$1"; url="$2"; commit="$3"; patterns="$4"
  if [ ! -d "$dir/.git" ]; then
    mkdir -p "$dir"
    git -C "$dir" init -q
    git -C "$dir" remote add origin "$url"
    git -C "$dir" config remote.origin.promisor true
    git -C "$dir" config remote.origin.partialclonefilter blob:none
    git -C "$dir" sparse-checkout init --no-cone
  fi
  printf '%s\n' "$patterns" > "$dir/.git/info/sparse-checkout"
  git -C "$dir" fetch -q --filter=blob:none --depth 1 origin "$commit"
  git -C "$dir" checkout -q "$commit"
}

step "fetch the battle graphics (pret/pokeemerald, PokeAPI/sprites)"
sparse_checkout source/battle/download/pokeemerald https://github.com/pret/pokeemerald.git "$POKEEMERALD_COMMIT" 'graphics/battle_environment/tall_grass/*
graphics/battle_interface/*
graphics/party_menu/*
graphics/text_window/*
graphics/fonts/*
graphics/pokemon/*/front.png
graphics/pokemon/*/anim_front.png
graphics/pokemon/*/*/anim_front.png
graphics/pokemon/*/back.png
graphics/pokemon/*/normal.pal
graphics/pokemon/*/icon.png
graphics/pokemon/*/*/front.png
graphics/pokemon/*/*/back.png
graphics/pokemon/*/*/normal.pal
graphics/pokemon/*/*/icon.png
graphics/pokemon/icon_palettes/*
src/data/pokemon_graphics/*
src/pokemon_icon.c
src/fonts.c
src/pokemon.c
include/constants/species.h
charmap.txt'
sparse_checkout source/battle/download/pokeapi-sprites https://github.com/PokeAPI/sprites.git "$POKEAPI_COMMIT" 'sprites/pokemon/versions/generation-iii/emerald/*.png
sprites/pokemon/versions/generation-iii/firered-leafgreen/back/*.png
sprites/pokemon/versions/generation-iii/ruby-sapphire/back/*.png
sprites/pokemon/versions/generation-iii/firered-leafgreen/1000[12].png'

step "fetch the battle animation sources (pret/pokeemerald)"
sh source/battle/fetch-anims.sh

step "fetch the partner graphics (pret/pokeemerald)"
sh source/partners/download.sh

step "fetch the sound sources (pret/pokeemerald)"
sh source/audio/download.sh

step "fetch the ball and partner sprites"
sh source/sprites/download-balls.sh
for n in 252 255 258; do
  cp "source/battle/download/pokeapi-sprites/sprites/pokemon/versions/generation-iii/emerald/$n.png" "source/sprites/download/emerald-$n.png"
done
python3 source/sprites/crop-sprites.py

step "fetch the item icons (pret/pokeemerald)"
sh source/sprites/download-items.sh

step "fetch the fonts"
mkdir -p source/fonts/download
[ -s source/fonts/download/pokemon-emerald-pro.ttf ] || curl -fsSL -o source/fonts/download/pokemon-emerald-pro.ttf "$EMERALD_FONT_URL"
[ -s source/fonts/download/Galmuri9.ttf ] || curl -fsSL -o source/fonts/download/Galmuri9.ttf "$GALMURI_FONT_URL"

step "build the fonts"
sh source/fonts/subset-emerald.sh
sh source/fonts/subset-galmuri.sh
sh source/fonts/subset-symbols.sh
node source/fonts/build-fonts.mjs

step "build the theme"
node source/theme/build-theme.mjs

step "build the sprites and the icons"
node source/sprites/build-sprites.mjs
python3 source/sprites/item-list.py
node source/sprites/build-items.mjs
node source/icons/build-icons.mjs

step "build the battle data"
node source/battle/build-assets.mjs

step "build the partner data"
node source/partners/build-assets.mjs
node source/partners/build-ui.mjs

step "build the sounds"
node source/audio/build-audio.mjs

step "check the generated files"
missing=0
for manifest in extension-*/manifest.json; do
  dir="$(dirname "$manifest")"
  for file in $(node -e "const m = require('./$manifest'); console.log([...(m.page || []), ...(m.css || [])].join(' '))"); do
    if [ ! -s "$dir/$file" ]; then echo "missing: $dir/$file" >&2; missing=1; fi
  done
done
[ -s themes/pokemon-emerald.json ] || { echo "missing: themes/pokemon-emerald.json" >&2; missing=1; }
[ -s extension-theme/items.ts ] || { echo "missing: extension-theme/items.ts" >&2; missing=1; }
[ "$missing" -eq 0 ] || exit 1
echo "The build is complete. Run ./install.sh to install the theme and the extensions."
