// The Emerald naming screen for a partner's nickname, drawn in the summary popup at the same scale: keyboard pages,
// cursor and buttons from pokeemerald's src/naming_screen.c. The real keyboard types too (IME composition included,
// so Hangul works). Keys: Space presses the key under the cursor, Return is OK, Delete erases, Tab swaps the page.
const R = (window as any).__pkp;

const NAME_MAX = 10;
// sKeyboardChars, by page: upper, lower, others
const KEYS = [
  ['ABCDEF .', 'GHIJKL ,', 'MNOPQRS ', 'TUVWXYZ '],
  ['abcdef .', 'ghijkl ,', 'mnopqrs ', 'tuvwxyz '],
  ['01234   ', '56789   ', '!?♂♀/-  ', '…“”‘\'   '],
];
// sPageColumnXPos; each key gets a 12 px cell (20 on the symbols page) and the cursor ring sits around the cell
const COLUMNS = [
  [0, 12, 24, 56, 68, 80, 92, 123],
  [0, 12, 24, 56, 68, 80, 92, 123],
  [0, 22, 44, 66, 88, 110],
];
const BACKGROUNDS = ['nam-upper', 'nam-lower', 'nam-others'];
// the swap button names the page it switches to
const SWAP_TEXT = ['nam-page_swap_lower', 'nam-page_swap_others', 'nam-page_swap_upper'];
// the game's button captions (SELECT, B BUTTON, START) replaced by the keys that do the same here
const BUTTONS: Array<{ img: string | null; x: number; y: number; w: number; h: number; cap: [number, number, number, number]; ring: { x: number; y: number; w: number; h: number }; key: string; label: string }> = [
  { img: 'nam-page_swap_frame', x: 184, y: 72, w: 40, h: 32, cap: [4, 19, 34, 8], ring: { x: 186, y: 76, w: 35, h: 14 }, key: 'TAB', label: 'Change page' },
  { img: 'nam-back_button', x: 184, y: 104, w: 40, h: 24, cap: [4, 16, 34, 8], ring: { x: 186, y: 105, w: 35, h: 13 }, key: 'DELETE', label: 'Delete' },
  { img: 'nam-ok_button', x: 184, y: 128, w: 40, h: 24, cap: [6, 14, 30, 8], ring: { x: 186, y: 129, w: 35, h: 10 }, key: 'RETURN', label: 'OK' },
];
const BASE_X = 92;
const LIGHT: [string, string] = ['ffffff', '626262'];
const INK: [string, string] = ['393939', 'd5d5cd'];

class Naming {
  private screen: any = null;
  private input: HTMLInputElement | null = null;
  private key: string | null = null;
  private chars: string[] = [];
  private composing = '';
  page = 0;
  x = 0;
  y = 0;
  onButtons = false;
  private renderToken = 0;

  isOpen(): boolean {
    return !!this.screen;
  }

  open(key: string | null): void {
    if (!key) return;
    if (!R.summary.node || R.summary.key !== key) R.summary.open(key);
    const host = R.summary.node as HTMLElement;
    this.close(false);
    this.key = key;
    this.chars = [...(R.store.nickname(key) ?? '')].slice(0, NAME_MAX);
    this.page = 0;
    this.x = this.y = 0;
    this.onButtons = false;
    this.screen = new R.Screen();
    this.screen.root.classList.add('pkp-naming');
    this.screen.root.setAttribute('role', 'group');
    this.screen.root.setAttribute('aria-label', 'Nickname');
    const input = (this.input = R.el('input', 'pkp-naming-input') as HTMLInputElement);
    input.setAttribute('aria-label', 'Nickname');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('compositionupdate', R.guard((e: CompositionEvent) => {
      this.composing = e.data ?? '';
      void this.render();
    }));
    input.addEventListener('compositionend', R.guard((e: CompositionEvent) => {
      this.composing = '';
      this.type(e.data ?? '');
      input.value = '';
    }));
    input.addEventListener('input', R.guard((e: InputEvent) => {
      if (e.isComposing) return;
      this.type(input.value);
      input.value = '';
    }));
    this.screen.root.append(input);
    host.querySelector(':scope > .pkp-gba:not(.pkp-naming)')?.setAttribute('hidden', '');
    host.append(this.screen.root);
    input.focus({ preventScroll: true });
    void this.render();
  }

  close(save: boolean): void {
    if (!this.screen) return;
    if (save && this.key) {
      const name = this.chars.join('').trim();
      const species = R.mon(this.key)?.name;
      R.store.setNickname(this.key, name && name !== species ? name : null);
      R.store.flush();
    }
    this.screen.root.remove();
    this.screen = this.input = null;
    const host = R.summary.node as HTMLElement | null;
    if (host) {
      host.querySelector(':scope > .pkp-gba[hidden]')?.removeAttribute('hidden');
      host.focus({ preventScroll: true });
      void R.summary.render();
    }
  }

  private type(value: string): void {
    const before = this.chars.length;
    for (const ch of [...value]) {
      if (ch === '\n' || ch === '\t') continue;
      if (this.chars.length >= NAME_MAX) break;
      this.chars.push(ch);
    }
    // naming_screen.c AddTextCharacter
    if (this.chars.length > before) R.sfx('SE_SELECT');
    void this.render();
  }

  // naming_screen.c DeleteTextCharacter plays SE_BALL even with nothing left to delete
  private erase(): void {
    this.chars.pop();
    R.sfx('SE_BALL');
  }

  // naming_screen.c KeyboardKeyHandler_OK
  private ok(): void {
    R.sfx('SE_SELECT');
    this.close(true);
  }

  private press(): void {
    if (this.onButtons) {
      if (this.y === 0) this.swap();
      else if (this.y === 1) this.erase();
      else return this.ok();
    } else {
      const ch = KEYS[this.page][this.y][this.x];
      if (ch && ch !== ' ') this.type(ch);
      if (this.chars.length >= NAME_MAX) {
        this.onButtons = true;
        this.y = 2;
      }
    }
    void this.render();
  }

  // naming_screen.c MainState_StartPageSwap
  private swap(): void {
    R.sfx('SE_WIN_OPEN');
    this.page = (this.page + 1) % 3;
    this.x = Math.min(this.x, COLUMNS[this.page].length - 1);
  }

  key_(event: KeyboardEvent): boolean {
    if (event.isComposing) return false;
    const cols = COLUMNS[this.page].length;
    switch (event.key) {
      case 'Escape':
        this.close(false);
        return true;
      case 'Enter':
        this.ok();
        return true;
      case ' ':
        this.press();
        return true;
      case 'Backspace':
        this.erase();
        break;
      case 'Tab':
        this.swap();
        break;
      case 'ArrowLeft':
        if (this.onButtons) {
          this.onButtons = false;
          this.x = cols - 1;
        } else if (this.x === 0) this.onButtons = true;
        else this.x--;
        break;
      case 'ArrowRight':
        if (this.onButtons) {
          this.onButtons = false;
          this.x = 0;
        } else if (this.x === cols - 1) this.onButtons = true;
        else this.x++;
        break;
      case 'ArrowUp':
        this.y = this.onButtons ? (this.y + 2) % 3 : (this.y + 3) % 4;
        break;
      case 'ArrowDown':
        this.y = this.onButtons ? (this.y + 1) % 3 : (this.y + 1) % 4;
        break;
      default:
        return false;
    }
    this.y = Math.min(this.y, this.onButtons ? 2 : 3);
    void this.render();
    return true;
  }

  // draws one state; exported for the overlap guard
  async render(): Promise<void> {
    const token = ++this.renderToken;
    const screen = this.screen;
    if (!screen || !this.key) return;
    const mon = R.mon(this.key);
    const ui = (name: string) => R.assets.ui(name);
    const [bg, icon, under, arrow, swapText, ...buttons] = await Promise.all([
      R.loadImage(ui(BACKGROUNDS[this.page])),
      R.loadImage(R.assets.url('i', mon.species)),
      R.loadImage(ui('nam-underscore')),
      R.loadImage(ui('nam-input_arrow')),
      R.loadImage(ui(SWAP_TEXT[this.page])),
      ...BUTTONS.map((b) => R.loadImage(ui(b.img!))),
      R.loadImage(ui('nam-page_swap_button')),
    ]);
    if (token !== this.renderToken || screen !== this.screen) return;
    screen.clear();
    screen.image(bg, 0, 0);
    screen.image(icon, 40, 24, 0, 0, 32, 32);
    screen.text(`${mon.name}'s nickname?`, 72, 33, INK, { inside: { x: 64, y: 32, w: 136, h: 16 }, name: 'title' });

    const shown = [...this.chars, ...[...this.composing]].slice(0, NAME_MAX);
    shown.forEach((ch, i) => screen.text(ch, BASE_X + i * 8, 49, INK, { center: 8, name: `char ${i + 1}`, inside: { x: 64, y: 48, w: 136, h: 16 } }));
    for (let i = 0; i < NAME_MAX; i++) screen.image(under, BASE_X + i * 8, 56 + (i === Math.min(shown.length, NAME_MAX - 1) ? 1 : 0));
    screen.image(arrow, BASE_X - 9, 52);

    const cell = this.page === 2 ? 20 : 12;
    KEYS[this.page].forEach((row, y) => {
      COLUMNS[this.page].forEach((cx, x) => {
        const ch = row[x];
        const rect = { x: 24 + cx, y: 80 + y * 16, w: cell, h: 16 };
        if (ch !== ' ') screen.text(ch, rect.x, rect.y, LIGHT, { center: cell, name: `key ${ch}`, inside: { x: 24, y: 80, w: 152, h: 64 } });
        screen.hit(rect, ch === ' ' ? 'Space' : `Type ${ch}`, () => {
          this.onButtons = false;
          this.x = x;
          this.y = y;
          this.press();
        });
      });
    });

    BUTTONS.forEach((b, i) => {
      screen.image(buttons[i], b.x, b.y);
      if (i === 0) {
        // the page-swap button at (204, 83) and its 24 px label sprite at (204, 84), both centred as in naming_screen.c
        screen.image(buttons[3], 188, 75);
        screen.image(swapText, 192, 80, 0, 0, 24, 8);
      }
      // the game's SELECT, B BUTTON and START captions name Game Boy buttons: the strip stays, blank
      const [cx, cy, cw, ch] = b.cap;
      screen.ctx.fillStyle = '#c5bdb4';
      screen.ctx.fillRect(b.x + cx, b.y + cy, cw, ch);
      const hit = screen.hit({ x: b.x, y: b.y, w: b.w, h: b.h }, `${b.label} (${b.key.toLowerCase()})`, () => {
        this.onButtons = true;
        this.y = i;
        this.press();
      });
      if (this.onButtons && this.y === i) {
        hit.setAttribute('data-active', '');
        screen.cursor(b.ring, 'ff0808', 'ffbd73', 'button cursor');
      }
    });
    // the real keys, as keycaps in the top banner, clear of every frame and button
    let right = 238;
    for (const [key, caption] of [['ESC', 'CANCEL'], ['RETURN', 'OK'], ['DELETE', 'BACK'], ['TAB', 'PAGE']].reverse().reverse()) {
      const rect = screen.keycap(key, caption, right, 1, `${key} key`);
      right = rect.x - 6;
    }
    if (!this.onButtons) {
      screen.cursor({ x: 24 + COLUMNS[this.page][this.x], y: 80 + this.y * 16, w: cell, h: 16 }, 'ff0808', 'ffbd73', 'key cursor');
    }
    this.input?.focus({ preventScroll: true });
  }
}

R.naming = new Naming();
R.cleanups.push(() => R.naming?.close(false));
