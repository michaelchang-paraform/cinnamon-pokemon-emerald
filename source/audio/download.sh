#!/bin/sh
# sparse, blob-less clone of pret/pokeemerald at 9103e52 with the sound sources build-audio.mjs reads:
# MIDI sequences, voicegroups, cries, the m4a driver and its tables, mid2agb and wav2agb (personal use only,
# see extension-audio/AUDIO-NOTICE.txt). The download folder is not in the repository.
set -eu
cd "$(dirname "$0")"
DIR="download/pokeemerald"
COMMIT="${POKEEMERALD_COMMIT:-9103e529c2fbdd7add4a1ff3350c6c1f92112c42}"
if [ ! -d "$DIR/.git" ]; then
  mkdir -p download
  git clone --filter=blob:none --no-checkout https://github.com/pret/pokeemerald.git "$DIR"
  git -C "$DIR" sparse-checkout init --no-cone
fi
cat > "$DIR/.git/info/sparse-checkout" <<'PATTERNS'
/sound/songs/midi/se_*.mid
/sound/songs/midi/mus_*.mid
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
/include/constants/pokedex.h
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
/data/battle_anim_scripts.s
/include/constants/battle_anim.h
/sound/voicegroups/drumsets/*
/sound/voicegroups/keysplits/*
/src/battle_script_commands.c
/src/battle_anim_sound_tasks.c
/src/palette.c
/src/pokemon.c
PATTERNS
git -C "$DIR" fetch --filter=blob:none --depth 1 origin "$COMMIT"
git -C "$DIR" checkout -q "$COMMIT"
git -C "$DIR" sparse-checkout reapply
ls "$DIR/sound/direct_sound_samples/cries" | wc -l | sed 's/^ */cries: /'
