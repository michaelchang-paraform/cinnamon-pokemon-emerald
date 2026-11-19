# Battle helper protocol (page API, version 1)

This document is the contract between the battle screen (a Cinnamon page extension in the Claude app) and the local
battle helper (`helper/`). The helper runs the Pokemon Showdown simulator, the CPU opponent, LAN discovery and LAN
battles. The page only draws the battle and sends the player's choices.

## 1. Transport

| Item | Value |
| --- | --- |
| Health check | `GET http://127.0.0.1:41851/health` returns `{"ok":true,"app":"pokemon-emerald-helper","version":"0.1.0","protocol":1,"status":"idle"}` |
| Message socket | `ws://127.0.0.1:41851/ws` |
| Encoding | One JSON object per WebSocket text frame. Every object has a `type` field. |
| Allowed origins | `https://claude.ai` (the Claude app page) and clients that send no `Origin` (local tools and tests). Other origins get HTTP 403. |
| Max frame | 64 KB from the page. |
| Rate limit | 200 messages a second, burst 400. Extra messages are dropped with `error` `rate_limited`, so resend a dropped `choose`. |

The port is configurable (`--port`). The page reads it from its own settings, default `41851`.

What the page can and cannot do, measured in the Claude app on 2026-11-18:

| From the page | Result |
| --- | --- |
| `fetch('http://127.0.0.1:<port>/...')` (CORS, GET and POST) | Works |
| `new WebSocket('ws://127.0.0.1:<port>')` | Works |
| `new EventSource('http://127.0.0.1:<port>/...')` | Works |
| `<img src="http://127.0.0.1:<port>/x.png">` | Blocked by CSP `img-src` |
| `<img>` from `blob:` URL, `data:` URL, or an `https://` host | Works |

So the page must not point `<img>` or CSS `url()` at the helper. The helper does not serve images. Bundle sprites
in the extension or use `https://` sprite hosts.

### Connection rules for the page

1. Optionally `fetch` `/health` to show "helper not running" quickly.
2. Open the socket and send `hello` first. Every other message before `hello` gets `error` `hello_first`.
3. If the socket closes, reconnect with backoff (1 s, 2 s, 4 s, max 10 s) and send `hello` again.
4. On `hello`, the helper sends `welcome`, `lobby`, any pending challenges and, if a battle is running, the battle
   again (`battle_start` with `resumed: true`, the full log, and the open request). Reset the battle view on every
   `battle_start`.
5. If no page is connected for 60 s during a battle, the helper forfeits that battle (`reason: "abandoned"`).
   A Cinnamon hot reload is shorter than that, so the battle survives it.

More than one page can connect (for example two Claude windows). The helper sends every event to every connected
page, and any of them can send choices.

## 2. Envelope conventions

- Page to helper messages can carry any `type` listed in section 3. Unknown fields are ignored.
- Errors come back as `{"type":"error","code":"<code>","message":"<text>","re":"<type of the message that failed>"}`.
- IDs (`battleId`, `challengeId`, trainer and peer `id`) are lowercase hex strings. Treat them as opaque.
- Names are sanitized by the helper: letters, digits, space, `.`, `_`, `'`, `-`, max 18 characters.
  The page must still render every string from the helper as text (`textContent`), never as HTML.

## 3. Page to helper

| type | Fields | Effect |
| --- | --- | --- |
| `hello` | `protocol: 1` (optional), `name` (optional), `trainer` (optional, see Trainer look) | Starts the session. `name` sets the trainer name. `trainer` sets the avatar. |
| `ping` | `nonce` (optional string) | Helper answers `pong` with the same `nonce`. |
| `set_name` | `name` | Sets the trainer name. Helper broadcasts `trainer`. |
| `set_trainer` | `trainer: {cls, name?, palette?}` | Sets the avatar (and the name if given). Helper broadcasts `trainer`. Other trainers see it at their next poll (within 4 s). |
| `seek` | `looking: true or false` | Marks this trainer as looking for a battle on the LAN. Helper broadcasts `status`. |
| `lobby_refresh` | none | Re-runs discovery and probes, then sends `lobby`. |
| `add_peer` | `host` (IPv4, IPv6 without brackets, or hostname), `port` (optional, default the LAN port) | Adds a trainer by IP when discovery does not work. Helper answers `peer_added`, and the trainer shows in the next `lobby` once it answers. |
| `challenge` | `peerId`, `format` (optional, default `gen3randombattle`) | Challenges a trainer from `lobby.peers`. Helper answers `challenge_sent`. |
| `cancel_challenge` | `challengeId` | Withdraws your outgoing challenge. |
| `respond_challenge` | `challengeId`, `accept: true or false` | Answers an incoming challenge. |
| `start_cpu` | `format` (optional), `difficulty`: `"smart"` (default) or `"random"` | Starts a battle against the CPU. |
| `choose` | `battleId`, `choice`, `rqid` (send the value from the last `request`) | Sends the player's choice for the open request. |
| `forfeit` | `battleId` | Forfeits the current battle. |

Only random formats are accepted (`gen3randombattle`, `gen4randombattle` and so on). Teams are always generated.

### Choice strings

| Choice | Meaning |
| --- | --- |
| `move 1` to `move 4` | Use the move at that index in `request.active[0].moves` (1-based). |
| `switch 2` to `switch 6` | Switch to the Pokemon at that index in `request.side.pokemon` (1-based). Index 1 is the active Pokemon, so it is never a valid switch in singles. |
| `team 123456` | Team preview order. Gen 3 has no team preview, so the UI does not need this. |
| `default` | Let the simulator pick (first legal move, or first legal switch). |

Nothing else is accepted (no `mega`, `zmove`, `dynamax` or `terastallize`: Gen 3 has none of them).

Examples:

```json
{"type":"hello","protocol":1,"name":"May"}
{"type":"start_cpu","difficulty":"smart"}
{"type":"choose","battleId":"a86d2bb80bc7","choice":"move 2","rqid":3}
{"type":"choose","battleId":"a86d2bb80bc7","choice":"switch 4","rqid":4}
{"type":"seek","looking":true}
{"type":"challenge","peerId":"20b37a61ce1ae85c"}
{"type":"respond_challenge","challengeId":"9f1c0e2a7b3d4c5e","accept":true}
{"type":"forfeit","battleId":"a86d2bb80bc7"}
```

### Trainer look

`trainer: {cls, name, palette}` describes a trainer avatar. The helper sends no sprite data: the page draws the sprite.

| Field | Rule |
| --- | --- |
| `cls` | Integer 0 to 29, an index into the trainer classes of the partners extension's Customize trainer dialog (table below). Anything else becomes 0. |
| `name` | Optional on input. Same cleanup as `set_name`. |
| `palette` | Optional. Up to 8 entries, each `"#rrggbb"` or `null`, one for each color group of that class, in the dialog's order. Colors come back lowercase. Invalid entries become `null`. A palette with no colors, or more than 8 entries, becomes `null` (default colors). |

A peer that runs an older helper sends no look. The helper then reports `cls: 0`, `palette: null`.

| cls | id | cls | id | cls | id |
| --- | --- | --- | --- | --- | --- |
| 0 | brendan | 10 | aqua_grunt_f | 20 | pokefan_f |
| 1 | may | 11 | magma_grunt_f | 21 | psychic |
| 2 | youngster | 12 | beauty | 22 | rich_boy |
| 3 | lass | 13 | camper | 23 | runner_m |
| 4 | bug_catcher | 14 | picnicker | 24 | runner_f |
| 5 | hiker | 15 | expert_m | 25 | sailor |
| 6 | black_belt | 16 | expert_f | 26 | school_kid |
| 7 | hex_maniac | 17 | fisherman | 27 | swimmer_m |
| 8 | aqua_grunt | 18 | gentleman | 28 | swimmer_f |
| 9 | magma_grunt | 19 | pokefan_m | 29 | twins |

The order is `TRAINERS` followed by `MORE_TRAINERS` in `source/partners/build-assets.mjs`, which is also the order of `data.t` in the partners extension. The partners setting stores the class by id (`base`), so the page maps the id to its index.

## 4. Helper to page

### Session and lobby

`welcome` (reply to `hello`):

```json
{"type":"welcome","protocol":1,"version":"0.1.0",
 "trainer":{"id":"64a9604e9162c0aa","name":"May","cls":1,"palette":null},
 "status":"idle","looking":false,"defaultFormat":"gen3randombattle",
 "lan":{"enabled":true,"port":41852,"discovery":"dnssd"}}
```

`lan.discovery` is `dnssd` (macOS Bonjour daemon), `mdns` (built-in multicast), or `off`.

`status` (your own status changed): `{"type":"status","status":"looking","looking":true}`

| Status | Meaning |
| --- | --- |
| `idle` | A page is connected, not looking for a battle. |
| `looking` | A page is connected and looking for a battle. |
| `battling` | In a battle (CPU or LAN). |
| `away` | The helper runs but no page is connected. Challenges to an away trainer are refused. |

`trainer` (name or look changed): `{"type":"trainer","trainer":{"id":"64a9604e9162c0aa","name":"May","cls":1,"palette":["#3060c0",null]}}`

`lobby` (sent on `hello`, on `lobby_refresh`, and whenever a peer appears, disappears, or changes name or status):

```json
{"type":"lobby",
 "you":{"id":"64a9604e9162c0aa","name":"May","cls":1,"palette":null,"status":"looking"},
 "peers":[{"id":"20b37a61ce1ae85c","name":"Bob","status":"looking","trainer":{"cls":5,"name":"Bob","palette":null},"address":"192.168.40.31:41852","source":"mdns"}]}
```

`peers` is the full current list, not a delta. `address` is `host:port`, or `[v6]:port` for an IPv6 host. The list holds at most 64 trainers, and one trainer for each address. `source` is `mdns` (found by discovery) or `manual` (`add_peer`).
A peer that stops answering for about 12 s drops out of the list.

`peer_added`: `{"type":"peer_added","address":"192.168.40.31:41852"}`

`pong`: `{"type":"pong","nonce":"abc"}`

### Challenges

`challenge_sent` (your outgoing challenge exists):

```json
{"type":"challenge_sent","challengeId":"9f1c0e2a7b3d4c5e","peer":{"id":"20b37a61ce1ae85c","name":"Bob"},"format":"gen3randombattle"}
```

`challenge_received` (someone challenges you; show Accept and Decline):

```json
{"type":"challenge_received","challengeId":"9f1c0e2a7b3d4c5e","from":{"id":"1953d25fcacaac3e","name":"Alice","trainer":{"cls":7,"name":"Alice","palette":null}},"format":"gen3randombattle","expiresInSeconds":60}
```

`challenge_update` (a challenge left the pending state, in either direction):

```json
{"type":"challenge_update","challengeId":"9f1c0e2a7b3d4c5e","state":"declined","reason":"declined"}
```

| state | When |
| --- | --- |
| `accepted` | The challenge was accepted. `battle_start` follows. |
| `declined` | The other trainer said no. `reason` can be `declined`, `busy`, `away`, `expired` or `cooldown`. `cooldown` means you challenged the same trainer again too soon after a decline, expiry or cancel (default 15 s). |
| `cancelled` | The challenger withdrew it, or it was dropped because a battle started. |
| `expired` | Nobody answered in 60 s. |
| `failed` | The peer could not be reached or disconnected. `reason`: `unreachable`, `peer_disconnected`, `busy`, `start_timeout`. A `failed` update with `challengeId: null` means an accepted challenge never turned into a battle. |

Only one outgoing challenge can be pending at a time. A trainer holds at most 3 incoming challenges.

### Battle

`battle_start` (a new battle, or the current one again after a reconnect):

```json
{"type":"battle_start","battleId":"a86d2bb80bc7","mode":"cpu","format":"gen3randombattle","side":"p1",
 "you":{"name":"May","cls":1,"palette":null},
 "opponent":{"id":null,"name":"CPU Flannery","cpu":true,"difficulty":"smart","cls":12,"palette":null},
 "timerSeconds":null,"resumed":false}
```

- `mode`: `cpu` or `lan`.
- `you` and `opponent` carry `cls` and `palette` (see Trainer look). A CPU opponent gets a random `cls`.
- `side`: your side in the Showdown log, `p1` or `p2`. In a LAN battle the challenger is `p1`.
- `timerSeconds`: the per-choice time limit, or `null` for no limit. LAN battles default to 150 s (both sides get the host's value). CPU battles have none.
- `resumed: true`: the page reconnected. Clear the view and replay the `battle` lines that follow.

`battle` (Showdown protocol lines for your side, in order):

```json
{"type":"battle","battleId":"a86d2bb80bc7","lines":[
 "|","|t:|1795010725",
 "|move|p2a: Groudon|Earthquake|p1a: Lanturn",
 "|-supereffective|p1a: Lanturn",
 "|-damage|p1a: Lanturn|73/339",
 "|move|p1a: Lanturn|Ice Beam|p2a: Groudon",
 "|-supereffective|p2a: Groudon",
 "|-damage|p2a: Groudon|49/100",
 "|","|-weather|SunnyDay|[upkeep]",
 "|-heal|p2a: Groudon|54/100|[from] item: Leftovers",
 "|upkeep","|turn|2"]}
```

The lines are the Showdown battle protocol, unchanged, with these differences:

- `|request|` lines are removed and sent as `request` messages.
- `|error|` lines are removed and sent as `choice_error` messages.
- In LAN battles the guest's helper also drops `|raw|`, `|html|`, `|uhtml|`, chat and join lines from the host.
- HP: your own Pokemon show exact HP (`73/339`). The opponent's Pokemon show percent (`49/100`). `0 fnt` is fainted.
  A status can follow the HP: `73/339 par`.

Lines the battle screen needs to handle (full reference: Showdown `sim/SIM-PROTOCOL.md`):

| Line | Show |
| --- | --- |
| `\|player\|p2\|NAME\|...` | Trainer names. |
| `\|teamsize\|p1\|6` | Party size for the ball row. |
| `\|start` | Battle intro. |
| `\|switch\|p1a: NAME\|SPECIES, L82, F\|HP` and `\|drag\|...` | Send out (or forced out). `p1a` is side p1, slot a. The text after `: ` is the nickname. |
| `\|move\|SOURCE\|MOVE\|TARGET` | Attack animation and "X used MOVE!". `[miss]`, `[still]`, `[from]` can follow. |
| `\|-damage\|POKEMON\|HP` and `\|-heal\|POKEMON\|HP` | Animate the HP bar. `[from] ...` says why (item, weather, poison). |
| `\|-supereffective\|`, `\|-resisted\|`, `\|-immune\|`, `\|-crit\|`, `\|-miss\|` | Battle text. |
| `\|-status\|POKEMON\|STATUS` and `\|-curestatus\|...` | `brn`, `par`, `slp`, `frz`, `psn`, `tox`. |
| `\|-boost\|POKEMON\|STAT\|N` and `\|-unboost\|...` | Stat change text. |
| `\|-weather\|WEATHER` | `SunnyDay`, `RainDance`, `Sandstorm`, `Hail`, `none`. `[upkeep]` means it continues. |
| `\|cant\|POKEMON\|REASON` | Cannot move (`slp`, `par`, `frz`, `flinch`, `recharge`). |
| `\|faint\|POKEMON` | Faint animation. |
| `\|-start\|`, `\|-end\|`, `\|-activate\|`, `\|-item\|`, `\|-enditem\|`, `\|-ability\|`, `\|-sidestart\|`, `\|-sideend\|`, `\|-fail\|` | Battle text. A generic "something happened" message is fine at first. |
| `\|turn\|N` | Turn counter. |
| `\|win\|NAME` and `\|tie` | End of battle (also sent as `battle_end`). |
| `\|`, `\|t:\|...`, `\|upkeep`, `\|gametype\|`, `\|gen\|`, `\|tier\|`, `\|rule\|` | No visual. |

`request` (your choice is open):

```json
{"type":"request","battleId":"a86d2bb80bc7","rqid":3,"request":{
 "active":[{"moves":[
   {"move":"Ice Beam","id":"icebeam","pp":15,"maxpp":16,"target":"normal","disabled":false},
   {"move":"Thunderbolt","id":"thunderbolt","pp":24,"maxpp":24,"target":"normal","disabled":false},
   {"move":"Toxic","id":"toxic","pp":16,"maxpp":16,"target":"normal","disabled":false},
   {"move":"Surf","id":"surf","pp":24,"maxpp":24,"target":"allAdjacentFoes","disabled":false}]}],
 "side":{"name":"May","id":"p1","pokemon":[
   {"ident":"p1: Lanturn","details":"Lanturn, L82, F","condition":"94/339","active":true,
    "stats":{"atk":100,"def":142,"spa":172,"spd":172,"spe":157},
    "moves":["icebeam","thunderbolt","toxic","surf"],"baseAbility":"voltabsorb","item":"leftovers","pokeball":"pokeball"},
   {"ident":"p1: Porygon2","details":"Porygon2, L80","condition":"267/267","active":false,
    "stats":{"atk":174,"def":190,"spa":214,"spd":198,"spe":142},
    "moves":["icebeam","thunderbolt","return102","recover"],"baseAbility":"trace","item":"leftovers","pokeball":"pokeball"}]}}}
```

The request is the Showdown request object for your side only. The helper never sends the opponent's request.
`rqid` is a counter from the helper. Send it back with `choose`, and a choice for an old request gets
`error` `stale_request`.

How to read a request:

| Request shape | UI |
| --- | --- |
| `request.wait: true` | No choice. Show "Waiting for the opponent". |
| `request.forceSwitch: [true]` | Your active Pokemon fainted (or must switch). Show only the party menu. Send `switch N`. |
| `request.active[0]` present | Normal turn. Show FIGHT (the 4 moves) and POKeMON (switch). |
| `moves[i].disabled: true` or `pp: 0` | Grey out that move. |
| only one move, `Struggle` | Show it as the only move, send `move 1`. |
| `active[0].trapped: true` | Hide or grey out switching. |
| `side.pokemon[i].condition` ends with ` fnt` | Fainted. Not a valid switch target. |
| `side.pokemon[i].active: true` | Already in battle. Not a valid switch target. |

Message order: a `request` can arrive before the `battle` lines that lead up to it have finished animating.
Queue it and show the menu only after the animation of all earlier lines ends.

`choice_error` (the simulator rejected a choice; show the menu again):

```json
{"type":"choice_error","battleId":"a86d2bb80bc7","message":"[Invalid choice] Can't switch: You can't switch to an active Pokémon"}
```

`timer` (a choice clock started, or 30 s remain):

```json
{"type":"timer","battleId":"a86d2bb80bc7","side":"p1","secondsLeft":150,"forYou":true}
```

`forYou: false` is the opponent's clock. When a clock reaches zero, that side loses (`reason: "timeout"`).
After a reconnect, the helper sends one `timer` for each clock that is still running, after the replayed `request`.
A clock stops when that side chooses. The page can count down locally from `secondsLeft`.

`battle_end`:

```json
{"type":"battle_end","battleId":"a86d2bb80bc7","result":"win","reason":"normal","turns":41}
```

| result | Meaning |
| --- | --- |
| `win`, `loss`, `tie` | The battle has a verdict. |
| `aborted` | No verdict (the host was busy, or the battle never started). |

| reason | Meaning |
| --- | --- |
| `normal` | All of one side fainted. |
| `forfeit` / `opponent_forfeit` | You / the opponent forfeited. |
| `timeout` / `opponent_timeout` | You / the opponent ran out of time. |
| `abandoned` / `opponent_abandoned` | No page was connected for 60 s. |
| `opponent_disconnected` | The other helper vanished (network loss, quit, sleep). You get the win. |
| `error`, `shutdown`, `host_busy`, `start_timeout` | Something broke. Show "Battle ended" and offer to go back to the lobby. |

After `battle_end` the helper sends `status` (back to `idle` or `looking`).

### Errors

```json
{"type":"error","code":"not_your_turn","message":"not your turn","re":"choose"}
```

| code | When |
| --- | --- |
| `hello_first` | A message arrived before `hello`. |
| `protocol_mismatch` | `hello.protocol` is not 1. |
| `bad_message`, `unknown_type`, `rate_limited`, `internal` | Malformed input, unknown `type`, too many messages, helper bug. |
| `bad_name`, `bad_value`, `bad_format`, `bad_address` | A field failed validation. |
| `busy` | Already in a battle, or a challenge is already pending. |
| `lan_disabled` | The helper runs with `--no-lan`. |
| `unknown_peer`, `peer_busy` | The peer is not in the lobby, or it is battling or away. |
| `unknown_challenge` | The challenge ID is not pending. |
| `no_battle` | `battleId` is not the current battle. |
| `invalid_choice`, `not_your_turn`, `stale_request`, `battle_over` | The choice was refused before it reached the simulator. |

## 5. Lifecycles

### CPU battle

```
page                          helper
hello                  ->
                       <-     welcome, lobby
start_cpu              ->
                       <-     battle_start (mode cpu, side p1), status battling
                       <-     battle (intro, switch-ins, turn 1)
                       <-     request (rqid 1)
choose move 2, rqid 1  ->
                       <-     battle (turn 1 events ... turn 2)
                       <-     request (rqid 2)
   ... repeat ...
                       <-     battle (... faint, win)
                       <-     battle_end (win or loss), status idle
```

The CPU picks its move as soon as its own request arrives, so the turn resolves right after the player chooses.
`difficulty: "smart"` prefers strong super-effective moves with STAB and heals when low. `"random"` picks any legal move.

### LAN battle

```
Alice page        Alice helper (host, p1)        Bob helper (guest, p2)        Bob page
seek looking  ->                                                           <- seek looking
              <-  lobby (Bob looking)                 lobby (Alice looking) ->
challenge Bob ->  connect to Bob's LAN port  ------>  challenge_received    ->
              <-  challenge_sent                                           <- respond_challenge accept
                  challenge accepted         <------
              <-  challenge_update accepted           challenge_update accepted ->
              <-  battle_start (p1)          ------>  battle_start (p2)     ->
              <-  battle, request            ------>  battle, request       ->
choose        ->  simulator                  <------  choose                <- choose
   ... repeat ...
              <-  battle_end                 ------>  battle_end            ->
```

- The challenger's helper runs the simulator. The guest's helper relays.
- Each helper sends its page only that side's view: the host never sends Bob's request to Alice, and the
  guest's helper drops any request that is not for `p2`.
- If either helper vanishes, the other side gets `battle_end` `win` `opponent_disconnected`. A process that quits is
  noticed at once. A machine that drops off the network is noticed within about 15 s (heartbeat).
- Forfeit on either side ends the battle for both.

## 6. What the battle screen must show

1. Helper state: not running (health check fails), connecting, connected. When it is not running, show how to
   start it: `~/dev/cinnamon-themes/pokemon-emerald/helper/start.sh`.
2. Lobby: your trainer name (editable, sends `set_name`), a "Looking for a battle" toggle (`seek`), the list of
   trainers with status, a Challenge button for `idle` or `looking` peers, a "Battle the CPU" button, and an
   "Add by IP" field (`add_peer`) for networks where discovery fails.
3. Challenges: pending outgoing challenge with Cancel. Incoming challenges with Accept and Decline and the 60 s
   countdown. A short notice for each `challenge_update`.
4. Battle: both active Pokemon with name, level, HP bar (exact numbers for yours, percent for the foe), status
   condition, the party ball rows, the battle text log, weather, and the turn number.
5. Menus driven only by `request`: FIGHT with 4 moves (type, PP, greyed when disabled), POKeMON party switch,
   forced switch after a faint, "Waiting for the opponent" for `wait`, and RUN which sends `forfeit` after a confirm.
6. The choice clock from `timer` in LAN battles.
7. The result screen from `battle_end`, with the reason, and a button back to the lobby.
