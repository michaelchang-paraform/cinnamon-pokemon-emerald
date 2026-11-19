declare const cinnamon: {
  settings: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    onChange(fn: (all: Record<string, unknown>) => void): void;
  };
  onDispose(fn: () => void): void;
};
type SideId = 'p1' | 'p2';
type Key = 'me' | 'foe';
type Msg = Record<string, any>;
type MenuItem = { label: string; disabled?: boolean; pick: () => void; cls?: string; decorate?: (row: HTMLElement) => void };
type Action = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back';
type Mon = { name: string; species: string; level: number; gender: string; hp: number; maxhp: number; status: string; fainted: boolean };
type SideState = { id: SideId; trainer: string; size: number; active: Mon | null; mons: Map<string, Mon> };
type ReqMon = { ident: string; details: string; condition: string; active?: boolean };
type ReqMove = { move: string; id: string; pp?: number; maxpp?: number; disabled?: boolean | string };
type BattleRequest = {
  wait?: boolean;
  forceSwitch?: boolean[];
  active?: Array<{ moves: ReqMove[]; trapped?: boolean; maybeTrapped?: boolean }>;
  side?: { name: string; id: string; pokemon: ReqMon[] };
};
type Pending = { request: BattleRequest; rqid: number | undefined };
type MonView = { root: HTMLElement; img: HTMLImageElement; ball: SVGSVGElement };
type Spot = { x: number; y: number };

const ns = (window as any).__pkb;
const { TEXT_MS, HOLD_MS, HP_STEP_MS, BAR, POKEMON, rt, debugLog, report, later, cancelLater, sleep, el,
   place, clamp, upper, moveText, monText, pixelArt, BALL, BALL_PAL, assets, canvasEl, imgEl, frameBox, parseLine, parseIdent, parseDetails, parseHp,
   hpPx, effectName, STAT_NAMES, WEATHER_START, WEATHER_UPKEEP, WEATHER_END, WEATHER_ABILITY, damageLine,
   healLine, statusLine, cantLine, sideLine, effectLine, cursorAt, peSound, WAIT } = ns;

const STATUS_ROW: Record<string, number> = { psn: 0, tox: 0, par: 1, slp: 2, frz: 3, brn: 4 };
const BAR_COLORS: Record<string, [string, string]> = { g: ['#5ad583', '#73ffac'], y: ['#cdac08', '#ffe639'], r: ['#ac414a', '#ff5a39'] };
const MOVE_SPOTS: Spot[] = [{ x: 16, y: 121 }, { x: 88, y: 121 }, { x: 16, y: 137 }, { x: 88, y: 137 }];
const ACTION_LABELS = ['FIGHT', 'BAG', POKEMON, 'RUN'];

function hpColor(px: number): string {
  return px > BAR / 2 ? 'g' : px > Math.floor(BAR / 5) ? 'y' : 'r';
}

function pad3(n: number): string {
  return String(Math.max(0, n));
}

class Battle {
  readonly id: string;
  readonly mode: 'cpu' | 'lan';
  readonly mySide: SideId;
  readonly foeSide: SideId;
  readonly myName: string;
  readonly foeName: string;
  readonly root = el('div', 'pkb-layer');
  turn = 0;
  weather = 'none';
  clocks: { mine: number; foe: number } = { mine: 0, foe: 0 };
  ended = false;
  dead = false;
  menuState: 'none' | 'actions' | 'fight' | 'party' | 'confirm' | 'wait' = 'none';
  spritesShown = 0;
  spritesBroken = 0;
  linesDone = 0;
  private sides: Record<SideId, SideState>;
  private queue: string[] = [];
  private running = false;
  private instant = false;
  private pendingRequest: Pending | null = null;
  private current: Pending | null = null;
  private pendingEnd: Msg | null = null;
  private texts: string[] = [];
  private effect: 'super' | 'weak' | null = null;
  private skip = false;
  private busy = false;
  private team: ReqMon[] = [];
  private actionIndex = 0;
  private moveIndex = 0;
  private partyIndex = 0;
  private partyForced = false;
  private partyNote = '';
  private partyNoteTimer = 0;
  private readonly boxes: Record<Key, HTMLCanvasElement>;
  private readonly mons: Record<Key, MonView>;
  private readonly weatherEl = el('div', 'pkb-weather');
  private readonly shadow: HTMLImageElement;
  private readonly textbox: HTMLImageElement;
  private readonly msg = canvasEl(208, 32, 'pkb-t');
  private readonly menuLayer = el('div', 'pkb-layer');
  private readonly partyLayer = el('div', 'pkb-layer');
  private msgText = '';
  private confirmIndex = 1;

  constructor(
    private readonly app: App,
    start: Msg,
  ) {
    this.id = String(start.battleId);
    this.mode = start.mode === 'lan' ? 'lan' : 'cpu';
    this.mySide = start.side === 'p2' ? 'p2' : 'p1';
    this.foeSide = this.mySide === 'p1' ? 'p2' : 'p1';
    this.myName = String(start.you?.name ?? 'You');
    this.foeName = String(start.opponent?.name ?? 'Trainer');
    this.instant = !!start.resumed;
    const side = (id: SideId, trainer: string): SideState => ({ id, trainer, size: 6, active: null, mons: new Map() });
    this.sides = { [this.mySide]: side(this.mySide, this.myName), [this.foeSide]: side(this.foeSide, this.foeName) } as Record<SideId, SideState>;

    this.root.append(place(imgEl(assets, 'bg'), 0, 0, 240, 112), this.weatherEl);
    this.shadow = place(imgEl(assets, 'shadow'), 160, 65, 32, 8);
    this.shadow.hidden = true;
    this.mons = { foe: this.monView(144, 8), me: this.monView(40, 48) };
    this.boxes = { foe: place(canvasEl(128, 32, 'pkb-box'), 12, 14), me: place(canvasEl(128, 64, 'pkb-box'), 126, 72) };
    this.boxes.foe.hidden = true;
    this.boxes.me.hidden = true;
    this.textbox = place(imgEl(assets, 'tbMsg'), 0, 112, 240, 48);
    place(this.msg, 16, 121);
    this.textbox.addEventListener('click', () => this.input('ok'));
    this.msg.addEventListener('click', () => this.input('ok'));
    this.root.append(this.shadow, this.mons.foe.root, this.mons.me.root, this.boxes.foe, this.boxes.me, this.textbox, this.msg, this.menuLayer, this.partyLayer);
    this.closeMenus();
    this.setText('');
  }

  private monView(x: number, y: number): MonView {
    const root = place(el('div', 'pkb-mon'), x, y);
    root.style.position = 'absolute';
    const img = el('img', 'pkb-sprite');
    img.alt = '';
    img.draggable = false;
    img.hidden = true;
    img.addEventListener('load', () => this.spritesShown++);
    img.addEventListener('error', () => this.spritesBroken++);
    const ball = pixelArt(BALL, BALL_PAL, 'pkb-ball');
    ball.style.display = 'none';
    root.append(img, ball);
    return { root, img, ball };
  }

  get fast(): boolean {
    return this.instant || !this.app.open || this.dead;
  }

  key(side: SideId): Key {
    return side === this.mySide ? 'me' : 'foe';
  }

  foeTrainer(): string {
    return upper(this.sides[this.foeSide].trainer || this.foeName);
  }

  label(ident: string | undefined): string {
    const p = parseIdent(ident);
    if (!p) return monText(ident ?? '');
    const name = monText(p.name);
    return p.side === this.mySide ? name : `Foe ${name}`;
  }

  private mon(ident: string | undefined): { side: SideState; mon: Mon | null; key: Key } | null {
    const p = parseIdent(ident);
    if (!p) return null;
    const side = this.sides[p.side];
    return { side, key: this.key(p.side), mon: side.mons.get(p.name) ?? (side.active?.name === p.name ? side.active : null) };
  }

  dispose(): void {
    this.dead = true;
    this.sound.cancel();
    cancelLater(this.partyNoteTimer);
    this.root.remove();
  }

  push(lines: string[]): void {
    if (this.dead) return;
    if (this.menuState !== 'none' && this.menuState !== 'wait' && this.current) {
      this.pendingRequest ??= this.current;
      this.closeMenus();
    }
    this.queue.push(...lines.filter((line) => typeof line === 'string'));
    void this.pump();
  }

  setRequest(msg: Msg): void {
    if (this.dead || !msg.request) return;
    this.pendingRequest = { request: msg.request as BattleRequest, rqid: msg.rqid };
    if (!this.running && !this.busy) this.showRequest();
  }

  choiceError(message: string): void {
    if (this.dead || !this.current) return;
    this.pendingRequest = this.current;
    void this.sayThen(/trapped|can't switch/i.test(message) ? "You can't switch out now!" : "That choice didn't work!");
  }

  private async sayThen(text: string): Promise<void> {
    if (this.running || this.busy) return;
    this.busy = true;
    this.closeMenus();
    await this.say(text, 600);
    this.busy = false;
    this.showRequest();
  }

  setTimer(msg: Msg): void {
    this.clocks[msg.forYou ? 'mine' : 'foe'] = Date.now() + Number(msg.secondsLeft) * 1000;
    this.app.renderBar();
  }

  end(msg: Msg): void {
    if (this.dead) return;
    this.pendingEnd = msg;
    this.ended = true;
    this.clocks = { mine: 0, foe: 0 };
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running || this.dead) return;
    this.running = true;
    if (this.menuState === 'wait') this.menuState = 'none';
    try {
      while (!this.dead) {
        const line = this.queue.shift();
        if (line === undefined) break;
        try {
          await this.handle(line);
        } catch (err) {
          report(err);
        }
        this.linesDone++;
      }
      if (this.dead) return;
      await this.flushTexts();
      this.instant = false;
      this.syncBoxes();
      if (this.pendingEnd) {
        const end = this.pendingEnd;
        this.pendingEnd = null;
        this.closeMenus();
        if (!this.fast) await sleep(500);
        if (!this.dead) this.app.battleOver(this, end);
      } else if (this.pendingRequest && !this.busy) {
        this.showRequest();
      }
    } finally {
      this.running = false;
      if (!this.dead && this.queue.length) void this.pump();
    }
  }

  private async wait(ms: number): Promise<void> {
    if (this.fast) return;
    await sleep(ms);
  }

  setText(text: string, prompt = false): void {
    this.msgText = text;
    place(this.msg, prompt ? 9 : 16, 121);
    assets.paint(this.msg, text, { width: prompt ? 112 : 208, color: 'msg', lineHeight: 16 });
  }

  async say(text: string, hold = HOLD_MS): Promise<void> {
    if (!text) return;
    this.textbox.src = assets.url('tbMsg');
    const lines = assets.wrap(text, 'normal', 208);
    const pages: string[] = [];
    for (let i = 0; i < lines.length; i += 2) pages.push(lines.slice(i, i + 2).join('\n'));
    for (const page of pages) {
      if (this.dead) return;
      if (this.fast) {
        this.setText(page);
        continue;
      }
      this.skip = false;
      for (let i = 1; i <= page.length; i++) {
        if (this.dead) return;
        if (this.skip || this.fast) i = page.length;
        this.setText(page.slice(0, i));
        if (i < page.length && page[i - 1] !== ' ') await sleep(TEXT_MS);
      }
      this.skip = false;
      const end = performance.now() + hold;
      while (performance.now() < end && !this.skip && !this.dead && !this.fast) await sleep(25);
      this.skip = false;
    }
  }

  private async flushTexts(): Promise<void> {
    const texts = this.texts.splice(0);
    this.effect = null;
    for (const text of texts) await this.say(text);
  }

  private async handle(line: string): Promise<void> {
    const { cmd, args, kw } = parseLine(line);
    if (!['-damage', '-supereffective', '-resisted', '-crit'].includes(cmd)) await this.flushTexts();
    const L = (ident?: string) => this.label(ident);
    switch (cmd) {
      case '':
      case 't:':
      case 'gametype':
      case 'gen':
      case 'tier':
      case 'rule':
      case 'upkeep':
      case 'seed':
      case 'rated':
      case 'clearpoke':
      case 'poke':
      case 'teampreview':
      case 'j':
      case 'J':
      case 'l':
      case 'L':
      case 'c':
      case 'chat':
      case 'raw':
      case 'html':
      case 'uhtml':
      case 'inactive':
      case 'inactiveoff':
      case 'debug':
      case '-hint':
      case '-center':
      case '-anim':
      case '-mustrecharge':
      case '-clearboost':
      case '-clearnegativeboost':
      case 'title':
      case 'timestamp':
        return;
      case 'player':
        if (args[0] === 'p1' || args[0] === 'p2') {
          if (args[1]) this.sides[args[0]].trainer = args[1];
        }
        return;
      case 'teamsize':
        if (args[0] === 'p1' || args[0] === 'p2') this.sides[args[0]].size = clamp(Number(args[1]) || 6, 1, 6);
        return;
      case 'start':
        await this.say(`${this.foeTrainer()} would like to battle!`);
        return;
      case 'switch':
      case 'drag':
      case 'replace':
        await this.switchIn(cmd, args);
        return;
      case 'detailschange':
      case '-formechange': {
        const found = this.mon(args[0]);
        if (found?.mon) {
          found.mon.species = parseDetails(args[1]).species;
          if (found.side.active === found.mon) this.setSprite(found.key, found.mon);
          if (cmd === '-formechange' && kw.silent === undefined) await this.say(`${L(args[0])} transformed!`);
        }
        return;
      }
      case 'move': {
        await this.say(`${L(args[0])} used ${moveText(args[1] ?? '')}!`, 250);
        const p = parseIdent(args[0]);
        if (!p || kw.still !== undefined || kw.miss !== undefined || kw.notarget !== undefined) return;
        const target = parseIdent(args[2]);
        const lead = this.fast ? 0 : this.sound.move(args[1] ?? '', this.key(p.side), target ? this.key(target.side) : null);
        await this.lunge(this.key(p.side));
        if (lead > 140) await this.wait(Math.min(lead, 3000) - 140);
        return;
      }
      case '-damage':
        await this.hpChange(args[0], args[1], kw, 'damage');
        return;
      case '-heal':
        await this.hpChange(args[0], args[1], kw, 'heal');
        return;
      case '-sethp':
        await this.hpChange(args[0], args[1], kw, 'set');
        return;
      case '-supereffective':
        this.texts.push("It's super effective!");
        this.effect = 'super';
        return;
      case '-resisted':
        this.texts.push("It's not very effective...");
        this.effect = 'weak';
        return;
      case '-crit':
        this.texts.unshift('A critical hit!');
        return;
      case '-immune':
        await this.say(`It doesn't affect ${L(args[0])}...`);
        return;
      case '-miss':
        await this.say(`${L(args[0])}'s attack missed!`);
        return;
      case '-fail':
        await this.say('But it failed!');
        return;
      case '-notarget':
        await this.say('But there was no target...');
        return;
      case '-nothing':
        await this.say('But nothing happened!');
        return;
      case '-ohko':
        await this.say("It's a one-hit KO!");
        return;
      case '-hitcount':
        await this.say(`Hit ${args[1]} time${args[1] === '1' ? '' : 's'}!`);
        return;
      case '-status':
        await this.statusChange(args[0], args[1], kw, true);
        return;
      case '-curestatus':
        await this.statusChange(args[0], args[1], kw, false);
        return;
      case '-cureteam': {
        const found = this.mon(args[0]);
        if (found) for (const mon of found.side.mons.values()) mon.status = mon.fainted ? 'fnt' : '';
        this.syncBoxes();
        await this.say('A bell chimed!');
        return;
      }
      case '-boost':
      case '-unboost':
        await this.boost(cmd === '-boost', args, kw);
        return;
      case '-setboost':
        await this.say(`${L(args[0])} cut its own HP and maximized ATTACK!`);
        return;
      case '-clearallboost':
        await this.say('All stat changes were eliminated!');
        return;
      case '-weather':
        await this.weatherChange(args[0], kw);
        return;
      case 'cant':
        await this.cant(args);
        return;
      case 'faint':
        await this.faint(args[0]);
        return;
      case '-start':
      case '-end':
      case '-activate':
      case '-singleturn':
      case '-singlemove':
      case '-prepare':
        await this.effectText(cmd, args, kw);
        return;
      case '-item':
        if (kw.from === 'move: Trick') await this.say(`${L(args[0])} obtained ${upper(args[1] ?? '')}.`);
        else if (/Thief|Covet/.test(kw.from ?? '')) await this.say(`${L(args[0])} stole ${upper(args[1] ?? '')}!`);
        return;
      case '-enditem': {
        const item = upper(args[1] ?? '');
        if (kw.from === 'move: Knock Off') await this.say(`${L(kw.of)} knocked off ${L(args[0])}'s ${item}!`);
        else if (/BERRY$/.test(item) || kw.eat !== undefined) await this.say(`${L(args[0])} ate its ${item}!`);
        else if (item === 'WHITE HERB') await this.say(`${L(args[0])}'s WHITE HERB restored its stats!`);
        else if (item === 'MENTAL HERB') await this.say(`${L(args[0])} used its MENTAL HERB!`);
        else if (!kw.from) await this.say(`${L(args[0])}'s ${item} was used up.`);
        return;
      }
      case '-ability': {
        const ability = effectName(args[1]);
        if (kw.from === 'ability: Trace' && kw.of) await this.say(`${L(args[0])} TRACED ${L(kw.of)}'s ${upper(ability)}!`);
        else if (ability === 'Pressure') await this.say(`${L(args[0])} is exerting its PRESSURE!`);
        else if (!['Intimidate', 'Drizzle', 'Drought', 'Sand Stream'].includes(ability)) await this.say(`${L(args[0])}'s ${upper(ability)}!`);
        return;
      }
      case '-transform': {
        const target = parseIdent(args[1]);
        await this.say(`${L(args[0])} transformed into ${target ? monText(target.name) : upper(args[1] ?? '')}!`);
        return;
      }
      case '-sidestart':
      case '-sideend':
        await this.sideText(cmd === '-sidestart', args);
        return;
      case '-fieldstart':
      case '-fieldend': {
        const effect = effectName(args[0]);
        if (cmd === '-fieldstart') await this.say(effect === 'Mud Sport' ? "Electricity's power was weakened!" : effect === 'Water Sport' ? "Fire's power was weakened!" : '');
        else await this.say(`The effects of ${upper(effect)} faded.`);
        return;
      }
      case '-message':
      case 'message':
        await this.say(args.join('|'));
        return;
      case 'turn':
        this.turn = Number(args[0]) || this.turn;
        this.app.renderBar();
        return;
      case 'win': {
        const won = args[0] === this.sides[this.mySide].trainer || args[0] === this.myName;
        this.sawWin = true;
        this.sound.lowHp(0, 1);
        if (this.mode === 'cpu') this.app.musicOutcome = won ? 'victory' : 'silent';
        this.app.music.sync(this.app, won ? 0 : 1000);
        await this.say(won ? `${upper(this.myName)} defeated ${this.foeTrainer()}!` : `${upper(this.myName)} lost to ${this.foeTrainer()}!`, 1200);
        return;
      }
      case 'tie':
        this.sawWin = true;
        this.sound.lowHp(0, 1);
        this.app.musicOutcome = 'silent';
        this.app.music.sync(this.app, 1000);
        await this.say('The battle ended in a draw!', 1200);
        return;
      default:
        debugLog.unknown[cmd] = (debugLog.unknown[cmd] ?? 0) + 1;
    }
  }

  private async switchIn(cmd: string, args: string[]): Promise<void> {
    const p = parseIdent(args[0]);
    if (!p) return;
    const side = this.sides[p.side];
    const key = this.key(p.side);
    const details = parseDetails(args[1]);
    const hp = parseHp(args[2]);
    const prev = side.active;
    if (cmd === 'switch' && prev && !prev.fainted && prev.name !== p.name) {
      await this.say(key === 'me' ? `${monText(prev.name)}, come back!` : `${this.foeTrainer()} withdrew ${monText(prev.name)}!`, 300);
      await this.recall(key);
    }
    const mon: Mon = side.mons.get(p.name) ?? { name: p.name, species: details.species, level: details.level, gender: details.gender, hp: 0, maxhp: 100, status: '', fainted: false };
    mon.species = details.species || mon.species;
    mon.level = details.level;
    mon.gender = details.gender;
    mon.maxhp = hp.max ?? mon.maxhp;
    mon.hp = hp.hp;
    mon.status = hp.status === 'fnt' ? '' : hp.status;
    mon.fainted = hp.status === 'fnt';
    side.mons.set(p.name, mon);
    side.active = mon;
    if (key === 'me') this.sound.lowHp(mon.hp, mon.maxhp);
    this.boxes[key].hidden = true;
    const name = monText(p.name);
    const text = cmd === 'drag' ? `${key === 'me' ? name : `Foe ${name}`} was dragged out!` : key === 'me' ? `Go! ${name}!` : `${this.foeTrainer()} sent out ${name}!`;
    await this.say(text, 150);
    await this.sendOut(key, mon);
    this.renderBox(key);
    this.boxes[key].hidden = false;
    await this.wait(250);
  }

  private setSprite(key: Key, mon: Mon): void {
    const view = this.mons[key];
    const data = assets.mon(mon.species);
    if (key === 'foe') {
      place(view.root, 144, (data ? data.fy - data.el : 16) + 8);
      this.shadow.hidden = !data?.el;
    } else place(view.root, 40, Math.min((data?.by ?? 8) + 88, 104) - 32);
    const url = assets.sprite(mon.species, key === 'me' ? 'b' : 'f');
    if (url) {
      if (view.img.getAttribute('src') !== url) view.img.src = url;
      view.img.dataset.missing = '';
    } else {
      view.img.removeAttribute('src');
      view.img.dataset.missing = '1';
    }
  }

  balls = new Map<string, string>();
  sawWin = false;
  readonly sound = new ns.BattleSound(
    () => !this.fast && !(this.app.floating && this.app.floatState().min),
    (key: Key) => assets.mon(this.sides[key === 'me' ? this.mySide : this.foeSide].active?.species ?? '')?.n ?? null,
  );

  private async sendOut(key: Key, mon: Mon): Promise<void> {
    const view = this.mons[key];
    this.setSprite(key, mon);
    view.img.style.transform = '';
    view.img.style.filter = '';
    if (!this.fast && ns.sendOutEnabled?.() && (await ns.sendOutV2(this, key, mon))) return;
    if (this.fast) {
      view.ball.style.display = 'none';
      view.img.hidden = !view.img.getAttribute('src');
      if (view.img.hidden) view.ball.style.display = '';
      return;
    }
    view.img.hidden = true;
    view.ball.style.display = '';
    this.sound.ballOpen();
    await this.wait(260);
    view.ball.style.display = 'none';
    if (!view.img.getAttribute('src')) {
      view.ball.style.display = '';
      return;
    }
    view.img.hidden = false;
    for (const scale of [0.25, 0.5, 0.75, 1]) {
      view.img.style.transform = `scale(${scale})`;
      view.img.style.filter = scale < 1 ? 'brightness(2.6)' : '';
      await this.wait(55);
    }
    view.img.style.transform = '';
    view.img.style.filter = '';
  }

  private async recall(key: Key): Promise<void> {
    const view = this.mons[key];
    if (this.fast) {
      view.img.hidden = true;
      return;
    }
    this.sound.ballOpen();
    for (const scale of [0.75, 0.5, 0.25]) {
      view.img.style.transform = `scale(${scale})`;
      view.img.style.filter = 'sepia(1) saturate(6) hue-rotate(-40deg) brightness(1.2)';
      await this.wait(55);
    }
    view.img.hidden = true;
    view.img.style.transform = '';
    view.img.style.filter = '';
    this.boxes[key].hidden = true;
    if (key === 'foe') this.shadow.hidden = true;
  }

  private async lunge(key: Key): Promise<void> {
    if (this.fast) return;
    const img = this.mons[key].img;
    const dir = key === 'me' ? 1 : -1;
    for (const step of [3, 6, 3, 0]) {
      img.style.transform = step ? `translateX(calc(var(--u) * ${step * dir}))` : '';
      await this.wait(35);
    }
  }

  private async blink(key: Key): Promise<void> {
    if (this.fast) return;
    const img = this.mons[key].img;
    this.sound.hit(key, this.effect);
    for (let i = 0; i < 4; i++) {
      img.style.visibility = 'hidden';
      await this.wait(55);
      img.style.visibility = '';
      await this.wait(55);
    }
  }

  private async hpChange(ident: string | undefined, hpText: string | undefined, kw: Record<string, string>, kind: 'damage' | 'heal' | 'set'): Promise<void> {
    const found = this.mon(ident);
    if (!found?.mon) return;
    const { mon, key, side } = found;
    const hp = parseHp(hpText);
    const active = side.active === mon;
    if (kind === 'damage' && kw.from === undefined && active) await this.blink(key);
    if (kw.from !== undefined && active && !this.fast) this.sound.effect(kw.from, key, true);
    const max = hp.max ?? mon.maxhp;
    if (active) await this.animateHp(key, mon, hp.hp, max);
    else {
      mon.hp = hp.hp;
      mon.maxhp = max;
    }
    if (hp.status && hp.status !== 'fnt') mon.status = hp.status;
    if (active) this.renderBox(key);
    const L = this.label(ident);
    const from = effectName(kw.from);
    if (kind === 'damage') {
      if (kw.from === undefined) {
        await this.flushTexts();
        return;
      }
      await this.say(damageLine(from, L));
    } else if (kind === 'heal') {
      await this.say(healLine(from, L, kw, this.label(kw.of)));
    }
  }

  private async animateHp(key: Key, mon: Mon, toHp: number, toMax: number): Promise<void> {
    const from = mon.hp;
    const fromMax = mon.maxhp;
    mon.maxhp = toMax;
    const fromPx = hpPx(from, fromMax);
    const toPx = hpPx(toHp, toMax);
    if (!this.fast && fromPx !== toPx) {
      const steps = Math.abs(toPx - fromPx);
      const dir = Math.sign(toPx - fromPx);
      for (let i = 1; i <= steps; i++) {
        if (this.dead) return;
        this.paintBar(key, fromPx + dir * i, Math.round(from + ((toHp - from) * i) / steps), toMax);
        if (this.fast) break;
        await sleep(HP_STEP_MS);
      }
    }
    mon.hp = toHp;
    this.renderBox(key);
    if (key === 'me') this.sound.lowHp(toHp, toMax);
  }

  private paintBar(key: Key, px: number, hp: number, max: number): void {
    this.drawBox(key, px, hp, max);
  }

  private renderBox(key: Key): void {
    const mon = this.sides[key === 'me' ? this.mySide : this.foeSide].active;
    if (mon) this.drawBox(key, hpPx(mon.hp, mon.maxhp), mon.hp, mon.maxhp);
  }

  private drawBox(key: Key, px: number, hp: number, max: number): void {
    const mon = this.sides[key === 'me' ? this.mySide : this.foeSide].active;
    const canvas = this.boxes[key];
    const ctx = canvas.getContext('2d');
    if (!mon || !ctx) return;
    const me = key === 'me';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const base = assets.image(me ? 'hbPlayer' : 'hbFoe');
    if (base) ctx.drawImage(base, 0, 0);
    const nameX = me ? 16 : 8;
    const width = assets.draw(ctx, monText(mon.name), nameX, 3, 'small', 'hb');
    if (mon.gender === 'M' || mon.gender === 'F') assets.draw(ctx, mon.gender === 'M' ? '\u2642' : '\u2640', nameX + width, 3, 'small', mon.gender === 'M' ? 'male' : 'female');
    const level = String(mon.level);
    assets.draw(ctx, `\u0001${level}`, (me ? 72 : 64) + 5 * (3 - level.length), 3, 'small', 'hb');
    const status = mon.fainted ? '' : mon.status;
    const row = STATUS_ROW[status];
    const icons = assets.image('status');
    const barX = me ? 48 : 40;
    if (row !== undefined && icons) ctx.drawImage(icons, 0, row * 8, 24, 8, me ? 16 : 8, me ? 24 : 16, 24, 8);
    const label = assets.image('hpbar');
    if (label && (me || row === undefined)) ctx.drawImage(label, 8, 0, 16, 8, barX - 16, 16, 16, 8);
    // UpdateStatusIconInHealthbox: on the foe box the status icon takes the HP label's place and the bar keeps its frame end
    const frameEnd = assets.image('hbFrameEnd');
    if (frameEnd && !me && row !== undefined) ctx.drawImage(frameEnd, barX - 8, 16);
    const [dark, light] = BAR_COLORS[hpColor(px)];
    const rows: Array<[number, string, string]> = [[17, '#526a5a', '#526a5a'], [18, '#ffffff', '#ffffff'], [19, dark, '#4a415a'], [20, light, '#526a5a'], [21, '#ffffff', '#ffffff'], [22, '#526a5a', '#526a5a']];
    for (const [y, full, empty] of rows) {
      ctx.fillStyle = full;
      if (px > 0) ctx.fillRect(barX, y, px, 1);
      ctx.fillStyle = empty;
      if (px < BAR) ctx.fillRect(barX + px, y, BAR - px, 1);
    }
    if (!me) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(56, 24, 40, 8);
    ctx.clip();
    const current = pad3(hp);
    assets.draw(ctx, current, 75 - assets.measure(current, 'small'), 21, 'small', 'hb');
    assets.draw(ctx, '/', 75, 21, 'small', 'hb');
    const total = pad3(max);
    assets.draw(ctx, total, 95 - assets.measure(total, 'small'), 21, 'small', 'hb');
    ctx.restore();
    const exp = Math.round(((mon.level * 37 + mon.name.length * 11) % 60) + 2);
    ctx.fillStyle = '#41cdff';
    ctx.fillRect(32, 35, exp, 2);
  }

  private syncBoxes(): void {
    for (const key of ['me', 'foe'] as Key[]) {
      const side = this.sides[key === 'me' ? this.mySide : this.foeSide];
      if (side.active && !side.active.fainted) {
        this.setSprite(key, side.active);
        this.renderBox(key);
        this.boxes[key].hidden = false;
        const view = this.mons[key];
        if (view.img.getAttribute('src')) {
          view.img.hidden = false;
          view.ball.style.display = 'none';
        }
      }
    }
    this.weatherEl.dataset.weather = this.weather;
  }

  private async statusChange(ident: string | undefined, status: string | undefined, kw: Record<string, string>, start: boolean): Promise<void> {
    const found = this.mon(ident);
    const L = this.label(ident);
    const s = status ?? '';
    if (found?.mon) {
      found.mon.status = start ? s : '';
      if (found.side.active === found.mon) this.renderBox(found.key);
    } else if (!start) {
      const p = parseIdent(ident);
      const mon = p ? this.sides[p.side].mons.get(p.name) : null;
      if (mon) mon.status = '';
    }
    if (start && !this.fast && found) this.sound.status(found.key, s);
    if (start && kw.from === 'move: Rest') return this.say(`${L} slept and became healthy!`);
    if (!start && kw.silent !== undefined) return;
    await this.say(statusLine(start, s, L));
  }

  private async boost(up: boolean, args: string[], kw: Record<string, string>): Promise<void> {
    const L = this.label(args[0]);
    const stat = STAT_NAMES[args[1]] ?? upper(args[1] ?? '');
    const n = Number(args[2]);
    const p = parseIdent(args[0]);
    if (!this.fast && n && p) this.sound.stat(this.key(p.side), up);
    if (kw.from === 'ability: Intimidate' && kw.of) {
      await this.say(`${this.label(kw.of)}'s INTIMIDATE cuts ${L}'s ${stat}!`);
      return;
    }
    if (kw.silent !== undefined) return;
    if (!n) await this.say(`${L}'s ${stat} won't go ${up ? 'higher' : 'lower'}!`);
    else if (up) await this.say(`${L}'s ${stat} ${n === 1 ? 'rose' : n === 2 ? 'sharply rose' : 'rose drastically'}!`);
    else await this.say(`${L}'s ${stat} ${n === 1 ? 'fell' : n === 2 ? 'harshly fell' : 'severely fell'}!`);
  }

  private async weatherChange(weather: string | undefined, kw: Record<string, string>): Promise<void> {
    const w = weather ?? 'none';
    if (kw.upkeep !== undefined) {
      if (!this.fast) this.sound.weather(w, 'me');
      this.weatherEl.dataset.weather = w;
      await this.say(WEATHER_UPKEEP[w] ?? '');
      return;
    }
    if (w === 'none') {
      const prev = this.weather;
      this.weather = 'none';
      this.weatherEl.dataset.weather = 'none';
      this.app.renderBar();
      await this.say(WEATHER_END[prev] ?? '');
      return;
    }
    this.weather = w;
    this.weatherEl.dataset.weather = w;
    this.app.renderBar();
    const by = parseIdent(kw.of);
    if (kw.from?.startsWith('ability:') && by && !this.fast) this.sound.weather(w, this.key(by.side));
    if (kw.from?.startsWith('ability:') && kw.of) await this.say(`${this.label(kw.of)}'s ${upper(effectName(kw.from))} ${WEATHER_ABILITY[w] ?? ''}`);
    else await this.say(WEATHER_START[w] ?? '');
  }

  private async cant(args: string[]): Promise<void> {
    const p = parseIdent(args[0]);
    if (p && !this.fast) {
      if (['slp', 'frz', 'par'].includes(args[1] ?? '')) this.sound.status(this.key(p.side), args[1]);
      else this.sound.effect(args[1], this.key(p.side), false);
    }
    await this.say(cantLine(this.label(args[0]), effectName(args[1]), upper(effectName(args[2]))));
  }

  private async faint(ident: string | undefined): Promise<void> {
    const found = this.mon(ident);
    if (!found?.mon) return;
    const { mon, key, side } = found;
    mon.fainted = true;
    mon.hp = 0;
    mon.status = '';
    const view = this.mons[key];
    if (key === 'me') this.sound.lowHp(0, 1);
    if (side.active === mon && !this.fast) {
      const dex = assets.mon(mon.species)?.n;
      if (dex) {
        this.sound.cry(dex, key, 'faint');
        await this.wait(600);
      }
      this.sound.faint(key);
      for (let i = 1; i <= 8; i++) {
        view.img.style.transform = `translateY(calc(var(--u) * ${i * 8}))`;
        await this.wait(28);
      }
    }
    view.img.hidden = true;
    view.img.style.transform = '';
    this.boxes[key].hidden = true;
    if (key === 'foe') this.shadow.hidden = true;
    if (key === 'me') {
      const entry = this.team.find((m) => parseIdent(m.ident)?.name === mon.name);
      if (entry) entry.condition = '0 fnt';
    }
    await this.say(`${this.label(ident)} fainted!`);
  }

  private async effectText(cmd: string, args: string[], kw: Record<string, string>): Promise<void> {
    const p = parseIdent(args[0]);
    if (p && !this.fast) {
      if (cmd === '-prepare') this.sound.move(args[1] ?? '', this.key(p.side), parseIdent(args[2]) ? this.key(parseIdent(args[2])!.side) : null, true);
      else if (cmd === '-start' || cmd === '-activate') this.sound.effect(args[1], this.key(p.side), false);
    }
    await this.say(effectLine(cmd, args, kw, this.label(args[0]), kw.of ? this.label(kw.of) : 'the foe'));
  }

  private async sideText(start: boolean, args: string[]): Promise<void> {
    await this.say(sideLine(start, /^(p[12])/.exec(args[0] ?? '')?.[1] === this.mySide, effectName(args[1])));
  }

  private syncTeam(req: BattleRequest): void {
    const pokemon = req.side?.pokemon;
    if (!Array.isArray(pokemon)) return;
    this.team = pokemon.map((m) => ({ ...m }));
    const me = this.sides[this.mySide];
    for (const entry of this.team) {
      const name = parseIdent(entry.ident)?.name;
      if (!name) continue;
      const mon = me.mons.get(name);
      if (!mon) continue;
      const hp = parseHp(entry.condition);
      mon.hp = hp.hp;
      if (hp.max) mon.maxhp = hp.max;
      mon.fainted = hp.status === 'fnt';
      mon.status = mon.fainted ? '' : hp.status;
    }
    if (me.active && !me.active.fainted) this.renderBox('me');
  }

  private showRequest(): void {
    if (this.dead || this.ended) return;
    const pending = this.pendingRequest;
    if (!pending) return;
    this.pendingRequest = null;
    this.current = pending;
    const req = pending.request;
    this.syncTeam(req);
    this.closeMenus();
    if (req.wait) {
      this.menuState = 'wait';
      this.setText(this.waitText());
    } else if (req.forceSwitch?.[0]) {
      this.openParty(true);
    } else if (req.active?.[0]) {
      this.openActions();
    }
    this.app.updateBadge();
  }

  get needsInput(): boolean {
    return !!this.current && this.menuState !== 'wait' && this.menuState !== 'none';
  }

  private closeMenus(): void {
    this.menuState = 'none';
    this.menuLayer.replaceChildren();
    this.partyLayer.hidden = true;
    this.textbox.src = assets.url('tbMsg');
    this.msg.hidden = false;
  }

  private activeName(): string {
    return monText(this.sides[this.mySide].active?.name ?? POKEMON);
  }

  private openActions(): void {
    const req = this.current?.request;
    if (!req?.active?.[0]) return;
    this.closeMenus();
    this.menuState = 'actions';
    this.textbox.src = assets.url('tbAction');
    this.setText(`What will\n${this.activeName()} do?`, true);
    this.renderActions();
  }

  private hit(x: number, y: number, w: number, h: number, hover: () => void, pick: () => void): HTMLElement {
    const node = place(el('div', 'pkb-hit'), x, y, w, h);
    node.addEventListener('pointerenter', hover);
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      hover();
      pick();
    });
    return node;
  }

  private renderActions(): void {
    const spot = (i: number) => ({ x: 136 + 56 * (i & 1), y: 121 + 16 * (i >> 1) });
    const labels = ACTION_LABELS.map((label, i) => place(assets.text(label, { color: 'menu' }), spot(i).x, spot(i).y));
    this.menuLayer.replaceChildren(...labels, cursorAt(spot(this.actionIndex).x, spot(this.actionIndex).y));
    ACTION_LABELS.forEach((_, i) =>
      this.menuLayer.append(
        this.hit(128 + 56 * (i & 1), 120 + 16 * (i >> 1), 56, 16, () => {
          if (this.actionIndex === i) return;
          this.actionIndex = i;
          this.renderActions();
        }, () => this.pickAction()),
      ),
    );
  }

  private pickAction(): void {
    const trapped = !!this.current?.request.active?.[0]?.trapped;
    peSound('SE_SELECT');
    if (this.actionIndex === 0) this.openFight();
    else if (this.actionIndex === 1) void this.notice("There's no BAG in a link battle!", () => this.openActions());
    else if (this.actionIndex === 2) {
      if (trapped) void this.notice(`${this.activeName()} can't be switched out!`, () => this.openActions());
      else this.openParty(false);
    } else this.openConfirm();
  }

  private gridMove(index: number, action: Action, count: number): number {
    let col = index & 1;
    let row = index >> 1;
    if (action === 'left') col = 0;
    else if (action === 'right') col = 1;
    else if (action === 'up') row = 0;
    else if (action === 'down') row = 1;
    const next = row * 2 + col;
    if (next >= count || next === index) return index;
    peSound('SE_SELECT');
    return next;
  }

  private async notice(text: string, then: () => void): Promise<void> {
    this.closeMenus();
    this.busy = true;
    await this.say(text, 700);
    this.busy = false;
    if (this.pendingRequest) this.showRequest();
    else then();
  }

  private moves(): ReqMove[] {
    return this.current?.request.active?.[0]?.moves ?? [];
  }

  private openFight(): void {
    this.closeMenus();
    this.menuState = 'fight';
    this.textbox.src = assets.url('tbMove');
    this.msg.hidden = true;
    this.moveIndex = clamp(this.moveIndex, 0, Math.max(0, this.moves().length - 1));
    this.renderFight();
  }

  private renderFight(): void {
    const moves = this.moves();
    const layer = this.menuLayer;
    layer.replaceChildren();
    MOVE_SPOTS.forEach((spot, i) => {
      const move = moves[i];
      layer.append(place(assets.text(move ? moveText(move.move) : '-', { font: 'narrow', color: 'menu' }), spot.x, spot.y));
      if (move)
        layer.append(
          this.hit(spot.x - 8, spot.y - 1, 72, 16, () => {
            if (this.moveIndex === i) return;
            this.moveIndex = i;
            this.renderFight();
          }, () => this.pickMove()),
        );
    });
    layer.append(cursorAt(MOVE_SPOTS[this.moveIndex].x, MOVE_SPOTS[this.moveIndex].y));
    layer.append(place(assets.text('PP', { font: 'narrow', color: 'menu' }), 168, 121));
    const move = moves[this.moveIndex];
    if (!move) return;
    let color = 'menu';
    let nums = '--/--';
    if (move.pp !== undefined && move.maxpp !== undefined) {
      nums = `${String(move.pp).padStart(2, ' ')}/${String(move.maxpp).padStart(2, ' ')}`;
      const ratio = move.pp / Math.max(1, move.maxpp);
      color = move.pp === 0 ? 'pp3' : ratio <= 0.25 ? 'pp2' : ratio <= 0.5 ? 'pp1' : 'menu';
    }
    layer.append(place(assets.text(nums, { color }), 202, 121));
    layer.append(place(assets.text('TYPE/', { font: 'narrow', color: 'menu' }), 168, 137));
    layer.append(place(assets.text(assets.moveType(move.id, move.move), { color: 'menu' }), 168 + assets.measure('TYPE/', 'narrow'), 137));
  }

  private pickMove(): void {
    const move = this.moves()[this.moveIndex];
    if (!move) return;
    const empty = move.pp !== undefined && move.maxpp !== undefined && move.pp <= 0;
    peSound('SE_SELECT');
    if (empty || move.disabled) void this.notice(empty ? "There's no PP left for this move!" : `${moveText(move.move)} is disabled!`, () => this.openFight());
    else this.choose(`move ${this.moveIndex + 1}`);
  }

  private openConfirm(): void {
    this.closeMenus();
    this.menuState = 'confirm';
    this.confirmIndex = 1;
    this.setText('Forfeit this battle?');
    this.renderConfirm();
  }

  private renderConfirm(): void {
    const layer = this.menuLayer;
    layer.replaceChildren(frameBox(200, 72, 32, 32));
    ['YES', 'NO'].forEach((label, i) => {
      layer.append(place(assets.text(label, { color: 'std' }), 208, 73 + i * 16));
      layer.append(this.hit(200, 72 + i * 16, 32, 16, () => {
        if (this.confirmIndex === i) return;
        this.confirmIndex = i;
        this.renderConfirm();
      }, () => this.pickConfirm()));
    });
    layer.append(cursorAt(208, 73 + this.confirmIndex * 16));
  }

  private pickConfirm(): void {
    peSound('SE_SELECT');
    if (this.confirmIndex === 0) this.forfeit();
    else this.openActions();
  }

  forfeit(): void {
    this.closeMenus();
    this.app.link.send({ type: 'forfeit', battleId: this.id });
    this.app.musicOutcome = 'silent';
    this.app.music.sync(this.app, 1000);
    this.setText(`${upper(this.myName)} forfeited the battle!`);
  }

  private lastChoice: Record<string, unknown> | null = null;
  private foeThinking = false;
  private fallbackNote = false;
  private fallbackReason = '';

  private waitText(): string {
    if (this.fallbackNote) {
      this.fallbackNote = false;
      return String(ns.CLAUDE_FALLBACK_TEXT?.[this.fallbackReason] ?? ns.CLAUDE_FALLBACK ?? 'The CPU takes over.');
    }
    if (this.foeThinking) return `${this.foeTrainer()} is thinking${WAIT}`;
    return this.mode === 'lan' ? `Communicating${WAIT}\nPlease wait.` : '';
  }

  thinking(on: boolean): void {
    this.foeThinking = on;
    if (this.menuState === 'wait' && !this.running) this.setText(this.waitText());
  }

  fallback(reason = ''): void {
    this.fallbackNote = true;
    this.fallbackReason = reason;
    this.foeThinking = false;
    if (this.menuState === 'wait' && !this.running) this.setText(this.waitText());
  }

  resendChoice(): boolean {
    if (!this.lastChoice || this.dead) return false;
    const choice = this.lastChoice;
    later(() => this.app.link.send(choice), 50);
    return true;
  }

  private choose(choice: string): void {
    const current = this.current;
    if (!current) return;
    this.lastChoice = { type: 'choose', battleId: this.id, choice, rqid: current.rqid };
    this.app.link.send(this.lastChoice);
    this.clocks.mine = 0;
    this.closeMenus();
    this.menuState = 'wait';
    this.setText(this.waitText());
    this.app.updateBadge();
  }

  private openParty(forced: boolean): void {
    this.closeMenus();
    this.menuState = 'party';
    this.partyForced = forced;
    this.partyNote = '';
    const activeIndex = this.team.findIndex((m) => m.active);
    if (forced || this.partyIndex === activeIndex) {
      const firstOk = this.team.findIndex((m) => !m.active && !/fnt$/.test(m.condition));
      this.partyIndex = firstOk >= 0 ? firstOk : 0;
    }
    this.renderParty();
    this.partyLayer.hidden = false;
    this.setText(forced ? 'Choose a POKÉMON.' : '');
  }

  private renderParty(): void {
    const layer = this.partyLayer;
    layer.replaceChildren(place(imgEl(assets, 'partyBg'), 0, 0, 240, 160));
    const slots = this.team.slice(0, 6);
    slots.forEach((entry, i) => {
      const main = i === 0;
      const hp = parseHp(entry.condition);
      const fnt = hp.status === 'fnt';
      const on = i === this.partyIndex;
      const state = fnt ? (on ? 'fntOn' : 'fnt') : on ? 'on' : 'plain';
      const x = main ? 8 : 96;
      const y = main ? 24 : 8 + (i - 1) * 24;
      const w = main ? 80 : 144;
      const h = main ? 56 : 24;
      const details = parseDetails(entry.details);
      const name = parseIdent(entry.ident)?.name ?? details.species;
      const max = hp.max ?? this.sides[this.mySide].mons.get(name)?.maxhp ?? 0;
      const canvas = place(canvasEl(w, h, 'pkb-box'), x, y);
      const r = main ? { n: [24, 11], l: [32, 20], g: [64, 20], hp: [38, 37], max: [53, 37], bar: [24, 35] } : { n: [22, 3], l: [30, 12], g: [62, 12], hp: [102, 12], max: [117, 12], bar: [88, 10] };
      const paint = () => {
        const ctx = canvas.getContext('2d')!;
        const slot = assets.image(`${main ? 'slotMain' : 'slotWide'}_${state}`);
        if (slot) ctx.drawImage(slot, 0, 0);
        const colors = assets.data?.slot[state];
        const pair = colors ? [colors.text, colors.shadow] : 'white';
        assets.draw(ctx, monText(name), r.n[0], r.n[1], 'small', pair);
        assets.draw(ctx, `\u0001${details.level}`, r.l[0], r.l[1], 'small', pair);
        if (details.gender) assets.draw(ctx, details.gender === 'M' ? '\u2642' : '\u2640', r.g[0], r.g[1], 'small', details.gender === 'M' ? 'male' : 'female');
        const current = String(hp.hp);
        assets.draw(ctx, current, r.max[0] - assets.measure(current, 'small'), r.hp[1], 'small', pair);
        assets.draw(ctx, `/${max}`, r.max[0], r.max[1], 'small', pair);
        const px = Math.round((hp.hp / Math.max(1, max)) * BAR);
        const fill = assets.data?.hp[hpColor(px)];
        if (fill && px > 0) {
          ctx.fillStyle = `rgb(${fill[1].join(',')})`;
          ctx.fillRect(r.bar[0], r.bar[1], px, 1);
          ctx.fillStyle = `rgb(${fill[0].join(',')})`;
          ctx.fillRect(r.bar[0], r.bar[1] + 1, px, 2);
        }
        if (colors) {
          for (let bx = r.bar[0] + px; bx < r.bar[0] + BAR; bx += 2) {
            ctx.fillStyle = `rgb(${colors.hpEmptyTop.join(',')})`;
            ctx.fillRect(bx + 1, r.bar[1], 1, 1);
            ctx.fillStyle = `rgb(${colors.hpEmpty.join(',')})`;
            ctx.fillRect(bx + 1, r.bar[1] + 1, 1, 2);
          }
        }
        const row = STATUS_ROW[fnt ? '' : hp.status];
        const icons = assets.image('status');
        if (row !== undefined && icons) ctx.drawImage(icons, 0, row * 8, 24, 8, main ? 26 : 32, main ? 24 : 15, 24, 8);
      };
      assets.onReady(paint);
      const icon = place(el('div', `pkb-icon${on && !fnt ? ' is-on' : ''}`), main ? 0 : 88, main ? 24 : 2 + (i - 1) * 24, 32, 32);
      const url = assets.sprite(details.species, 'i');
      if (url) {
        const img = el('img');
        img.src = url;
        img.alt = '';
        img.draggable = false;
        icon.append(img);
      }
      layer.append(canvas, icon, this.hit(x, y, w, h, () => {
        if (this.partyIndex === i) return;
        this.partyIndex = i;
        this.renderParty();
      }, () => this.pickParty()));
    });
    const note = this.partyNote;
    if (note) {
      layer.append(frameBox(8, 120, 224, 32), place(assets.text(note, { color: 'std' }), 8, 121));
    } else {
      layer.append(frameBox(8, 136, 168, 16), place(assets.text(`Choose a ${POKEMON}.`, { color: 'std' }), 8, 137));
    }
    if (!note) {
      const on = this.partyIndex === slots.length;
      const label = assets.text('CANCEL', { font: 'small', color: assets.data ? [assets.data.slot.plain.text, assets.data.slot.plain.shadow] : 'white' });
      layer.append(place(imgEl(assets, `cancel_${on ? 'on' : 'plain'}`), 184, 136, 56, 16), place(label, 184 + Math.floor((56 - assets.measure('CANCEL', 'small')) / 2), 137));
      layer.append(this.hit(184, 136, 56, 16, () => {
        if (this.partyIndex === slots.length) return;
        this.partyIndex = slots.length;
        this.renderParty();
      }, () => this.pickParty()));
    }
  }

  private partyMove(action: Action): void {
    const count = Math.min(6, this.team.length);
    const total = count + 1;
    if (!total) return;
    let next = this.partyIndex;
    if (action === 'up') next = (next - 1 + total) % total;
    else if (action === 'down') next = (next + 1) % total;
    else if (action === 'left') next = 0;
    else if (action === 'right' && next === 0 && count > 1) next = 1;
    if (next !== this.partyIndex) {
      this.partyIndex = next;
      peSound('SE_SELECT');
      this.renderParty();
    }
  }

  private pickParty(): void {
    const index = this.partyIndex;
    if (index >= Math.min(6, this.team.length)) {
      if (this.partyForced) {
        peSound('SE_FAILURE');
        this.partyNote = `You have to choose\na ${POKEMON}!`;
        this.renderParty();
        cancelLater(this.partyNoteTimer);
        this.partyNoteTimer = later(() => {
          this.partyNote = '';
          if (this.menuState === 'party') this.renderParty();
        }, 1400);
        return;
      }
      peSound('SE_SELECT');
      this.openActions();
      return;
    }
    const entry = this.team[index];
    const name = monText(parseIdent(entry.ident)?.name ?? '');
    const fnt = parseHp(entry.condition).status === 'fnt';
    const trapped = !this.partyForced && !!this.current?.request.active?.[0]?.trapped;
    let note = '';
    if (fnt) note = `${name} has no energy\nleft to battle!`;
    else if (entry.active) note = `${name} is already\nin battle!`;
    else if (trapped) note = `${this.activeName()} can't be\nswitched out!`;
    if (note) {
      peSound('SE_SELECT');
      this.partyNote = note;
      this.renderParty();
      cancelLater(this.partyNoteTimer);
      this.partyNoteTimer = later(() => {
        this.partyNote = '';
        if (this.menuState === 'party') this.renderParty();
      }, 1400);
      return;
    }
    peSound('SE_SELECT');
    this.choose(`switch ${index + 1}`);
  }

  input(action: Action): boolean {
    if (this.dead) return false;
    if (this.running || this.busy || this.menuState === 'none') {
      if (action === 'ok' || action === 'back') this.skip = true;
      return action === 'ok';
    }
    switch (this.menuState) {
      case 'actions':
        if (action === 'ok') this.pickAction();
        else if (action !== 'back') {
          const next = this.gridMove(this.actionIndex, action, 4);
          if (next !== this.actionIndex) {
            this.actionIndex = next;
            this.renderActions();
          }
        }
        return action !== 'back';
      case 'fight':
        if (action === 'ok') this.pickMove();
        else if (action === 'back') {
          peSound('SE_SELECT');
          this.openActions();
        } else {
          const next = this.gridMove(this.moveIndex, action, this.moves().length);
          if (next !== this.moveIndex) {
            this.moveIndex = next;
            this.renderFight();
          }
        }
        return true;
      case 'confirm':
        if (action === 'ok') this.pickConfirm();
        else if (action === 'back') {
          peSound('SE_SELECT');
          this.openActions();
        } else if (action === 'up' || action === 'down') {
          this.confirmIndex = action === 'up' ? 0 : 1;
          peSound('SE_SELECT');
          this.renderConfirm();
        }
        return true;
      case 'party':
        if (action === 'ok') this.pickParty();
        else if (action === 'back') {
          if (this.partyForced) {
            peSound('SE_FAILURE');
            return true;
          }
          peSound('SE_SELECT');
          this.openActions();
        } else this.partyMove(action);
        return true;
      default:
        return false;
    }
  }

  get clock(): { label: string; left: number } | null {
    const mine = this.needsInput && this.clocks.mine > Date.now();
    const deadline = mine ? this.clocks.mine : this.clocks.foe;
    if (!deadline || deadline < Date.now() - 1000 || (!mine && this.needsInput)) return null;
    return { label: mine ? 'YOUR TIME' : 'FOE TIME', left: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) };
  }

  get inSubmenu(): boolean {
    return this.menuState === 'fight' || this.menuState === 'confirm' || (this.menuState === 'party' && !this.partyForced);
  }

  snapshot(): Record<string, unknown> {
    const me = this.sides[this.mySide].active;
    const foe = this.sides[this.foeSide].active;
    return {
      id: this.id,
      mode: this.mode,
      turn: this.turn,
      menu: this.menuState,
      running: this.running,
      queue: this.queue.length,
      lines: this.linesDone,
      text: this.msgText,
      me: me && `${me.species} ${me.hp}/${me.maxhp} ${me.status}`,
      foe: foe && `${foe.species} ${foe.hp}/${foe.maxhp} ${foe.status}`,
      meImg: this.mons.me.img.naturalWidth,
      foeImg: this.mons.foe.img.naturalWidth,
      meMissing: this.mons.me.img.dataset.missing,
      foeMissing: this.mons.foe.img.dataset.missing,
      shown: this.spritesShown,
      broken: this.spritesBroken,
      weather: this.weather,
      moves: this.current?.request.active?.[0]?.moves?.map((m) => `${m.move}:${m.pp}:${m.disabled ? 'x' : ''}`),
      team: this.team.map((m) => `${m.ident}:${m.condition}:${m.active ? 'a' : ''}`),
      partyIndex: this.partyIndex,
    };
  }
}

ns.Battle = Battle;
