// runs every ANIM_* callback of pokemon_animation.c as Task_HandleMonAnimation starts it in battle and prints one
// JSON array per anim: frames of [x2, y2, xScale, yScale, rotation, blend coeff, blend RGB555, invisible]
#include <stdio.h>
#include "global.h"
#include POKEMON_ANIMATION_C

#define MAX_FRAMES 1200

int main(void) {
  printf("[");
  for (u32 id = 0; id < ARRAY_COUNT(sMonAnimFunctions); id++) {
    struct Sprite sprite = {0};
    sprite.oam.matrixNum = 1;
    sprite.sDontFlip = TRUE;
    sprite.animEnded = TRUE;
    sprite.callback = sMonAnimFunctions[id];
    sIsSummaryAnim = FALSE;
    gSimScale[0] = 256;
    gSimScale[1] = 256;
    gSimScale[2] = 0;
    gSimBlend[0] = 0;
    gSimBlend[1] = 0;
    printf(id ? ",[" : "[");
    for (int f = 0; f < MAX_FRAMES; f++) {
      sprite.callback(&sprite);
      bool8 affine = sprite.oam.affineMode != ST_OAM_AFFINE_OFF;
      printf("%s[%d,%d,%d,%d,%d,%d,%d,%d]", f ? "," : "", sprite.x2, sprite.y2, affine ? gSimScale[0] : 256,
             affine ? gSimScale[1] : 256, affine ? (u16)gSimScale[2] : 0, gSimBlend[0], gSimBlend[1], sprite.invisible);
      if (sprite.callback == WaitAnimEnd || sprite.callback == SpriteCallbackDummy) break;
    }
    printf("]");
  }
  printf("]\n");
  return 0;
}
