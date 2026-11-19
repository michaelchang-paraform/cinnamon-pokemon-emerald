// stand-ins for the pokeemerald engine pieces that pokemon_animation.c and the ball particle code call, so the
// game's own sprite callbacks run natively and record what the GBA would draw each frame
#ifndef SIM_GLOBAL_H
#define SIM_GLOBAL_H
#include <stdint.h>
#include <stdlib.h>
#include <stddef.h>

typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int8_t s8;
typedef int16_t s16;
typedef int32_t s32;
typedef u8 bool8;
typedef u16 bool16;
typedef u32 bool32;
typedef void (*TaskFunc)(u8 taskId);

#define TRUE 1
#define FALSE 0
#define UNUSED __attribute__((unused))
#define ARRAY_COUNT(a) (sizeof(a) / sizeof((a)[0]))
#define Q_8_8(n) ((s16)((n) * 256))
#define Q_4_12(n) ((s16)((n) * 4096))
#define OBJ_PLTT_ID(n) (0x100 + (n) * 16)
#define RGB(r, g, b) ((r) | ((g) << 5) | ((b) << 10))
#define MAX_BATTLERS_COUNT 4
#define MAX_SPRITES 64
#define ST_OAM_AFFINE_OFF 0
#define ST_OAM_AFFINE_NORMAL 1
#define ST_OAM_AFFINE_ERASE 2
#define ST_OAM_AFFINE_DOUBLE 3

struct OamData {
  u32 y : 8, affineMode : 2, objMode : 2, mosaic : 1, bpp : 1, shape : 2;
  u32 x : 9, matrixNum : 5, size : 2;
  u16 tileNum : 10, priority : 2, paletteNum : 4;
  u16 affineParam;
};

union AffineAnimCmd {
  s16 type;
  struct { s16 xScale, yScale; u8 rotation, duration; } frame;
  struct { s16 type, target; } jump;
};
#define AFFINEANIMCMDTYPE_END 0x7FFF
#define AFFINEANIMCMDTYPE_JUMP 0x7FFE
#define AFFINEANIMCMD_FRAME(_x, _y, _r, _d) { .frame = { (_x), (_y), (_r), (_d) } }
#define AFFINEANIMCMD_JUMP(_t) { .jump = { AFFINEANIMCMDTYPE_JUMP, (_t) } }
#define AFFINEANIMCMD_END { .type = AFFINEANIMCMDTYPE_END }

union AnimCmd {
  s16 type;
  struct { u32 imageValue : 16, duration : 6, hFlip : 1, vFlip : 1; } frame;
  struct { u32 type : 16, target : 6; } jump;
};
#define ANIMCMD_END { .type = -1 }
#define ANIMCMD_JUMP(_t) { .jump = { (u16)-3, (_t) } }
#define ANIMCMD_FRAME(_img, _dur, ...) { .frame = { .imageValue = (_img), .duration = (_dur), __VA_ARGS__ } }

struct Sprite;
typedef void (*SpriteCallback)(struct Sprite *);
struct Sprite {
  struct OamData oam;
  const union AnimCmd *const *anims;
  const union AffineAnimCmd *const *affineAnims;
  SpriteCallback callback;
  s16 x, y, x2, y2;
  s16 centerToCornerVecX, centerToCornerVecY;
  u8 animNum, animCmdIndex, animDelayCounter, imageValue;
  u8 affineNum, affineIndex, affineDelay;
  bool8 affineBeginning;
  u16 affineRotation;
  bool8 inUse, invisible, hFlip, vFlip, animBeginning, animEnded, affineAnimPaused, affineAnimEnded;
  s16 data[8];
};
struct SpriteTemplate {
  u16 tileTag, paletteTag;
  const void *oam;
  const union AnimCmd *const *anims;
  const void *images;
  const void *affineAnims;
  SpriteCallback callback;
};
struct Task { TaskFunc func; bool8 isActive; s16 data[16]; };
struct OamMatrix { s16 a, b, c, d; };
struct ObjAffineSrcData { s16 xScale, yScale; u16 rotation; };
struct Pokemon { u8 nature; };
struct Main { bool8 inBattle; };

extern const s16 gSineTable[];
s16 Sin(s16 index, s16 amplitude);
s16 Cos(s16 index, s16 amplitude);

extern struct OamMatrix gOamMatrices[32];
extern struct Task gTasks[16];
extern struct Sprite gSprites[MAX_SPRITES];
extern struct Pokemon gPlayerParty[6];
extern u8 gBattlerPartyIndexes[4];
extern struct Main gMain;
extern s16 gSimScale[3];
extern u16 gSimBlend[2];

void SpriteCallbackDummy(struct Sprite *sprite);
void ObjAffineSet(struct ObjAffineSrcData *src, void *dest, s32 count, s32 offset);
void StartSpriteAffineAnim(struct Sprite *sprite, u8 num);
void InitSpriteAffineAnim(struct Sprite *sprite);
void CalcCenterToCornerVec(struct Sprite *sprite, u8 shape, u8 size, u8 affineMode);
void FreeOamMatrix(u8 matrixNum);
void BlendPalette(u16 offset, u16 count, u8 coeff, u32 color);
u8 CreateTask(TaskFunc func, u8 priority);
void DestroyTask(u8 taskId);
u8 GetNature(struct Pokemon *mon);
u8 CreateSprite(const struct SpriteTemplate *template, s16 x, s16 y, u8 subpriority);
void StartSpriteAnim(struct Sprite *sprite, u8 animNum);
void DestroySprite(struct Sprite *sprite);
void DestroySpriteAndFreeResources(struct Sprite *sprite);
void AnimateSprite(struct Sprite *sprite);
void AnimateAffine(struct Sprite *sprite);
void ChangeSpriteAffineAnim(struct Sprite *sprite, u8 num);
void PlaySE(u16 song);

// the battle state the throw and particle callbacks look at, fixed to one single battle on the player's side
struct SimAnimationData { u8 numBallParticles; bool8 introAnimActive; u16 ballSubpx; u8 ballThrowCaseId; };
struct SimBattleSprites { struct SimAnimationData *animationData; };
extern struct SimBattleSprites *gBattleSpritesDataPtr;
extern s16 gSimTarget[2];
#define BATTLER_COORD_X 0
#define BATTLER_COORD_Y 1
#define BATTLER_COORD_X_2 2
#define BATTLER_COORD_Y_PIC_OFFSET 3
#define B_POSITION_PLAYER_LEFT 0
#define B_POSITION_PLAYER_RIGHT 2
u8 GetBattlerSpriteCoord(u8 battler, u8 coord);
bool8 IsDoubleBattle(void);
u8 GetBattlerAtPosition(u8 position);
extern const struct OamData gOamData_AffineOff_ObjNormal_8x8;
extern const union AffineAnimCmd *const gDummySpriteAffineAnimTable[];
#endif
