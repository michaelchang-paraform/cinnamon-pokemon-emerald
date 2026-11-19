// runs anim scripts (every move from each side, or the general and status jobs on stdin) through the game's own
// anim engine, each in a child process (a crash or a hang then marks only that run), and prints one JSON line per
// run with what each frame shows:
// {"m": move, "a": attacker, "f": [{"s": sprites, "b": battlers, "p": palette black and white points, "P": real
//  palettes, "g": BG offsets, "v": display registers, "l": BG layer images, "h": scanline values}, ...],
//  "L": layer images, "snd": [[frame, kind, id, pan], ...]} or {"m": move, "a": attacker, "fail": reason}
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include <execinfo.h>
#include <dlfcn.h>
#include "global.h"
#include "battle.h"
#include "battle_anim.h"
#include "main.h"
#include "malloc.h"
#include "palette.h"
#include "sprite.h"
#include "task.h"
#include "constants/battle_anim.h"
#include "bg.h"
#include "data.h"
#include "gpu_regs.h"
#include "scanline_effect.h"

extern const u8 *const gSimMoveScripts[];
extern const u8 *const gSimGeneralScripts[];
extern const u8 *const gSimStatusScripts[];
extern const u16 gSimMoveCount;
extern u16 gSimSpecies[2];
extern u8 gReservedSpritePaletteCount;
extern u8 gSimBattlerBg[4];
extern unsigned char gSim_VRAM[];
extern const struct BgTemplate gSimBattleBgTemplates[4];
// the coordinate tables as writable (data.h declares them const, which lets the compiler drop the writes)
extern struct MonCoords sBackCoords[] __asm__("_gMonBackPicCoords");
extern struct MonCoords sFrontCoords[] __asm__("_gMonFrontPicCoords");

#define MAX_FRAMES 900
static int sFrame;
static int sSounds;

static FILE *sSoundOut;
void SimSound(int kind, int id, int pan) {
  if (sSoundOut) fprintf(sSoundOut, "%s[%d,%d,%d,%d]", sSounds++ ? "," : "", sFrame, kind, id, pan);
}

static const struct OamData sBattlerOam = {.affineMode = ST_OAM_AFFINE_NORMAL, .shape = SPRITE_SHAPE(64x64), .size = SPRITE_SIZE(64x64)};
#define BATTLER_SHEET 0xFFF0
static const struct SpriteTemplate sBattlerTemplate = {BATTLER_SHEET, TAG_NONE, &sBattlerOam, gDummySpriteAnimTable, NULL, gDummySpriteAffineAnimTable, SpriteCallbackDummy};

static void Setup(u8 attacker, u8 target, u16 arg) {
  static struct BattleSpriteInfo battlerData[MAX_BATTLERS_COUNT];
  static struct BattleHealthboxInfo healthBoxes[MAX_BATTLERS_COUNT];
  static struct BattleAnimationInfo animation;
  static struct BattleBarInfo bars[MAX_BATTLERS_COUNT];
  static struct BattleSpriteData sprites;
  sprites.battlerData = battlerData;
  sprites.healthBoxesData = healthBoxes;
  sprites.animationData = &animation;
  sprites.battleBars = bars;
  gBattleSpritesDataPtr = &sprites;
  gMain.inBattle = TRUE;
  static u8 bgTiles[0x2000], bgTilemap[0x1000];
  static struct MonSpritesGfx monGfx;
  gBattleAnimBgTileBuffer = bgTiles;
  gBattleAnimBgTilemapBuffer = bgTilemap;
  gMonSpritesGfxPtr = &monGfx;
  static u8 monPics[MAX_BATTLERS_COUNT][MON_PIC_SIZE * MAX_MON_PIC_FRAMES];
  for (int i = 0; i < MAX_BATTLERS_COUNT; i++) monGfx.sprites.ptr[i] = monPics[i];
  static u8 heap[0x20000];
  InitHeap(heap, sizeof(heap));
  for (int i = 0; i < 4; i++) gSimBattlerBg[i] = 0;
  ResetSpriteData();
  ResetTasks();
  ResetPaletteFade();
  FreeAllSpritePalettes();
  gReservedSpritePaletteCount = MAX_BATTLERS_COUNT;
  static u8 battlerTiles[64 * 64 / 2];
  struct SpriteSheet battlerSheet = {battlerTiles, sizeof(battlerTiles), BATTLER_SHEET};
  LoadSpriteSheet(&battlerSheet);
  gBattlersCount = 2;
  gBattleTypeFlags = 0;
  for (u8 b = 0; b < 2; b++) {
    gBattlerPositions[b] = b ? B_POSITION_OPPONENT_LEFT : B_POSITION_PLAYER_LEFT;
    gBattlerPartyIndexes[b] = 0;
    gSimSpecies[b] = 1;
    u8 id = CreateSprite(&sBattlerTemplate, GetBattlerSpriteCoord(b, BATTLER_COORD_X_2), GetBattlerSpriteCoord(b, BATTLER_COORD_Y_PIC_OFFSET), 30);
    gSprites[id].oam.paletteNum = b;
    gSprites[id].data[0] = b;
    gSprites[id].data[2] = 1;
    gBattlerSpriteIds[b] = id;
  }
  for (int i = 0; i < 32 * 16; i++) gPlttBufferUnfaded[i] = gPlttBufferFaded[i] = (i % 16) == 2 ? 0x7FFF : 0;
  // the battle's BG layout (battle_bg.c), with the anim layers' shared tilemap buffer
  ResetBgsAndClearDma3BusyFlags(0);
  InitBgsFromTemplates(0, gSimBattleBgTemplates, 4);
  SetBgTilemapBuffer(1, gBattleAnimBgTilemapBuffer);
  SetBgTilemapBuffer(2, gBattleAnimBgTilemapBuffer);
  // the battle intro (battle_intro.c) ends by moving BG1 and BG2 to char block 0, where the anim code expects them
  SetBgAttribute(1, BG_ATTR_CHARBASEINDEX, 0);
  SetBgAttribute(2, BG_ATTR_CHARBASEINDEX, 0);
  for (int bg = 0; bg < 4; bg++) ShowBg(bg);
  ScanlineEffect_Clear();
  // SIM_DY: both battlers' picture offsets moved, to find which battler each effect sprite follows
  const char *dy = getenv("SIM_DY");
  if (dy && strchr(dy, ',')) {
    // species 0 is what the battlers read through the stubbed party data, 1 what the recorder names
    for (int species = 0; species < 2; species++) {
      sBackCoords[species].y_offset = atoi(dy);
      sFrontCoords[species].y_offset = atoi(strchr(dy, ',') + 1);
    }
  }
  gBattlerAttacker = gBattleAnimAttacker = attacker;
  gBattlerTarget = gBattleAnimTarget = target;
  // what a general animation reads about its cause: the stat change, the trapping move
  animation.animArg = arg;
}

// a palette slot whose index 1 started black and index 2 white: how far it moved toward which colour
static void PrintSlot(int slot, int base, int *count) {
  for (int i = 0; i < 16; i++)
    if (gPlttBufferUnfaded[base + i] != (i == 2 ? 0x7FFF : 0)) return;
  u16 low = gPlttBufferFaded[base + 1], high = gPlttBufferFaded[base + 2];
  if (low == 0 && high == 0x7FFF) return;
  printf("%s[%d,%d,%d]", (*count)++ ? "," : "", slot, low, high);
}

// a palette slot something loaded real colours into, rather than the pattern: its faded colours as they are
static void PrintRealSlot(int slot, int base, int *count) {
  bool8 pattern = TRUE;
  for (int i = 0; i < 16; i++) pattern &= gPlttBufferUnfaded[base + i] == (i == 2 ? 0x7FFF : 0);
  if (pattern) return;
  printf("%s[%d", (*count)++ ? "," : "", slot);
  for (int i = 0; i < 16; i++) printf(",%d", gPlttBufferFaded[base + i]);
  printf("]");
}

// BG layers 1 to 3 as whole maps of (palette << 4 | colour index) bytes, 0 for clear; each distinct image is
// printed once per run in "L" and the frames name it by its index there
#define MAX_IMAGES 48
static u32 sImageHashes[MAX_IMAGES];
static int sImageCount;
static FILE *sImageOut;
static u8 sMap[512 * 512];

static void Base64(const u8 *bytes, int length) {
  static const char digits[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (int i = 0; i < length; i += 3) {
    u32 v = bytes[i] << 16 | (i + 1 < length ? bytes[i + 1] << 8 : 0) | (i + 2 < length ? bytes[i + 2] : 0);
    fputc(digits[v >> 18], sImageOut);
    fputc(digits[(v >> 12) & 63], sImageOut);
    fputc(i + 1 < length ? digits[(v >> 6) & 63] : '=', sImageOut);
    fputc(i + 2 < length ? digits[v & 63] : '=', sImageOut);
  }
}

static int LayerImage(int bg) {
  if (!(GetGpuReg(REG_OFFSET_DISPCNT) & (DISPCNT_BG0_ON << bg))) return -1;
  u16 cnt = GetGpuReg(REG_OFFSET_BG0CNT + bg * 2);
  const u8 *chars = gSim_VRAM + ((cnt >> 2) & 3) * 0x4000;
  const u16 *screen = (const u16 *)(gSim_VRAM + ((cnt >> 8) & 31) * 0x800);
  int width = (cnt >> 14) & 1 ? 512 : 256, height = (cnt >> 14) & 2 ? 512 : 256;
  u32 hash = 2166136261u;
  bool8 any = FALSE;
  for (int ty = 0; ty < height / 8; ty++)
    for (int tx = 0; tx < width / 8; tx++) {
      u16 entry = screen[((tx / 32) + (ty / 32) * (width / 256)) * 1024 + (ty % 32) * 32 + tx % 32];
      for (int y = 0; y < 8; y++)
        for (int x = 0; x < 8; x++) {
          int sx = entry & 0x400 ? 7 - x : x, sy = entry & 0x800 ? 7 - y : y;
          u8 pair = chars[(entry & 0x3FF) * 32 + sy * 4 + sx / 2];
          u8 index = sx & 1 ? pair >> 4 : pair & 15;
          u8 out = index ? ((entry >> 12) << 4) | index : 0;
          sMap[(ty * 8 + y) * width + tx * 8 + x] = out;
          any |= out != 0;
          hash = (hash ^ out) * 16777619u;
        }
    }
  if (!any) return -1;
  hash ^= width;
  for (int i = 0; i < sImageCount; i++)
    if (sImageHashes[i] == hash) return i;
  if (sImageCount == MAX_IMAGES) return -1;
  fprintf(sImageOut, "%s[%d,%d,\"", sImageCount ? "," : "", width, height);
  Base64(sMap, width * height);
  fprintf(sImageOut, "\"]");
  sImageHashes[sImageCount] = hash;
  return sImageCount++;
}

// the display registers the page draws from: layers shown, BG controls, blending, windows 0 and 1, and mosaic
static void PrintVideo(void) {
  static const u8 regs[] = {REG_OFFSET_DISPCNT, REG_OFFSET_BG1CNT, REG_OFFSET_BG2CNT, REG_OFFSET_BG3CNT, REG_OFFSET_BLDCNT,
                            REG_OFFSET_BLDALPHA, REG_OFFSET_BLDY, REG_OFFSET_WININ, REG_OFFSET_WINOUT, REG_OFFSET_MOSAIC};
  printf(",\"v\":[");
  for (u32 i = 0; i < ARRAY_COUNT(regs); i++) printf("%s%d", i ? "," : "", GetGpuReg(regs[i]));
  printf(",%d,%d,%d,%d]", gBattle_WIN0H, gBattle_WIN0V, gBattle_WIN1H, gBattle_WIN1V);
  printf(",\"l\":[%d,%d,%d]", LayerImage(1), LayerImage(2), LayerImage(3));
  // a scanline effect: the register its HBlank DMA writes and the value it gets on each of the 160 lines
  if (gScanlineEffect.state == 1 || gScanlineEffect.state == 2) {
    bool8 wide = gScanlineEffect.dmaControl & ((DMA_32BIT) << 16);
    const void *lines = gScanlineEffect.dmaSrcBuffers[gScanlineEffect.srcBuffer ^ 1];
    printf(",\"h\":[%d,%d", (int)((uintptr_t)gScanlineEffect.dmaDest - (uintptr_t)REG_BASE), wide);
    for (int y = 0; y < DISPLAY_HEIGHT; y++) printf(",%u", wide ? ((const u32 *)lines)[y] : ((const u16 *)lines)[y]);
    printf("]");
  }
}

static void PrintMatrix(struct Sprite *s) {
  struct OamMatrix *m = &gOamMatrices[s->oam.matrixNum];
  printf(",%d,%d,%d,%d", m->a, m->b, m->c, m->d);
}

// the BG mosaic reaches a battler through the layer its priority rank pairs it with (as Transform picks it)
static bool8 BattlerMosaic(u8 battler) {
  u8 bg = GetBattlerSpriteBGPriorityRank(battler) == 1 ? 1 : 2;
  return (GetGpuReg(REG_OFFSET_BG0CNT + bg * 2) & BGCNT_MOSAIC) != 0;
}

static bool8 IsBattler(u8 id) {
  return id == gBattlerSpriteIds[0] || id == gBattlerSpriteIds[1];
}

static void PrintFrame(void) {
  printf("%s{\"s\":[", sFrame ? "," : "");
  int n = 0;
  for (int i = 0; i < MAX_SPRITES; i++) {
    struct Sprite *s = &gSprites[i];
    if (!s->inUse || s->invisible || IsBattler(i) || !s->template || s->template->tileTag == TAG_NONE) continue;
    u16 tag = s->template->tileTag;
    u16 start = GetSpriteTileStartByTag(tag);
    bool8 affine = s->oam.affineMode & ST_OAM_AFFINE_ON_MASK;
    int flags = (affine ? 1 : 0) | (s->oam.affineMode == ST_OAM_AFFINE_DOUBLE ? 2 : 0) | (!affine && (s->oam.matrixNum & 8) ? 4 : 0) |
                (!affine && (s->oam.matrixNum & 16) ? 8 : 0) | (s->oam.objMode == ST_OAM_OBJ_BLEND ? 16 : 0) | (s->oam.objMode == ST_OAM_OBJ_WINDOW ? 32 : 0) | (s->oam.mosaic ? 64 : 0);
    int x = s->x + s->x2 + s->centerToCornerVecX + (s->coordOffsetEnabled ? gSpriteCoordOffsetX : 0);
    int y = s->y + s->y2 + s->centerToCornerVecY + (s->coordOffsetEnabled ? gSpriteCoordOffsetY : 0);
    printf("%s[%d,%d,%d,%d,%d,%d,%d,%d,%d,%d", n++ ? "," : "", tag, s->oam.tileNum - start, (s->oam.shape << 2) | s->oam.size, x, y,
           s->oam.priority, s->subpriority, GetSpritePaletteTagByPaletteNum(s->oam.paletteNum), s->oam.paletteNum, flags);
    if (affine) PrintMatrix(s);
    printf("]");
  }
  printf("],\"b\":[");
  for (u8 b = 0; b < 2; b++) {
    struct Sprite *s = &gSprites[gBattlerSpriteIds[b]];
    bool8 affine = s->oam.affineMode & ST_OAM_AFFINE_ON_MASK;
    // a battler copied onto a BG layer hides its sprite and moves with that layer's scroll instead
    u8 bg = gSimBattlerBg[GetBattlerPosition(b)];
    if (s->invisible && bg) {
      s16 bgX = bg == 1 ? gBattle_BG1_X : gBattle_BG2_X, bgY = bg == 1 ? gBattle_BG1_Y : gBattle_BG2_Y;
      printf("%s[%d,%d,%d", b ? "," : "", -bgX - (s->x - 32), -bgY - (s->y - 32), 4 | (bg << 3));
      printf("]");
      continue;
    }
    printf("%s[%d,%d,%d", b ? "," : "", s->x2, s->y2, (s->invisible ? 1 : 0) | (affine ? 2 : 0) | (BattlerMosaic(b) ? 32 : 0));
    if (affine) PrintMatrix(s);
    printf("]");
  }
  printf("],\"p\":[");
  n = 0;
  for (int slot = 0; slot < 16; slot++) PrintSlot(slot, OBJ_PLTT_ID(slot), &n);
  for (int slot = 0; slot < 16; slot++) PrintSlot(16 + slot, slot * 16, &n);
  // the offset probe (SIM_DY) only needs the sprites
  if (getenv("SIM_DY") && *getenv("SIM_DY")) {
    printf("]}");
    return;
  }
  printf("],\"P\":[");
  n = 0;
  for (int slot = 0; slot < 16; slot++) PrintRealSlot(slot, OBJ_PLTT_ID(slot), &n);
  for (int slot = 0; slot < 16; slot++) PrintRealSlot(16 + slot, slot * 16, &n);
  printf("],\"g\":[%d,%d,%d,%d,%d,%d]", (s16)gBattle_BG1_X, (s16)gBattle_BG1_Y, (s16)gBattle_BG2_X, (s16)gBattle_BG2_Y, (s16)gBattle_BG3_X, (s16)gBattle_BG3_Y);
  PrintVideo();
  printf("}");
}

static bool8 Busy(void) {
  if (gAnimScriptActive || gAnimVisualTaskCount || gAnimSoundTaskCount || gPaletteFade.active) return TRUE;
  for (int i = 0; i < MAX_SPRITES; i++)
    if (gSprites[i].inUse && !IsBattler(i) && gSprites[i].callback != SpriteCallbackDummy) return TRUE;
  return FALSE;
}

// one script of a table ('m' moves, 'g' general, 's' status) from one side; a job number names it in the output
static void Run(char table, u16 move, u8 attacker, u8 target, u16 arg, int job) {
  Setup(attacker, target, arg);
  sFrame = 0;
  sSounds = 0;
  // the whole run is buffered and printed at once, so a run that crashes prints nothing
  char *frames = NULL, *sounds = NULL, *images = NULL;
  size_t frameSize = 0, soundSize = 0, imageSize = 0;
  sImageCount = 0;
  sImageOut = open_memstream(&images, &imageSize);
  FILE *saved = stdout;
  FILE *frameOut = open_memstream(&frames, &frameSize);
  sSoundOut = open_memstream(&sounds, &soundSize);
  LaunchBattleAnimation(table == 'g' ? gSimGeneralScripts : table == 's' ? gSimStatusScripts : gSimMoveScripts, move, table == 'm');
  for (sFrame = 0; sFrame < MAX_FRAMES; sFrame++) {
    if (gAnimScriptActive) gAnimScriptCallback();
    RunTasks();
    AnimateSprites();
    UpdatePaletteFade();
    TransferPlttBuffer();
    ScanlineEffect_InitHBlankDmaTransfer();
    stdout = frameOut;
    PrintFrame();
    stdout = saved;
    if (!Busy()) break;
  }
  if (sFrame >= MAX_FRAMES && getenv("SIM_TRACE")) {
    Dl_info info;
    dprintf(2, "move %d stuck: script %d visual %d sound %d fade %d\n", move, gAnimScriptActive, gAnimVisualTaskCount, gAnimSoundTaskCount, gPaletteFade.active);
    for (int i = 0; i < NUM_TASKS; i++)
      if (gTasks[i].isActive && dladdr((void *)gTasks[i].func, &info)) dprintf(2, "  task %s\n", info.dli_sname ? info.dli_sname : "?");
    for (int i = 0; i < MAX_SPRITES; i++)
      if (gSprites[i].inUse && !IsBattler(i) && dladdr((void *)gSprites[i].callback, &info)) dprintf(2, "  sprite %s\n", info.dli_sname ? info.dli_sname : "?");
  }
  fclose(frameOut);
  fclose(sSoundOut);
  fclose(sImageOut);
  printf("{\"m\":%d,\"a\":%d,", move, attacker);
  if (job >= 0) printf("\"j\":%d,", job);
  // a script still running when the frame limit ran out never ends here
  if (sFrame >= MAX_FRAMES) printf("\"stuck\":1,");
  printf("\"snd\":[%s],\"L\":[%s],\"f\":[%s]}\n", sounds, images, frames);
  fflush(stdout);
}

// SIM_TRACE=1: a crashing run prints where it crashed, for working on the stand-ins
static void Trace(int sig) {
  void *frames[24];
  int n = backtrace(frames, 24);
  backtrace_symbols_fd(frames, n, 2);
  extern const void *gSimLastTemplate;
  Dl_info last;
  dprintf(2, "last template pointer %p\n", gSimLastTemplate);
  if (gSimLastTemplate && dladdr(gSimLastTemplate, &last)) dprintf(2, "last created template %s callback %p\n", last.dli_sname ? last.dli_sname : "?", (void *)((const struct SpriteTemplate *)gSimLastTemplate)->callback);
  for (int i = 0; i < MAX_SPRITES; i++) {
    Dl_info info;
    if (!gSprites[i].inUse) continue;
    Dl_info tinfo;
    const char *cb = dladdr((void *)gSprites[i].callback, &info) && info.dli_sname ? info.dli_sname : "?";
    const char *tp = dladdr((void *)gSprites[i].template, &tinfo) && tinfo.dli_sname ? tinfo.dli_sname : "?";
    dprintf(2, "sprite %d callback %s (%p) template %s\n", i, cb, (void *)gSprites[i].callback, tp);
  }
  _exit(128 + sig);
}

// each run in a child process, so a crash or a hang marks only that run
static void Fork(char table, u16 move, u8 attacker, u8 target, u16 arg, int job) {
  fflush(stdout);
  if (getenv("SIM_NOFORK")) {
    Run(table, move, attacker, target, arg, job);
    return;
  }
  pid_t pid = fork();
  if (pid == 0) {
    alarm(10);
    Run(table, move, attacker, target, arg, job);
    _exit(0);
  }
  int status = 0;
  waitpid(pid, &status, 0);
  if (!WIFEXITED(status) || WEXITSTATUS(status)) {
    printf("{\"m\":%d,\"a\":%d,", move, attacker);
    if (job >= 0) printf("\"j\":%d,", job);
    printf("\"fail\":%d}\n", WIFSIGNALED(status) ? WTERMSIG(status) : WEXITSTATUS(status));
  }
  fflush(stdout);
}

static void RecordMove(int move) {
  if (move <= 0 || move >= gSimMoveCount || !gSimMoveScripts[move]) return;
  for (u8 attacker = 0; attacker < 2; attacker++) Fork('m', move, attacker, attacker ^ 1, 0, -1);
}

// "battleanim [move ...]" records the listed move scripts (all of them without a list) from both sides;
// "battleanim jobs" reads one run per line from stdin: table, script, attacker, target, arg
int main(int argc, char **argv) {
  if (getenv("SIM_TRACE")) signal(SIGSEGV, Trace), signal(SIGBUS, Trace);
  if (argc > 1 && !strcmp(argv[1], "jobs")) {
    char table;
    int move, attacker, target, arg, job = 0;
    while (scanf(" %c %d %d %d %d", &table, &move, &attacker, &target, &arg) == 5) Fork(table, move, attacker, target, arg, job++);
    return 0;
  }
  if (argc > 1)
    for (int i = 1; i < argc; i++) RecordMove(atoi(argv[i]));
  else
    for (int move = 1; move < gSimMoveCount; move++) RecordMove(move);
  return 0;
}
