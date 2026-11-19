// the sprite, task, affine and palette calls the recorded game code makes, reduced to what changes a frame
#include "global.h"

struct OamMatrix gOamMatrices[32];
struct Task gTasks[16];
struct Sprite gSprites[MAX_SPRITES];
struct Pokemon gPlayerParty[6];
u8 gBattlerPartyIndexes[4];
struct Main gMain;
s16 gSimScale[3] = {256, 256, 0};
u16 gSimBlend[2];

void SpriteCallbackDummy(struct Sprite *sprite) {}

void ObjAffineSet(struct ObjAffineSrcData *src, void *dest, s32 count, s32 offset) {
  gSimScale[0] = src->xScale;
  gSimScale[1] = src->yScale;
  gSimScale[2] = (s16)src->rotation;
}

// duration 0 sets the matrix outright, as the first frame of sMonAffineAnims does; a sprite stepped with
// AnimateAffine also restarts its own rotation, which the next step begins to change
void StartSpriteAffineAnim(struct Sprite *sprite, u8 num) {
  const union AffineAnimCmd *cmd = &sprite->affineAnims[num][0];
  if (cmd->frame.duration == 0) {
    gSimScale[0] = cmd->frame.xScale;
    gSimScale[1] = cmd->frame.yScale;
    gSimScale[2] = cmd->frame.rotation << 8;
  }
  sprite->affineAnimEnded = TRUE;
  sprite->affineNum = num;
  sprite->affineIndex = 0;
  sprite->affineDelay = 0;
  sprite->affineRotation = 0;
  sprite->affineBeginning = TRUE;
}

// one step of an affine command list for rotation: a frame command lasting n frames turns on each of them, the
// first when it starts; a jump restarts at its target, an end stops; a paused sprite keeps its turn
static void TurnByFrame(struct Sprite *sprite) {
  const union AffineAnimCmd *cmd = &sprite->affineAnims[sprite->affineNum][sprite->affineIndex];
  if (cmd->type == AFFINEANIMCMDTYPE_JUMP) {
    sprite->affineIndex = cmd->jump.target;
    cmd = &sprite->affineAnims[sprite->affineNum][sprite->affineIndex];
  }
  if (cmd->type == AFFINEANIMCMDTYPE_END) return;
  if (cmd->frame.duration == 0) sprite->affineRotation = cmd->frame.rotation << 8;
  else sprite->affineRotation += cmd->frame.rotation << 8;
  sprite->affineDelay = cmd->frame.duration ? cmd->frame.duration - 1 : 0;
}

void AnimateAffine(struct Sprite *sprite) {
  if (!sprite->affineAnims) return;
  if (sprite->affineBeginning) {
    sprite->affineBeginning = FALSE;
    TurnByFrame(sprite);
    return;
  }
  if (sprite->affineDelay) {
    if (sprite->affineAnimPaused) return;
    sprite->affineDelay--;
    const union AffineAnimCmd *cmd = &sprite->affineAnims[sprite->affineNum][sprite->affineIndex];
    sprite->affineRotation += cmd->frame.rotation << 8;
    return;
  }
  if (sprite->affineAnimPaused) return;
  sprite->affineIndex++;
  TurnByFrame(sprite);
}

// switches the command list but keeps the turn so far
void ChangeSpriteAffineAnim(struct Sprite *sprite, u8 num) {
  sprite->affineNum = num;
  sprite->affineIndex = 0;
  sprite->affineDelay = 0;
  sprite->affineBeginning = TRUE;
  sprite->affineAnimEnded = FALSE;
}

void PlaySE(u16 song) {}

struct SimBattleSprites *gBattleSpritesDataPtr;
s16 gSimTarget[2];
const struct OamData gOamData_AffineOff_ObjNormal_8x8;
const union AffineAnimCmd *const gDummySpriteAffineAnimTable[] = { NULL };
u8 GetBattlerSpriteCoord(u8 battler, u8 coord) { return (coord == BATTLER_COORD_X || coord == BATTLER_COORD_X_2) ? gSimTarget[0] : gSimTarget[1]; }
bool8 IsDoubleBattle(void) { return FALSE; }
u8 GetBattlerAtPosition(u8 position) { return position; }
void DestroySpriteAndFreeResources(struct Sprite *sprite) { sprite->inUse = FALSE; }

void InitSpriteAffineAnim(struct Sprite *sprite) {}
void CalcCenterToCornerVec(struct Sprite *sprite, u8 shape, u8 size, u8 affineMode) {}
void FreeOamMatrix(u8 matrixNum) {}

void BlendPalette(u16 offset, u16 count, u8 coeff, u32 color) {
  gSimBlend[0] = coeff;
  gSimBlend[1] = (u16)color;
}

u8 CreateTask(TaskFunc func, u8 priority) {
  for (u8 i = 0; i < 16; i++) {
    if (gTasks[i].isActive) continue;
    struct Task blank = {0};
    gTasks[i] = blank;
    gTasks[i].func = func;
    gTasks[i].isActive = TRUE;
    return i;
  }
  return 16;
}

void DestroyTask(u8 taskId) { gTasks[taskId].isActive = FALSE; }
u8 GetNature(struct Pokemon *mon) { return mon->nature; }

u8 CreateSprite(const struct SpriteTemplate *template, s16 x, s16 y, u8 subpriority) {
  for (u8 i = 0; i < MAX_SPRITES; i++) {
    if (gSprites[i].inUse) continue;
    struct Sprite blank = {0};
    gSprites[i] = blank;
    gSprites[i].inUse = TRUE;
    gSprites[i].x = x;
    gSprites[i].y = y;
    gSprites[i].anims = template->anims;
    gSprites[i].callback = template->callback;
    gSprites[i].animBeginning = TRUE;
    return i;
  }
  return MAX_SPRITES;
}

void StartSpriteAnim(struct Sprite *sprite, u8 animNum) {
  sprite->animNum = animNum;
  sprite->animBeginning = TRUE;
  sprite->animEnded = FALSE;
}

void DestroySprite(struct Sprite *sprite) { sprite->inUse = FALSE; }

static void ApplyFrame(struct Sprite *sprite) {
  const union AnimCmd *cmd = &sprite->anims[sprite->animNum][sprite->animCmdIndex];
  u8 duration = cmd->frame.duration;
  sprite->imageValue = cmd->frame.imageValue;
  sprite->hFlip = cmd->frame.hFlip;
  sprite->vFlip = cmd->frame.vFlip;
  sprite->animDelayCounter = duration ? duration - 1 : 0;
}

// steps the frame animation of a sprite as the game does: frame, jump and end commands
void AnimateSprite(struct Sprite *sprite) {
  if (!sprite->anims) return;
  if (sprite->animBeginning) {
    sprite->animBeginning = FALSE;
    sprite->animCmdIndex = 0;
    sprite->animEnded = FALSE;
    ApplyFrame(sprite);
    return;
  }
  if (sprite->animEnded) return;
  if (sprite->animDelayCounter) {
    sprite->animDelayCounter--;
    return;
  }
  sprite->animCmdIndex++;
  s16 type = sprite->anims[sprite->animNum][sprite->animCmdIndex].type;
  if (type == -1) {
    sprite->animCmdIndex--;
    sprite->animEnded = TRUE;
  } else if (type == -3) {
    sprite->animCmdIndex = sprite->anims[sprite->animNum][sprite->animCmdIndex].jump.target;
    ApplyFrame(sprite);
  } else {
    ApplyFrame(sprite);
  }
}
