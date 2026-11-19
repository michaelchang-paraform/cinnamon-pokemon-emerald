// Settings → Appearance row "Pokemon partners": trainer base, palette colors and name, with a live preview.
// Also renders the trainer avatar the transcript uses, as a blob URL in --pkp-trainer.
declare const cinnamon: {
  settings: { get(key: string): unknown; set(key: string, value: unknown): void };
};
const S = (window as any).__pkp;

const NAME_MAX = 10;
const WALK = [0, 1, 0, 2];

class TrainerArt {
  private style = S.el('style');
  private url = '';
  private sig = '';

  constructor() {
    this.style.setAttribute('data-pkp-trainer', '');
    document.head.append(this.style);
  }

  // repaints the avatar when the saved trainer changes
  update(): void {
    const setting = S.trainerSetting();
    const sig = JSON.stringify(setting);
    if (sig === this.sig) return;
    const trainer = S.assets.data?.t.find((t: any) => t.id === setting.base);
    if (!trainer) return;
    this.sig = sig;
    const canvas = S.el('canvas') as HTMLCanvasElement;
    S.paintTrainer(canvas, trainer, 0, setting.colors);
    canvas.toBlob((blob: Blob | null) => {
      if (!blob || S.rt.disposed || sig !== this.sig) return;
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(blob);
      this.style.textContent = `:root{--pkp-trainer:url("${this.url}")}`;
    });
    document.querySelectorAll<HTMLElement>('.pkp-tr').forEach((node) => (node.dataset.name = setting.name));
  }

  dispose(): void {
    this.style.remove();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}

class SettingsRow {
  private observer: MutationObserver | null = null;
  private dialog: Element | null = null;
  private queued = false;
  private walkTimer = 0;
  private saveTimer = 0;
  private draft: { base: string; colors: Array<string | null>; name: string } | null = null;
  private modal: HTMLElement | null = null;
  private opener: HTMLElement | null = null;

  private static isOurs(node: Node | null): boolean {
    const elem = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
    return !!elem?.closest?.('[data-pkp-settings]');
  }

  private static leaves(row: Element): Element[] {
    const text = row.querySelector('[data-settings-text]') ?? row;
    return [...text.querySelectorAll('*')].filter((node) => node.childElementCount === 0 && node.textContent?.trim() && !node.closest('[data-settings-control]'));
  }

  private static anchor(): Element | null {
    const rows = [...document.querySelectorAll('[data-settings-row]')].filter((row) => !row.hasAttribute('data-pkp-settings') && !row.hasAttribute('data-fy-font-row'));
    const battle = rows.filter((row) => row.hasAttribute('data-pkb-row')).pop();
    return battle ?? rows.filter((row) => row.hasAttribute('data-cm-ext-row')).pop() ?? null;
  }

  // the settings dialog only exists while open: the page tick finds it, then an observer keeps the row in place
  tick(): void {
    const anchor = SettingsRow.anchor();
    const dialog = anchor?.closest('[role="dialog"]') ?? anchor?.parentElement ?? null;
    if (dialog === this.dialog) return;
    this.observer?.disconnect();
    this.observer = null;
    this.dialog = dialog;
    if (!dialog) {
      this.stopWalk();
      return;
    }
    this.observer = new MutationObserver((records) => {
      if (records.some((r) => !SettingsRow.isOurs(r.target) && ![...r.addedNodes, ...r.removedNodes].every(SettingsRow.isOurs))) this.schedule();
    });
    this.observer.observe(dialog, { childList: true, subtree: true });
    this.schedule();
  }

  private schedule(): void {
    if (this.queued || S.rt.disposed) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      S.guard(() => this.ensure())();
    });
  }

  private ensure(): void {
    const anchor = SettingsRow.anchor();
    if (!anchor) return;
    const existing = document.querySelector<HTMLElement>('[data-settings-row][data-pkp-settings]');
    if (existing?.isConnected && existing.previousElementSibling === anchor) return;
    document.querySelectorAll('[data-pkp-settings]').forEach((n) => n.remove());
    const row = anchor.cloneNode(true) as HTMLElement;
    for (const node of [row, ...row.querySelectorAll('*')]) {
      for (const attr of [...node.attributes]) if (/^(id|for|name|aria-|data-cm-|data-cinnamon-|data-pkb-)/.test(attr.name)) node.removeAttribute(attr.name);
    }
    const [title, description, ...rest] = SettingsRow.leaves(row);
    rest.forEach((leaf) => leaf.remove());
    if (title) title.textContent = 'Pokemon partners';
    if (description) description.textContent = 'Every chat gets its own partner. Pick the trainer who speaks for you.';
    let control = row.querySelector<HTMLElement>('[data-settings-control]');
    if (!control) {
      control = S.el('div');
      control.setAttribute('data-settings-control', '');
      row.append(control);
    }
    const wrap = S.el('div', 'pkp-set-control');
    const mini = S.el('canvas', 'pkp-set-mini') as HTMLCanvasElement;
    const toggle = S.el('button', 'pkp-set-open', 'Customize') as HTMLButtonElement;
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    wrap.append(mini, toggle);
    control.replaceChildren(wrap);
    row.setAttribute('data-pkp-settings', '');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Pokemon partners');
    anchor.after(row);

    const panel = S.el('div', 'pkp-set-panel');
    panel.setAttribute('data-pkp-settings', '');
    panel.hidden = true;
    row.after(panel);
    toggle.addEventListener('click', S.guard(() => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
      toggle.textContent = panel.hidden ? 'Customize' : 'Done';
      if (panel.hidden) this.stopWalk();
      else this.build(panel, mini);
    }));
    this.paintMini(mini);
  }

  // the same trainer panel, lifted over the app when the user's trainer sprite is clicked
  openModal(opener: HTMLElement | null): void {
    if (this.modal || !S.assets.data) return;
    this.opener = opener;
    const overlay = S.el('div', 'pkp-trainer-modal');
    const box = S.el('div', 'pkp-trainer-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Customize trainer');
    const head = S.el('div', 'pkp-trainer-head');
    const done = S.el('button', 'pkp-set-open', 'Done') as HTMLButtonElement;
    done.type = 'button';
    head.append(S.el('span', 'pkp-trainer-title', 'Customize trainer'), done);
    const panel = S.el('div', 'pkp-set-panel');
    box.append(head, panel);
    overlay.append(box);
    document.body.append(overlay);
    this.modal = overlay;
    this.build(panel, S.el('canvas') as HTMLCanvasElement);
    done.addEventListener('click', S.guard(() => this.closeModal()));
    overlay.addEventListener('pointerdown', S.guard((event: PointerEvent) => {
      if (event.target === overlay) this.closeModal();
    }));
    overlay.addEventListener('keydown', S.guard((event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.closeModal();
    }));
    (panel.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? done).focus();
  }

  closeModal(): void {
    if (!this.modal) return;
    this.stopWalk();
    this.modal.remove();
    this.modal = null;
    this.opener?.focus();
    this.opener = null;
  }

  private paintMini(mini: HTMLCanvasElement): void {
    const setting = this.draft ?? S.trainerSetting();
    const trainer = S.assets.data?.t.find((t: any) => t.id === setting.base);
    if (trainer) S.paintTrainer(mini, trainer, 0, setting.colors);
  }

  private build(panel: HTMLElement, mini: HTMLCanvasElement): void {
    const data = S.assets.data;
    if (!data) return;
    this.draft = S.trainerSetting();
    const draft = this.draft!;
    panel.replaceChildren();

    const preview = S.el('div', 'pkp-set-preview');
    const big = S.el('canvas', 'pkp-set-big') as HTMLCanvasElement;
    const plate = S.el('div', 'pkp-set-plate');
    preview.append(big, plate);

    const form = S.el('div', 'pkp-set-form');
    const bases = S.el('div', 'pkp-set-bases');
    bases.setAttribute('role', 'radiogroup');
    bases.setAttribute('aria-label', 'Trainer');
    const colorBox = S.el('div', 'pkp-set-colors');
    const nameLabel = S.el('label', 'pkp-set-name');
    const nameInput = S.el('input') as HTMLInputElement;
    nameInput.type = 'text';
    nameInput.maxLength = NAME_MAX;
    nameInput.spellcheck = false;
    nameLabel.append(S.el('span', '', 'Name'), nameInput);
    form.append(S.el('div', 'pkp-set-heading', 'Trainer'), bases, colorBox, nameLabel);
    panel.append(preview, form);

    const trainerOf = () => data.t.find((t: any) => t.id === draft.base) ?? data.t[0];
    let frame = 0;
    const repaint = () => {
      const trainer = trainerOf();
      S.paintTrainer(big, trainer, WALK[frame % WALK.length], draft.colors);
      plate.textContent = draft.name;
      this.paintMini(mini);
    };
    const renderColors = () => {
      const trainer = trainerOf();
      colorBox.replaceChildren();
      trainer.groups.forEach((group: any, g: number) => {
        const label = S.el('label', 'pkp-set-color');
        const input = S.el('input') as HTMLInputElement;
        input.type = 'color';
        input.value = draft.colors[g] ?? S.groupBase(trainer, group);
        const reset = S.el('button', 'pkp-set-reset', 'Reset') as HTMLButtonElement;
        reset.type = 'button';
        reset.disabled = !draft.colors[g];
        input.addEventListener('input', S.guard(() => {
          draft.colors[g] = input.value;
          reset.disabled = false;
          repaint();
          this.save();
        }));
        reset.addEventListener('click', S.guard(() => {
          draft.colors[g] = null;
          input.value = S.groupBase(trainer, group);
          reset.disabled = true;
          repaint();
          this.save();
        }));
        label.append(S.el('span', '', group[0]), input, reset);
        colorBox.append(label);
      });
    };
    for (const trainer of data.t) {
      const button = S.el('button', 'pkp-set-base') as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', trainer.label);
      button.setAttribute('aria-checked', String(trainer.id === draft.base));
      const art = S.el('canvas') as HTMLCanvasElement;
      S.paintTrainer(art, trainer, 0, []);
      button.append(art, S.el('span', '', trainer.label));
      button.addEventListener('click', S.guard(() => {
        const previous = trainerOf();
        draft.base = trainer.id;
        draft.colors = [];
        if (!nameInput.value.trim() || nameInput.value.trim() === previous.name) draft.name = trainer.name;
        nameInput.value = draft.name;
        bases.querySelectorAll('[role="radio"]').forEach((b) => b.setAttribute('aria-checked', String(b === button)));
        renderColors();
        repaint();
        this.save();
      }));
      bases.append(button);
    }
    nameInput.value = draft.name;
    nameInput.addEventListener('input', S.guard(() => {
      draft.name = nameInput.value.trim().toUpperCase().slice(0, NAME_MAX) || trainerOf().name;
      repaint();
      this.save();
    }));
    renderColors();
    repaint();
    this.stopWalk();
    const step = () => {
      frame++;
      repaint();
      this.walkTimer = S.later(step, 260);
    };
    this.walkTimer = S.later(step, 260);
  }

  private save(): void {
    if (this.saveTimer) S.cancel(this.saveTimer);
    this.saveTimer = S.later(() => {
      this.saveTimer = 0;
      const draft = this.draft;
      if (!draft) return;
      const colors = draft.colors.some(Boolean) ? draft.colors.map((c) => c ?? null) : [];
      cinnamon.settings.set('trainer', { base: draft.base, colors, name: draft.name });
    }, 300);
  }

  private stopWalk(): void {
    if (this.walkTimer) S.cancel(this.walkTimer);
    this.walkTimer = 0;
  }

  dispose(): void {
    this.closeModal();
    this.observer?.disconnect();
    this.stopWalk();
    if (this.saveTimer) S.cancel(this.saveTimer);
    document.querySelectorAll('[data-pkp-settings]').forEach((n) => n.remove());
  }
}

S.TrainerArt = TrainerArt;
S.SettingsRow = SettingsRow;
