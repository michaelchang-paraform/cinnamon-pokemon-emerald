# picks the Emerald items a group heading can use and writes items.json for build-items.mjs
# rule: an item is in when it is a real item (not a ???????? placeholder), not a TM or HM, not event or e-Reader only,
# and Emerald can give it: a script or map gives, finds, sells or plants it (data/), a wild Pokemon holds it,
# or the Berry Master or his wife can hand it out (their berry ranges in include/constants/items.h)
# usage: python3 item-list.py (after download-items.sh)
import collections
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'download', 'pret', 'pokeemerald')
OUT = os.path.join(HERE, 'items.json')

# only through Mystery Gift, the e-Reader or an event island
EVENT_ONLY = {'ITEM_EON_TICKET', 'ITEM_MYSTIC_TICKET', 'ITEM_AURORA_TICKET', 'ITEM_OLD_SEA_MAP', 'ITEM_ENIGMA_BERRY', 'ITEM_SOUL_DEW'}
# script lines that only test for or take an item
NOT_A_SOURCE = re.compile(r'\b(checkitem|removeitem|checkitemspace|checkitemtype|checkpcitem|bufferitemname|bufferitemnameplural)\b')
POCKETS = {'POCKET_POKE_BALLS': 'balls', 'POCKET_ITEMS': 'items', 'POCKET_KEY_ITEMS': 'key', 'POCKET_BERRIES': 'berries'}
BALL_IDS = {'ITEM_POKE_BALL': 'poke', 'ITEM_GREAT_BALL': 'great', 'ITEM_ULTRA_BALL': 'ultra', 'ITEM_MASTER_BALL': 'master', 'ITEM_SAFARI_BALL': 'safari',
            'ITEM_NET_BALL': 'net', 'ITEM_DIVE_BALL': 'dive', 'ITEM_NEST_BALL': 'nest', 'ITEM_REPEAT_BALL': 'repeat', 'ITEM_TIMER_BALL': 'timer',
            'ITEM_LUXURY_BALL': 'luxury', 'ITEM_PREMIER_BALL': 'premier'}
# Gen 3 spells these as one word in capitals; the bag shows them with inner capitals
NAMES = {'ENERGYPOWDER': 'EnergyPowder', 'THUNDERSTONE': 'Thunderstone', 'TINYMUSHROOM': 'TinyMushroom', 'BRIGHTPOWDER': 'BrightPowder',
         'DEEPSEATOOTH': 'DeepSeaTooth', 'DEEPSEASCALE': 'DeepSeaScale', 'BLACKGLASSES': 'BlackGlasses', 'NEVERMELTICE': 'NeverMeltIce',
         'TWISTEDSPOON': 'TwistedSpoon', 'MYSTICTICKET': 'MysticTicket', 'AURORATICKET': 'AuroraTicket', 'SILVERPOWDER': 'SilverPowder', '{POKEBLOCK} CASE': 'Pokéblock Case'}
UPPER = {'HP', 'PP', 'X', 'S.S.', 'TM', 'TV', 'VS'}


def read(path):
    with open(os.path.join(SRC, path), encoding='utf8') as handle:
        return handle.read()


def display(name):
    if name in NAMES:
        return NAMES[name]
    words = []
    for word in name.replace('é', 'É').split(' '):
        words.append(word if word in UPPER else '-'.join(part[:1] + part[1:].lower() for part in word.split('-')))
    return ' '.join(words).replace('PokÉ', 'Poké').replace('É', 'é')


def main():
    items = []
    for match in re.finditer(r'\[(ITEM_\w+)\]\s*=\s*\{(.*?)\n    \},', read('src/data/items.h'), re.S):
        key, body = match.groups()
        items.append((key, re.search(r'\.name = _\("(.*?)"\)', body).group(1), re.search(r'\.pocket = (\w+)', body).group(1)))
    order = re.findall(r'^\s+(ITEM_\w+)\s*(?:=\s*\w+)?,', read('include/constants/items.h'), re.M)
    index = {key: i for i, key in enumerate(order)}
    span = lambda first, last: set(order[index[first]:index[last] + 1])
    berry_master = span('ITEM_POMEG_BERRY', 'ITEM_NOMEL_BERRY') | span('ITEM_CHERI_BERRY', 'ITEM_SITRUS_BERRY')

    wild = set(re.findall(r'SPECIES_\w+', read('src/data/wild_encounters.json')))
    held = collections.defaultdict(set)
    for match in re.finditer(r'\[(SPECIES_\w+)\]\s*=\s*\{(.*?)\n    \},', read('src/data/pokemon/species_info.h'), re.S):
        for item in re.findall(r'\.item(?:Common|Rare)\s*=\s*(ITEM_\w+)', match.group(2)):
            held[item].add(match.group(1))

    given = set()
    for root, _, files in os.walk(os.path.join(SRC, 'data')):
        for file in files:
            with open(os.path.join(root, file), encoding='utf8', errors='replace') as handle:
                for line in handle:
                    if 'ITEM_' in line and not NOT_A_SOURCE.search(line):
                        given.update(re.findall(r'\bITEM_\w+', line))

    icons = dict(re.findall(r'\[(ITEM_\w+)\] = \{(\w+), \w+\}', read('src/data/item_icon_table.h')))
    palettes = dict(re.findall(r'\[(ITEM_\w+)\] = \{\w+, (\w+)\}', read('src/data/item_icon_table.h')))
    files = dict(re.findall(r'const u32 (\w+)\[\] = INCGFX_U32\("([^"]+)"', read('src/data/graphics/items.h')))

    keep, removed = [], collections.defaultdict(list)
    for key, name, pocket in items:
        if key == 'ITEM_NONE':
            continue
        if name == '????????':
            removed['placeholder'].append(key)
        elif pocket == 'POCKET_TM_HM':
            removed['tm_hm'].append(display(name))
        elif key in EVENT_ONLY:
            removed['event_only'].append(display(name))
        elif key in given or held[key] & wild or key in berry_master:
            keep.append({
                'id': BALL_IDS.get(key, key[5:].lower()),
                'name': display(name),
                'pocket': POCKETS[pocket],
                'icon': files[icons[key]],
                'palette': files[palettes[key]],
            })
        else:
            removed['no_source'].append(display(name))
    with open(OUT, 'w', encoding='utf8') as handle:
        json.dump({'commit': '9103e52', 'items': keep, 'removed': removed}, handle, ensure_ascii=False, indent=1)
    print(f'{len(keep)} items', dict(collections.Counter(item["pocket"] for item in keep)), {k: len(v) for k, v in removed.items()})


main()
