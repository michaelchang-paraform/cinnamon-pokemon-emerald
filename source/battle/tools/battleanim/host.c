// stand-ins for the pieces of the game the move animations reach outside the sprite, task and palette engine:
// BIOS math, decompression, sound, BG drawing and battle state; sounds and cries are reported to the recorder
#include <math.h>
#include <string.h>
#include "global.h"
#include "sprite.h"
#include "palette.h"
#include "decompress.h"
#include "pokemon.h"
#include "scanline_effect.h"
#include "gpu_regs.h"
#include "dma3.h"
#undef CpuSet

void SimSound(int kind, int id, int pan);
u16 gSimSpecies[2];
unsigned char gSim_VRAM[0x18000] __attribute__((aligned(16))), gSim_PLTT[0x400] __attribute__((aligned(16))), gSim_OAM[0x400] __attribute__((aligned(16))), gSim_REG_BASE[0x400] __attribute__((aligned(16)));
// two colours a fade or blend can be read back from: index 1 black, index 2 white
static u16 sPattern[16] = {0, 0, 0x7FFF};
static u16 sZero[0x4000];

u16 ArcTan2(s16 x, s16 y) {
  double angle = atan2((double)y, (double)x);
  if (angle < 0) angle += 2 * M_PI;
  return (u16)(angle / (2 * M_PI) * 65536.0);
}

// the BIOS affine setup: 8.8 scales, a rotation in 65536ths of a turn, four 8.8 matrix entries per set
void ObjAffineSet(struct ObjAffineSrcData *src, void *dest, s32 count, s32 offset) {
  u8 *out = dest;
  for (s32 i = 0; i < count; i++) {
    double theta = (src[i].rotation >> 8) * 2 * M_PI / 256;
    s32 c = (s32)lround(cos(theta) * 16384), s = (s32)lround(sin(theta) * 16384);
    s16 m[4] = {(s16)((src[i].xScale * c) >> 14), (s16)(-(src[i].xScale * s) >> 14), (s16)((src[i].yScale * s) >> 14), (s16)((src[i].yScale * c) >> 14)};
    for (int k = 0; k < 4; k++) memcpy(out + k * offset, &m[k], 2);
    out += 4 * offset;
  }
}

void CpuSet(const void *src, void *dest, u32 control) {
  u32 count = control & 0x1FFFFF;
  bool32 wide = control & (1 << 26), fill = control & (1 << 24);
  u32 unit = wide ? 4 : 2;
  for (u32 i = 0; i < count; i++) memcpy((u8 *)dest + i * unit, (const u8 *)src + (fill ? 0 : i * unit), unit);
}

s16 MathUtil_Mul16(s16 x, s16 y) { return (x * y) >> 8; }
s16 MathUtil_Inv16(s16 y) { return y ? 0x10000 / y : 0; }

// each colour moves toward the blend colour by coeff sixteenths, per 5-bit channel
void BlendPalette(u16 palOffset, u16 numEntries, u8 coeff, u32 blendColor) {
  for (u16 i = 0; i < numEntries; i++) {
    u16 from = gPlttBufferUnfaded[palOffset + i];
    s32 out = 0;
    for (int shift = 0; shift <= 10; shift += 5) {
      s32 a = (from >> shift) & 31, b = (blendColor >> shift) & 31;
      out |= (a + (((b - a) * coeff) >> 4)) << shift;
    }
    gPlttBufferFaded[palOffset + i] = out;
  }
}

// the BIOS LZ77 format: a 0x10 header byte and 24-bit size, then per flag byte eight literals or back-references;
// graphics the build left as zeroed blocks (sprite sheets, which the page draws itself) decompress to nothing
void LZ77UnCompWram(const u32 *src, void *dest) {
  const u8 *in = (const u8 *)src;
  u8 *out = dest;
  if (in[0] != 0x10) return;
  u32 size = in[1] | (in[2] << 8) | (in[3] << 16), at = 0;
  in += 4;
  while (at < size) {
    u8 flags = *in++;
    for (int bit = 7; bit >= 0 && at < size; bit--) {
      if (!(flags & (1 << bit))) {
        out[at++] = *in++;
        continue;
      }
      u32 length = (in[0] >> 4) + 3, back = (((in[0] & 15) << 8) | in[1]) + 1;
      in += 2;
      for (u32 k = 0; k < length && at < size; k++, at++) out[at] = out[at - back];
    }
  }
}
void LZ77UnCompVram(const u32 *src, void *dest) { LZ77UnCompWram(src, dest); }
void LZDecompressWram(const u32 *src, void *dest) { LZ77UnCompWram(src, dest); }
void LZDecompressVram(const u32 *src, void *dest) { LZ77UnCompWram(src, dest); }

// sheets register their tag and tile range with no pixels
bool8 LoadCompressedSpriteSheetUsingHeap(const struct CompressedSpriteSheet *src) {
  struct SpriteSheet sheet = {sZero, src->size, src->tag};
  LoadSpriteSheet(&sheet);
  return FALSE;
}
// an effect sprite's palette loads its real colours (so palette rotations and blends are recorded as they are),
// or the readable pattern when the build has no colours for it
bool8 LoadCompressedSpritePaletteUsingHeap(const struct CompressedSpritePalette *src) {
  static u16 colors[256];
  const u8 *header = (const u8 *)src->data;
  bool8 real = header && header[0] == 0x10;
  if (real) LZ77UnCompWram(src->data, colors);
  struct SpritePalette palette = {real ? colors : sPattern, src->tag};
  LoadSpritePalette(&palette);
  return FALSE;
}
const u32 *GetMonSpritePalFromSpeciesAndPersonality(u16 species, u32 otId, u32 personality) { return (const u32 *)sPattern; }

void PlaySE(u16 song) { SimSound(0, song, 0); }
void PlaySE12WithPanning(u16 song, s8 pan) { SimSound(0, song, pan); }
void PlaySE1WithPanning(u16 song, s8 pan) { SimSound(0, song, pan); }
void PlaySE2WithPanning(u16 song, s8 pan) { SimSound(0, song, pan); }
void SE12PanpotControl(s8 pan) {}
void PlayCry_ByMode(u16 species, s8 pan, u8 mode) { SimSound(1, mode, pan); }
void PlayCry_DuckNoRestore(u16 species, s8 pan, u8 mode) { SimSound(1, mode, pan); }
bool8 IsCryPlaying(void) { return FALSE; }
bool8 IsSEPlaying(void) { return FALSE; }
void StopCryAndClearCrySongs(void) {}
void m4aMPlayAllStop(void) {}
void m4aMPlayStop(void *info) {}
void m4aMPlayVolumeControl(void *info, u16 trackBits, u16 volume) {}

u8 CreateInvisibleSpriteWithCallback(void (*callback)(struct Sprite *)) {
  u8 id = CreateSprite(&gDummySpriteTemplate, 248, 168, 14);
  gSprites[id].invisible = TRUE;
  gSprites[id].callback = callback;
  return id;
}
void SpriteCB_SetInvisible(struct Sprite *sprite) { sprite->invisible = TRUE; }

// both battlers are present and healthy (the anim code checks HP before it touches a battler)
u32 GetMonData2(struct Pokemon *mon, s32 field) {
  if (field == MON_DATA_HP || field == MON_DATA_MAX_HP) return 100;
  if (field != MON_DATA_SPECIES) return 0;
  return mon == &gPlayerParty[0] ? gSimSpecies[0] : gSimSpecies[1];
}
bool8 IsSpeciesNotUnown(u16 species) { return TRUE; }
bool8 ShouldIgnoreDeoxysForm(u8 caseId, u8 battler) { return FALSE; }

// battler pictures and battle graphics reloads draw nothing here: the page draws the battlers and its own scene
// which BG layer each battler position was copied onto for an effect, 0 for none
u8 gSimBattlerBg[4];
void DrawBattlerOnBg(int bgId, u8 x, u8 y, u8 battlerPosition, u8 paletteId, u8 *tiles, u16 *tilemap, u16 tilesOffset) { gSimBattlerBg[battlerPosition & 3] = bgId; }
// the terrain coming back after a move background: BG3's tiles and map cleared, its palettes the readable pattern
void DrawMainBattleBackground(void) {
  u16 cnt = GetGpuReg(REG_OFFSET_BG3CNT);
  memset(gSim_VRAM + ((cnt >> 2) & 3) * 0x4000, 0, 0x4000);
  memset(gSim_VRAM + ((cnt >> 8) & 31) * 0x800, 0, 0x1000);
  for (int i = BG_PLTT_ID(2); i < BG_PLTT_ID(5); i++) gPlttBufferUnfaded[i] = sPattern[i % 16];
  if (!gPaletteFade.active) memcpy(&gPlttBufferFaded[BG_PLTT_ID(2)], &gPlttBufferUnfaded[BG_PLTT_ID(2)], 3 * PLTT_SIZE_4BPP);
}
void LoadContestBgAfterMoveAnim(void) {}
void HandleSpeciesGfxDataChange(u8 battlerAtk, u8 battlerDef, bool8 notTransform) {}
void LoadBattleMonGfxAndAnimate(u8 battler, bool8 loadMonSprite, u8 spriteId) {}
void LoadSpecialPokePic_2(const struct CompressedSpriteSheet *src, void *dest, s32 species, u32 personality, bool8 isFrontPic) {}
void LoadSpecialPokePic_DontHandleDeoxys(const struct CompressedSpriteSheet *src, void *dest, s32 species, u32 personality, bool8 isFrontPic) {}
void LoadBallGfx(u8 ballId) {}
void FreeBallGfx(u8 ballId) {}
void UpdateMonIconFrame(struct Sprite *sprite) {}
void UpdateOamPriorityInAllHealthboxes(u8 priority) {}
void SetBattlerShadowSpriteCallback(u8 battler, u16 species) {}
void ClearBehindSubstituteBit(u8 battler) {}
void SpriteCB_TrainerThrowObject(struct Sprite *sprite) {}
// queued VRAM copies and fills land at once
s16 RequestDma3Copy(const void *src, void *dest, u16 size, u8 mode) {
  memmove(dest, src, size);
  return 0;
}
s16 RequestDma3Fill(s32 value, void *dest, u16 size, u8 mode) {
  for (u16 i = 0; i < size; i += mode ? 4 : 2) memcpy((u8 *)dest + i, &value, mode ? 4 : 2);
  return 0;
}
