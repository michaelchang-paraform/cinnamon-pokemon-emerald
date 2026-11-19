#!/bin/sh
# sparse, blob-less clone of pret/pokeemerald at 9103e52 with the sound sources build-audio.mjs reads:
# MIDI sequences, voicegroups, cries, the m4a driver and its tables, mid2agb and wav2agb (personal use only,
# see extension-audio/AUDIO-NOTICE.txt). Nothing here is committed anywhere.
set -e
cd "$(dirname "$0")"
DIR="download/pokeemerald"
COMMIT=9103e529
if [ ! -d "$DIR/.git" ]; then
  mkdir -p download
  git clone --filter=blob:none --no-checkout https://github.com/pret/pokeemerald.git "$DIR"
  git -C "$DIR" sparse-checkout init --no-cone
fi
cat > "$DIR/.git/info/sparse-checkout" <<'PATTERNS'
/sound/songs/midi/se_*.mid
/sound/songs/midi/midi.cfg
/sound/voicegroups/*
/sound/direct_sound_samples/*.wav
/sound/direct_sound_samples/cries/*.wav
/sound/programmable_wave_samples/*
/sound/*.inc
/sound/MPlayDef.s
/asm/macros/music_voice.inc
/asm/macros/m4a.inc
/src/m4a.c
/src/m4a_1.s
/src/m4a_tables.c
/src/sound.c
/include/gba/m4a_internal.h
/include/constants/songs.h
/include/constants/sound.h
/include/constants/species.h
/src/data/text/species_names.h
/src/pokemon_summary_screen.c
/src/naming_screen.c
/src/battle_controller_player.c
/src/party_menu.c
/src/menu.c
/src/list_menu.c
/src/start_menu.c
/src/text.c
/src/field_control_avatar.c
/tools/mid2agb/*
/tools/wav2agb/*
/audio_rules.mk
PATTERNS
git -C "$DIR" fetch --filter=blob:none --depth 1 origin "$COMMIT" 2>/dev/null || true
git -C "$DIR" checkout -q "$(git -C "$DIR" rev-parse HEAD)"
git -C "$DIR" sparse-checkout reapply
ls "$DIR/sound/direct_sound_samples/cries" | wc -l | sed 's/^ */cries: /'
