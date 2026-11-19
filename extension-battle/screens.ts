type MenuItem = { label: string; disabled?: boolean; pick: () => void; cls?: string; decorate?: (row: HTMLElement) => void };

const ns = (window as any).__pkb;
const { el, place, clamp, upper, assets, frameBox, WAIT, CURSOR_COL, playerLook, cleanLook, trainerCanvas, playerSprite, DEFAULT_LOOK,
  opponentMenu, peerHint, resultReason, startCommand } = ns;

// the lobby: the menu, the trainer card and the panel or peer list beside it
function renderLobby(app: any, view: HTMLElement): void {
  const menuBox = app.menuBox(view, 8, 8, 88, 96);
  view.append(frameBox(112, 8, 120, 96));
  const list = place(el('div', 'pkb-menubox pkb-clip'), 112, 56, 120, 48);
  if (!app.panel) {
    const avatar = playerSprite(playerLook() ?? DEFAULT_LOOK);
    if (avatar) view.append(place(avatar, 112, 8));
    const idNum = parseInt(app.trainer.id.slice(0, 8), 16);
    const tid = Number.isFinite(idNum) ? String(idNum % 100000).padStart(5, '0') : '-----';
    view.append(app.txt(assets.fit(upper(app.playerName()), 100), 132, 9), app.txt(`IDNo.${tid}`, 132, 25, { font: 'small', color: 'gray' }));
    view.append(list, app.txt(app.peers.length ? `TRAINERS NEARBY (${app.peers.length})` : 'TRAINERS NEARBY', 112, 42, { font: 'small', color: 'gray' }));
  }
  const msg = app.msgBox(view, 8, 120, app.prompt && app.prompt.kind !== 'input' ? 152 : 224, 32, '');
  const lan = app.lan.enabled;
  const items: MenuItem[] = [
    {
      label: 'BATTLE CPU',
      pick: () => {
        app.panel = 'foe';
        app.panelIndex = 0;
        app.lobbyFocus = 'peers';
        app.render();
      },
    },
    { label: `SEEK: ${app.looking ? 'ON' : 'OFF'}`, disabled: !lan, pick: () => (lan ? app.toggleSeek() : app.lanOff()) },
    { label: 'ADD BY IP', disabled: !lan, pick: () => (lan ? app.openInput('ip') : app.lanOff()) },
    { label: 'TRAINER', pick: () => (playerLook() ? window.dispatchEvent(new CustomEvent('pe-open-trainer-customize')) : app.openInput('name')) },
    { label: 'REFRESH', disabled: !lan, pick: () => app.refresh() },
    {
      label: 'OPTIONS',
      pick: () => {
        app.panel = 'options';
        app.panelIndex = 0;
        app.lobbyFocus = 'peers';
        app.render();
      },
    },
  ];
  const hints = [
    'Battle the CPU or CLAUDE with a random team.',
    app.looking ? 'Trainers on your Wi-Fi see you looking for a battle.' : 'Show trainers on your Wi-Fi that you want to battle.',
    "Add a trainer by IP when they don't show up.",
    'Change your trainer and name.',
    'Look for trainers again.',
    'Auto open and music.',
  ];
  const modal = !!app.prompt;
  const menu = app.addMenu(menuBox, items, {
    index: app.lobbyIndex,
    focused: !modal && app.lobbyFocus === 'menu',
    onMove: (i) => {
      app.lobbyIndex = i;
      app.lobbyFocus = 'menu';
      app.syncLobbyFocus();
      if (!app.prompt) app.paintMsg(msg, hints[i] ?? '');
    },
  });
  if (app.panel) {
    const panel = app.panel === 'foe' ? { title: 'OPPONENT', ...opponentMenu(app, app.claude) } : ns[`${app.panel}Panel`](app);
    app.panelHints = panel.hints;
    app.panelIndex = clamp(app.panelIndex, 0, panel.items.length - 1);
    const clip = place(el('div', 'pkb-menubox pkb-clip'), 112, 24, 120, 80);
    const box = el('div', 'pkb-menubox');
    clip.append(box);
    view.append(clip, app.txt(panel.title, 112, 8, { font: 'small', color: 'gray' }));
    app.addMenu(box, panel.items, {
      index: app.panelIndex,
      focused: !modal && app.lobbyFocus === 'peers',
      onMove: (i) => {
        app.panelIndex = i;
        app.lobbyFocus = 'peers';
        app.syncLobbyFocus();
        box.style.transform = `translateY(calc(var(--u) * ${-clamp(i - 4, 0, Math.max(0, panel.items.length - 5)) * 16}))`;
        if (app.panel === 'music') app.music.preview(app, panel.items[i]?.preview ?? null);
        if (!app.prompt) app.paintMsg(msg, panel.hints[i] ?? '');
      },
    });
    box.style.transform = `translateY(calc(var(--u) * ${-clamp(app.panelIndex - 4, 0, Math.max(0, panel.items.length - 5)) * 16}))`;
  } else if (app.peers.length) {
    const peerItems: MenuItem[] = app.peers.map((peer) => ({
      label: assets.fit(upper(peer.name), 120 - CURSOR_COL - 18),
      disabled: peer.status !== 'idle' && peer.status !== 'looking',
      decorate: (row) => {
        const head = trainerCanvas(cleanLook(peer.trainer) ?? DEFAULT_LOOK, 16);
        const pip = el('span', 'pkb-pip');
        pip.dataset.status = peer.status;
        row.append(head ?? pip);
      },
      pick: () => app.challenge(peer),
    }));
    app.peerIndex = clamp(app.peerIndex, 0, app.peers.length - 1);
    const inner = el('div', 'pkb-menubox');
    list.append(inner);
    app.addMenu(inner, peerItems, {
      index: app.peerIndex,
      focused: !modal && app.lobbyFocus === 'peers',
      onMove: (i) => {
        app.peerIndex = i;
        app.lobbyFocus = 'peers';
        app.syncLobbyFocus();
        if (!app.prompt) app.paintMsg(msg, peerHint(app.peers[i]));
      },
    });
    const start = clamp(app.peerIndex - 2, 0, Math.max(0, app.peers.length - 3));
    inner.style.transform = `translateY(calc(var(--u) * ${-start * 16}))`;
  } else {
    app.lobbyFocus = 'menu';
    menu.focused = !modal;
    menu.paint();
    list.append(place(assets.text(assets.wrap(!lan ? 'LAN is off. Start the helper without --no-lan.' : app.looking ? `No trainers yet. Waiting${WAIT}` : 'No trainers found. Turn SEEK on and ask a friend.', 'small', 116).join('\n'), { font: 'small', color: 'gray', lineHeight: 13 }), 0, 0));
  }
  if (app.prompt) {
    app.renderPrompt(view, msg);
    return;
  }
  const fresh = app.notice && Date.now() - app.noticeAt < 6000;
  const side = app.panel ? app.panelHints[app.panelIndex] : app.peers[app.peerIndex] && peerHint(app.peers[app.peerIndex]);
  app.paintMsg(msg, fresh ? app.notice : (app.lobbyFocus === 'peers' && side) || (hints[app.lobbyIndex] ?? ''));
}

// the result screen after a battle: outcome, opponent, reason and the rematch menu
function renderResult(app: any, view: HTMLElement): void {
  const r = app.result;
  view.append(frameBox(8, 8, 224, 80));
  if (r) {
    const head = assets.text(r.result === 'win' ? 'YOU WIN!' : r.result === 'loss' ? 'YOU LOST' : r.result === 'tie' ? 'DRAW' : 'BATTLE ENDED', { color: 'std' });
    head.style.width = `calc(var(--u) * ${head.width * 2})`;
    head.style.height = `calc(var(--u) * ${head.height * 2})`;
    const foe = r.look ? trainerCanvas(cleanLook(r.look) ?? DEFAULT_LOOK) : null;
    if (foe) view.append(place(foe, 214, 8));
    view.append(place(head, 8, 6), app.txt(`VS ${upper(r.opponent)}${r.model ? ` (${r.model.toUpperCase()})` : ''}`, 8, 40), app.txt(resultReason(r), 8, 58, { font: 'small' }));
    const stats = r.stats && cinnamon.settings.get('showClaudeStats') === true ? `   ${r.stats}` : '';
    if (r.turns || stats) view.append(app.txt(`${r.turns} TURN${r.turns === 1 ? '' : 'S'}${stats}`, 8, 71, { font: 'small' }));
  }
  app.msgBox(view, 8, 104, 128, 48, app.notice && Date.now() - app.noticeAt < 6000 ? app.notice : 'Battle again?');
  const box = app.menuBox(view, 152, 104, 80, 48);
  if (app.prompt?.kind === 'incoming' || app.prompt?.kind === 'outgoing') {
    app.renderPrompt(view);
    return;
  }
  app.addMenu(box, [
    { label: 'REMATCH', pick: () => app.rematch() },
    { label: 'LOBBY', pick: () => app.toLobby() },
  ]);
}

// the screen while the helper is not running: how to start it, retry, copy and close
function renderOffline(app: any, view: HTMLElement): void {
  view.append(frameBox(8, 8, 224, 80));
  view.append(app.txt('BATTLE HELPER OFFLINE', 8, 8), app.txt('Start it in its own Terminal tab:', 8, 24));
  const code = place(el('div', 'pkb-code'), 8, 44, 224, 30);
  const { command, local } = startCommand();
  const lines: string[] = [];
  let line = '';
  for (const part of command.split(/(?<=\/)/)) {
    if (line && assets.measure(line + part, 'small') > 216) {
      lines.push(line);
      line = part;
    } else line += part;
  }
  lines.push(line);
  if (!local && lines.length < 2) lines.push('in the folder of your clone');
  code.append(place(assets.text(lines.join('\n'), { font: 'small', color: 'std', lineHeight: 13 }), 4, 2));
  view.append(code);
  app.msgBox(view, 8, 104, 128, 48, app.notice && Date.now() - app.noticeAt < 4000 ? app.notice : `Retrying${WAIT}`);
  app.addMenu(app.menuBox(view, 152, 104, 80, 48), [
    { label: 'RETRY', pick: () => app.link.retryNow() },
    {
      label: 'COPY',
      pick: () => {
        void navigator.clipboard?.writeText(command).then(
          () => {
            app.setNotice('Copied the command.');
            app.render();
          },
          () => {},
        );
      },
    },
    { label: 'CLOSE', pick: () => app.close() },
  ]);
}

Object.assign(ns, { renderLobby, renderResult, renderOffline });
