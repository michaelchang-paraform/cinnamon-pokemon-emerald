# Pokemon Emerald battle helper

A small local server for the Pokemon Emerald battle screen in the Claude app (a Cinnamon page extension).
It runs Gen 3 random battles with the MIT-licensed [`pokemon-showdown`](https://www.npmjs.com/package/pokemon-showdown)
simulator, plays the CPU opponent, finds other trainers on the same network, and runs LAN battles.

Cinnamon page extensions run inside the Claude window. They cannot open UDP sockets, use mDNS or start processes,
but they can open a WebSocket to `127.0.0.1`. This helper does the rest. The page protocol is in
[HELPER_PROTOCOL.md](HELPER_PROTOCOL.md).

## Ports

| Port | Bind | Use |
| --- | --- | --- |
| 41851 | `127.0.0.1` only | Page API: `GET /health` and `ws://127.0.0.1:41851/ws` |
| 41852 | `0.0.0.0` (all interfaces) | LAN: `GET /info` and the peer battle socket `/battle` |

## Start

```sh
./helper/start.sh
```

`start.sh` runs `node --max-old-space-size=512 src/server.js` and passes its arguments through. It uses the `node`
on `PATH`, or `PKMN_NODE` if set. Stop it with Ctrl-C.

| Option | Env | Default | Effect |
| --- | --- | --- | --- |
| `--port N` | `PKMN_PORT` | 41851 | Page API port |
| `--lan-port N` | `PKMN_LAN_PORT` | 41852 | LAN port |
| `--lan-host ADDR` | | `0.0.0.0` | LAN bind address |
| `--name NAME` | `PKMN_NAME` | `Trainer` | Trainer name until the page sends one |
| `--format ID` | `PKMN_FORMAT` | `gen3randombattle` | Default format (random formats only) |
| `--no-lan` | | | CPU battles only. No LAN port, no discovery. |
| `--discovery MODE` | `PKMN_DISCOVERY` | `auto` | `dnssd` (macOS Bonjour daemon), `mdns` (built-in multicast), `off`. `auto` picks `dnssd` on macOS. |
| `--peer HOST[:PORT]` | `PKMN_PEERS` (comma list) | | Trainers to add without discovery. IPv6: `[fe80::1]:41852` |
| `--lan-timer S` | | 150 | Seconds per choice in LAN battles (0 = no clock) |
| `--cpu-timer S` | | 0 | Seconds per choice in CPU battles (0 = no clock) |
| `--service-type T` | `PKMN_SERVICE_TYPE` | `pkmn-emerald` | Bonjour service type and lobby namespace. Helpers only list peers with the same type. The tests use `pkmn-emrld-test`. |
| `--challenge-cooldown S` | | 15 | Seconds a trainer must wait before challenging again after a decline, expiry or cancel |
| `--allow-origin URL` | `PKMN_ALLOWED_ORIGINS` | `https://claude.ai` | Extra page origins allowed to connect |

Example for a second instance on the same Mac: `./start.sh --port 41861 --lan-port 41862 --name Bob`.

## macOS prompts

- **Firewall.** When the macOS application firewall is on, the first start can show "Do you want the application
  node to accept incoming network connections?". Click Allow, or other trainers cannot connect to port 41852.
  The page API on 127.0.0.1 does not need it. If you clicked Deny, change it in System Settings > Network >
  Firewall > Options.
- **Local Network.** macOS asks the app that starts node (Terminal, iTerm, or another launcher) for Local Network
  access. Allow it, or connections to other machines fail. In a process with no Local Network access, node's own
  multicast fails with `EHOSTUNREACH`. That is why the default discovery uses the system Bonjour daemon through
  `/usr/bin/dns-sd`.

## Discovery

Each helper registers `pkmn-<id>._pkmn-emerald._tcp` with Bonjour and browses for the same type. For each instance
it finds, it resolves the address and polls `GET /info` on the LAN port every 4 s for the name and status. A trainer
that misses 3 polls drops out of the lobby.

Networks that block multicast (many office, hotel and campus Wi-Fi networks with client isolation) hide trainers
from each other. Use "Add by IP" in the battle screen (`add_peer`), or start with `--peer 192.168.1.23`. Client
isolation also blocks the direct connection, and then no LAN battle is possible on that network.

## Security

- The page API listens on 127.0.0.1 only and accepts WebSocket connections only from `https://claude.ai` (or from
  local clients that send no `Origin`). Other web pages cannot drive it.
- The LAN port answers only `GET /info` and the `/battle` socket. It refuses browser connections (any `Origin`
  header), allows 16 sockets in total and 4 for each IP, limits frames to 256 KB and 500 messages a second, and
  closes a socket on the first malformed message. An inbound socket with no challenge or battle closes after 10 s.
- A trainer who is declined, or whose challenge expires or is cancelled, cannot challenge again for 15 s.
- The lobby holds at most 64 trainers and one trainer for each address. A trainer ID that still answers at its
  address cannot be taken over by another address.
- Discovery runs at most 4 Bonjour lookups at a time and tracks at most 64 names.
- The guest closes the battle socket if the host sends more than 2 MB or 20000 log lines, or a request over 32 KB.
- Every peer message is checked for type and shape. Choices must match `move 1-4`, `switch 1-6`, `team 1-6` or
  `default` before they go to the simulator, and only to that player's own input. Nothing from a peer is evaluated
  or run.
- Trainer names are reduced to letters, digits, space and `._'-`, at most 18 characters.
- The guest drops HTML and chat lines from the host and any request that is not for its own side.
- Trust model: the challenger's helper runs the simulator, so it sees both teams. A modified host could cheat. This
  is for friends on one network, not ranked play.

## Run at login (optional, not installed)

The helper does not install a login item. To start it at login, create
`~/Library/LaunchAgents/com.pokemon-emerald.helper.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pokemon-emerald.helper</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/cinnamon-pokemon-emerald/helper/start.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PKMN_NODE</key><string>/path/to/node</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/pokemon-emerald-helper.log</string>
  <key>StandardErrorPath</key><string>/tmp/pokemon-emerald-helper.log</string>
</dict>
</plist>
```

Then run `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pokemon-emerald.helper.plist`. To remove it,
run `launchctl bootout gui/$(id -u)/com.pokemon-emerald.helper` and delete the file. Expect the firewall and Local
Network prompts again for the launchd-started node.

## Test

```sh
node test/run-tests.js
```

The test starts its own helpers on ports 41951, 41952, 41961/41962 and 41971/41972 and kills them at the end.
It plays a full CPU battle, a full LAN battle between two helpers on this Mac (found through Bonjour), and checks
that neither player receives the other side's request, stats or exact HP. It also covers reconnect and resume,
forfeit, the choice clock, decline, and a peer that dies mid-battle. Set `PKMN_VERBOSE=1` to see helper logs.

## Files

| Path | Contents |
| --- | --- |
| `src/server.js` | Command line and startup |
| `src/helper.js` | Page API, lobby, challenges, battle orchestration |
| `src/battle.js` | One Showdown battle: player streams, requests, clock, forfeit |
| `src/ai.js` | CPU opponent (scores moves by power, STAB, type matchup, accuracy) |
| `src/lan.js` | LAN port, peer sockets, peer list, polling |
| `src/dnssd.js` | Bonjour through macOS `dns-sd` |
| `src/util.js` | Validation, name cleanup, rate limiter |
| `test/run-tests.js` | End-to-end test |
