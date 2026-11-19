const ns = (window as any).__pkb;
const { debugLog, clamp, upper, moveText, monText, parseLine, parseIdent, parseDetails, effectName } = ns;

// one Showdown protocol line on the battle screen: text, sounds and state changes, in the order the game shows them
async function handleLine(b: any, line: string): Promise<void> {
  const { cmd, args, kw } = parseLine(line);
  if (!['-damage', '-supereffective', '-resisted', '-crit'].includes(cmd)) await b.flushTexts();
  const L = (ident?: string) => b.label(ident);
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
        if (args[1]) b.sides[args[0]].trainer = args[1];
      }
      return;
    case 'teamsize':
      if (args[0] === 'p1' || args[0] === 'p2') b.sides[args[0]].size = clamp(Number(args[1]) || 6, 1, 6);
      return;
    case 'start':
      await b.say(`${b.foeTrainer()} would like to battle!`);
      return;
    case 'switch':
    case 'drag':
    case 'replace':
      await b.switchIn(cmd, args);
      return;
    case 'detailschange':
    case '-formechange': {
      const found = b.mon(args[0]);
      if (found?.mon) {
        found.mon.species = parseDetails(args[1]).species;
        if (found.side.active === found.mon) b.setSprite(found.key, found.mon);
        if (cmd === '-formechange' && kw.silent === undefined) await b.say(`${L(args[0])} transformed!`);
      }
      return;
    }
    case 'move': {
      await b.say(`${L(args[0])} used ${moveText(args[1] ?? '')}!`, 250);
      const p = parseIdent(args[0]);
      if (!p || kw.still !== undefined || kw.miss !== undefined || kw.notarget !== undefined) return;
      const target = parseIdent(args[2]);
      const lead = b.fast ? 0 : b.sound.move(args[1] ?? '', b.key(p.side), target ? b.key(target.side) : null);
      await b.lunge(b.key(p.side));
      if (lead > 140) await b.wait(Math.min(lead, 3000) - 140);
      return;
    }
    case '-damage':
      await b.hpChange(args[0], args[1], kw, 'damage');
      return;
    case '-heal':
      await b.hpChange(args[0], args[1], kw, 'heal');
      return;
    case '-sethp':
      await b.hpChange(args[0], args[1], kw, 'set');
      return;
    case '-supereffective':
      b.texts.push("It's super effective!");
      b.effect = 'super';
      return;
    case '-resisted':
      b.texts.push("It's not very effective...");
      b.effect = 'weak';
      return;
    case '-crit':
      b.texts.unshift('A critical hit!');
      return;
    case '-immune':
      await b.say(`It doesn't affect ${L(args[0])}...`);
      return;
    case '-miss':
      await b.say(`${L(args[0])}'s attack missed!`);
      return;
    case '-fail':
      await b.say('But it failed!');
      return;
    case '-notarget':
      await b.say('But there was no target...');
      return;
    case '-nothing':
      await b.say('But nothing happened!');
      return;
    case '-ohko':
      await b.say("It's a one-hit KO!");
      return;
    case '-hitcount':
      await b.say(`Hit ${args[1]} time${args[1] === '1' ? '' : 's'}!`);
      return;
    case '-status':
      await b.statusChange(args[0], args[1], kw, true);
      return;
    case '-curestatus':
      await b.statusChange(args[0], args[1], kw, false);
      return;
    case '-cureteam': {
      const found = b.mon(args[0]);
      if (found) for (const mon of found.side.mons.values()) mon.status = mon.fainted ? 'fnt' : '';
      b.syncBoxes();
      await b.say('A bell chimed!');
      return;
    }
    case '-boost':
    case '-unboost':
      await b.boost(cmd === '-boost', args, kw);
      return;
    case '-setboost':
      await b.say(`${L(args[0])} cut its own HP and maximized ATTACK!`);
      return;
    case '-clearallboost':
      await b.say('All stat changes were eliminated!');
      return;
    case '-weather':
      await b.weatherChange(args[0], kw);
      return;
    case 'cant':
      await b.cant(args);
      return;
    case 'faint':
      await b.faint(args[0]);
      return;
    case '-start':
    case '-end':
    case '-activate':
    case '-singleturn':
    case '-singlemove':
    case '-prepare':
      await b.effectText(cmd, args, kw);
      return;
    case '-item':
      if (kw.from === 'move: Trick') await b.say(`${L(args[0])} obtained ${upper(args[1] ?? '')}.`);
      else if (/Thief|Covet/.test(kw.from ?? '')) await b.say(`${L(args[0])} stole ${upper(args[1] ?? '')}!`);
      return;
    case '-enditem': {
      const item = upper(args[1] ?? '');
      if (kw.from === 'move: Knock Off') await b.say(`${L(kw.of)} knocked off ${L(args[0])}'s ${item}!`);
      else if (/BERRY$/.test(item) || kw.eat !== undefined) await b.say(`${L(args[0])} ate its ${item}!`);
      else if (item === 'WHITE HERB') await b.say(`${L(args[0])}'s WHITE HERB restored its stats!`);
      else if (item === 'MENTAL HERB') await b.say(`${L(args[0])} used its MENTAL HERB!`);
      else if (!kw.from) await b.say(`${L(args[0])}'s ${item} was used up.`);
      return;
    }
    case '-ability': {
      const ability = effectName(args[1]);
      if (kw.from === 'ability: Trace' && kw.of) await b.say(`${L(args[0])} TRACED ${L(kw.of)}'s ${upper(ability)}!`);
      else if (ability === 'Pressure') await b.say(`${L(args[0])} is exerting its PRESSURE!`);
      else if (!['Intimidate', 'Drizzle', 'Drought', 'Sand Stream'].includes(ability)) await b.say(`${L(args[0])}'s ${upper(ability)}!`);
      return;
    }
    case '-transform': {
      const target = parseIdent(args[1]);
      await b.say(`${L(args[0])} transformed into ${target ? monText(target.name) : upper(args[1] ?? '')}!`);
      return;
    }
    case '-sidestart':
    case '-sideend':
      await b.sideText(cmd === '-sidestart', args);
      return;
    case '-fieldstart':
    case '-fieldend': {
      const effect = effectName(args[0]);
      if (cmd === '-fieldstart') await b.say(effect === 'Mud Sport' ? "Electricity's power was weakened!" : effect === 'Water Sport' ? "Fire's power was weakened!" : '');
      else await b.say(`The effects of ${upper(effect)} faded.`);
      return;
    }
    case '-message':
    case 'message':
      await b.say(args.join('|'));
      return;
    case 'turn':
      b.turn = Number(args[0]) || b.turn;
      b.app.renderBar();
      return;
    case 'win': {
      const won = args[0] === b.sides[b.mySide].trainer || args[0] === b.myName;
      b.sawWin = true;
      b.sound.lowHp(0, 1);
      if (b.mode === 'cpu') b.app.musicOutcome = won ? 'victory' : 'silent';
      b.app.music.sync(b.app, won ? 0 : 1000);
      await b.say(won ? `${upper(b.myName)} defeated ${b.foeTrainer()}!` : `${upper(b.myName)} lost to ${b.foeTrainer()}!`, 1200);
      return;
    }
    case 'tie':
      b.sawWin = true;
      b.sound.lowHp(0, 1);
      b.app.musicOutcome = 'silent';
      b.app.music.sync(b.app, 1000);
      await b.say('The battle ended in a draw!', 1200);
      return;
    default:
      debugLog.unknown[cmd] = (debugLog.unknown[cmd] ?? 0) + 1;
  }
}

Object.assign(ns, { handleLine });
