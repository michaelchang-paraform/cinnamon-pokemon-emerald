// runs the game's own ball throw and ball-open particle callbacks (pulled out of the fetched sources by
// build-assets.mjs into SENDOUT_C) and prints what each frame would draw, as JSON:
// {"throw": {"<target y>": [[x, y, rotation], ...]}, "particles": [[[[dx, dy, tile, hflip], ...] per frame] per ball],
//  "wobble": [[turn, x shift], ...]}
// usage: sendout_rec <start x> <start y> <target x> <first target y> <last target y>
#include <stdio.h>
#include "global.h"
#include SENDOUT_C

static void ResetEngine(void) {
  struct Sprite blankSprite = {0};
  struct Task blankTask = {0};
  for (int i = 0; i < MAX_SPRITES; i++) gSprites[i] = blankSprite;
  for (int i = 0; i < 16; i++) gTasks[i] = blankTask;
}

static void RecordThrow(s16 startX, s16 startY, s16 targetX, s16 targetY) {
  ResetEngine();
  gSimTarget[0] = targetX;
  gSimTarget[1] = targetY - 24;
  struct Sprite *ball = &gSprites[0];
  ball->inUse = TRUE;
  ball->x = startX;
  ball->y = startY;
  ball->affineAnims = BALL_ROTATION_TABLE;
  StartSpriteAffineAnim(ball, 0);
  ball->data[0] = 0x80;
  ball->callback = PLAYER_THROW_START;
  printf("[");
  for (int frame = 0; frame < 400; frame++) {
    SpriteCallback before = ball->callback;
    ball->callback(ball);
    AnimateAffine(ball);
    if (before != PLAYER_THROW_START && ball->callback != before) break;
    if (before == PLAYER_THROW_START) continue;
    printf("%s[%d,%d,%d]", frame > 1 ? "," : "", ball->x + ball->x2, ball->y + ball->y2, ball->affineRotation);
  }
  printf("]");
}

static void RecordParticles(u8 ballId) {
  ResetEngine();
  u8 task = CreateTask(PARTICLE_TASKS[ballId], 5);
  gTasks[task].data[1] = 100;
  gTasks[task].data[2] = 100;
  gTasks[task].data[3] = 1;
  gTasks[task].data[4] = 28;
  gTasks[task].data[15] = ballId;
  printf("[");
  for (int frame = 0; frame < 200; frame++) {
    bool8 any = FALSE;
    for (int i = 0; i < 16; i++)
      if (gTasks[i].isActive) {
        gTasks[i].func(i);
        any = TRUE;
      }
    printf("%s[", frame ? "," : "");
    int shown = 0;
    for (int i = 0; i < MAX_SPRITES; i++) {
      struct Sprite *s = &gSprites[i];
      if (!s->inUse) continue;
      s->callback(s);
      if (!s->inUse) continue;
      AnimateSprite(s);
      any = TRUE;
      printf("%s[%d,%d,%d,%d]", shown++ ? "," : "", s->x - 100 + s->x2, s->y - 100 + s->y2, s->imageValue, s->hFlip);
    }
    printf("]");
    if (!any) break;
  }
  printf("]");
}

// two catch shakes with their waits, as the launcher repeats them: [turn, x shift] per frame
static void RecordWobble(void) {
  ResetEngine();
  struct Sprite *ball = &gSprites[0];
  ball->inUse = TRUE;
  ball->affineAnims = BALL_ROTATION_TABLE;
  StartSpriteAffineAnim(ball, 0);
  ball->data[3] = 30;
  ball->data[4] = 1;
  gBattleSpritesDataPtr->animationData->ballThrowCaseId = 0xFF;
  ball->callback = WOBBLE_START;
  printf("[");
  int restarts = 0, printed = 0;
  for (int frame = 0; frame < 1000 && restarts < 3; frame++) {
    SpriteCallback before = ball->callback;
    u16 state = ball->data[3];
    ball->callback(ball);
    AnimateAffine(ball);
    if (before == WOBBLE_START) continue;
    if ((state & 0xFF) != 0 && (ball->data[3] & 0xFF) == 0) restarts++;
    if (restarts >= 2 && (ball->data[3] & 0xFF) == 0 && printed) break;
    printf("%s[%d,%d]", printed++ ? "," : "", (s16)ball->affineRotation, ball->x2);
  }
  printf("]");
}

int main(int argc, char **argv) {
  if (argc != 6) return 2;
  struct SimAnimationData animation = {0};
  struct SimBattleSprites battleSprites = {&animation};
  gBattleSpritesDataPtr = &battleSprites;
  gMain.inBattle = FALSE;
  int startX = atoi(argv[1]), startY = atoi(argv[2]), targetX = atoi(argv[3]), first = atoi(argv[4]), last = atoi(argv[5]);
  printf("{\"throw\":{");
  for (int y = first; y <= last; y++) {
    printf("%s\"%d\":", y > first ? "," : "", y);
    RecordThrow(startX, startY, targetX, y);
  }
  printf("},\"particles\":[");
  for (u8 ballId = 0; ballId < POKEBALL_COUNT; ballId++) {
    printf(ballId ? "," : "");
    RecordParticles(ballId);
  }
  printf("],\"wobble\":");
  RecordWobble();
  printf("}\n");
  return 0;
}
