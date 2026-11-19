# Pokemon Emerald for Cinnamon

A Gen 3 pixel theme and five extensions for the Claude desktop app on macOS, for use with [Cinnamon](https://github.com/naveengovind/claude-cinnamon).

## Quick install

If you have the prerequisites below, this one line clones the repository, builds the assets and installs everything:

```bash
git clone https://github.com/michaelchang-paraform/cinnamon-pokemon-emerald.git && cd cinnamon-pokemon-emerald && python3 -m venv .venv && .venv/bin/pip install fonttools brotli pillow && ./build.sh && ./install.sh
```

The build takes 7 to 10 minutes. It fetches the game graphics and sound onto your Mac. This repository does not contain them.

For battles, start the battle helper in its own Terminal tab:

```bash
./helper/start.sh
```

## What it changes

Cinnamon is a tool that adds themes and extensions to the Claude app. It does not change the application file of the Claude app.

The theme and the extensions change these parts of the app:

- The colors, in a light mode and a dark mode.
- The fonts. All text uses pixel fonts on one pixel grid.
- The text boxes, the menus, the scrollbars and the selection cursor.
- The sidebar, which looks like a PC box. Each group title has an icon that you can change.
- The app's icons, which become 1-bit pixel art.
- Each chat thread, which gets a partner Pokemon. The partner gets EXP from Claude's work, gains levels and evolves.
- Your messages, which show a trainer sprite that you can customize.
- A battle window for Gen 3 random battles against the CPU, against Claude, or against a trainer on your Wi-Fi.
- Sound effects, cries and battle music.

## Game graphics and sound

The game graphics, fonts and sound belong to Nintendo, Creatures Inc. and GAME FREAK inc. This repository does not include them. It contains code and build scripts only.

`build.sh` fetches the material from its upstream sources onto your Mac, for your personal use:

- [pret/pokeemerald](https://github.com/pret/pokeemerald) for the graphics, the game fonts and the sound data.
- [PokeAPI/sprites](https://github.com/PokeAPI/sprites) for a small number of sprites.
- [pagefaultgames/pokerogue-assets](https://github.com/pagefaultgames/pokerogue-assets) for the Pokemon Emerald Pro font.
- The [galmuri](https://www.npmjs.com/package/galmuri) npm package for the Galmuri9 font.

Do not publish the files that the build generates.

Pokemon is a trademark of Nintendo, Creatures Inc. and GAME FREAK inc. This project is not affiliated with them or endorsed by them. It is also not affiliated with Anthropic or endorsed by Anthropic.

## Prerequisites

- macOS 13 or later.
- The Claude desktop app.
- [Homebrew](https://brew.sh), to install Cinnamon.
- Cinnamon. See "Install Cinnamon".
- The Xcode Command Line Tools, for `git` and the C++ compiler. The build compiles two sound tools from pret/pokeemerald.
- Node.js 18 or later, with `npm`. The battle helper is tested on Node.js 26.
- Python 3 with the `fonttools`, `brotli` and `pillow` packages. `python3` comes with the Xcode Command Line Tools. "Build the assets" installs the packages.
- An internet connection. The build downloads approximately 100 MB.
- Approximately 350 MB of free disk space. The folder uses that much after the build.
- Optional: the `claude` command (Claude Code), installed and logged in. Only battles against Claude need it.
- Optional: [Bun](https://bun.sh). Only the sound tests and the `sync-live.sh` developer scripts need it.

To install the Xcode Command Line Tools:

```bash
xcode-select --install
```

To install Node.js with Homebrew:

```bash
brew install node
```

## Install Cinnamon

1. Install Cinnamon with Homebrew.

   ```bash
   brew install naveengovind/tap/cinnamon
   ```

2. Add the Cinnamon login item. This command also builds Cinnamon Helper.

   ```bash
   cinnamon install
   ```

3. In the Claude app, open the Help menu, then Troubleshooting, then click Enable Developer Mode.
4. Open System Settings, then Privacy & Security, then Accessibility.
5. Set the switch for Cinnamon Helper to on.
6. Quit the Claude app and open it again.
7. Check the setup.

   ```bash
   cinnamon doctor
   ```

Cinnamon Helper uses the Accessibility permission to turn Cinnamon on each time the Claude app starts.

Known problem: `cinnamon install` and `cinnamon update` build Cinnamon Helper again. After that, the Accessibility switch can show on, but the permission does not work. To fix this, select Cinnamon Helper in the Accessibility list and click the minus button. Then click the plus button and add Cinnamon Helper again.

## Build the assets

1. Clone this repository.

   ```bash
   git clone https://github.com/michaelchang-paraform/cinnamon-pokemon-emerald.git
   ```

2. Go into the folder.

   ```bash
   cd cinnamon-pokemon-emerald
   ```

3. Make a Python environment in the folder. `build.sh` uses `.venv` when it exists.

   ```bash
   python3 -m venv .venv
   ```

4. Install the Python packages.

   ```bash
   .venv/bin/pip install fonttools brotli pillow
   ```

5. Run the build.

   ```bash
   ./build.sh
   ```

The build takes 7 to 10 minutes. Most of that time is the download of approximately 2,000 small files. It does these steps:

1. It installs the packages of the battle helper with `npm ci` in `helper/`.
2. It fetches the upstream material into the `source/*/download/` folders.
3. It makes the font subsets and writes `fonts.css` and `fonts-hangul.css`.
4. It writes `themes/pokemon-emerald.json`.
5. It makes the list of the items that you can get in Emerald and writes the item icons.
6. It compiles the two sound tools.
7. It writes the sprite, icon, battle, partner and sound data as CSS files in the extension folders.
8. It makes sure that each file in each `manifest.json` exists.

During the build, `npm` can print deprecation warnings and warnings about install scripts. These warnings are expected. The build is complete when the last line tells you to run `./install.sh`.

All downloads from pret/pokeemerald use one pinned commit, which `build.sh` sets in `POKEEMERALD_COMMIT`.

You can run `./build.sh` again. It keeps the files that it downloaded before. To download everything again, delete the `source/*/download/` folders first.

## Install the theme and the extensions

Run the install script after the build.

```bash
./install.sh
```

The script runs the commands below from your home folder. You can also run them yourself, in this sequence. Replace `/path/to/cinnamon-pokemon-emerald` with the path of your clone.

```bash
cd ~
```

```bash
cinnamon ext install /path/to/cinnamon-pokemon-emerald/extension-theme --yes
```

```bash
cinnamon ext install /path/to/cinnamon-pokemon-emerald/extension-icons --yes
```

```bash
cinnamon ext install /path/to/cinnamon-pokemon-emerald/extension-partners --yes
```

```bash
cinnamon ext install /path/to/cinnamon-pokemon-emerald/extension-audio --yes
```

```bash
cinnamon ext install /path/to/cinnamon-pokemon-emerald/extension-battle --yes
```

```bash
cinnamon theme install /path/to/cinnamon-pokemon-emerald --yes
```

```bash
cinnamon theme pokemon-emerald
```

Cinnamon applies the changes to the Claude app in approximately one second. You do not have to start the app again.

The theme needs the `pokemon-emerald` extension. Without it, the app shows system fonts. The other four extensions are optional. Install only the ones you want.

## Start the battle helper

The battle window needs a small local server, the battle helper. The page code of an extension cannot find other computers on the network, but it can connect to `127.0.0.1`. The battle helper runs the battles, plays the CPU opponent, runs the Claude opponent and finds other trainers on your Wi-Fi.

Start the battle helper in its own Terminal tab, from the folder of your clone.

```bash
./helper/start.sh
```

Keep that tab open while you play. When you close the tab or press Ctrl-C, the battle helper stops and the battle window shows that it is offline.

To open the battle window in the Claude app, press Ctrl+Shift+B or click the battle button.

The battle helper listens on port 41851 on `127.0.0.1` for the app, and on port 41852 on all interfaces for other trainers. To play with no network port, start it with this option.

```bash
./helper/start.sh --no-lan
```

macOS can ask if `node` can accept incoming connections and use the local network. Click Allow to play against other trainers. `helper/README.md` describes the ports, the discovery and the security limits.

### Options for the Claude opponent

| Option | Default | Effect |
| --- | --- | --- |
| `--claude-bin PATH` | `claude` | The `claude` command that the battle helper runs |
| `--claude-model NAME` | `haiku` | The default model: `haiku`, `sonnet`, `opus` or `fable` |
| `--claude-timeout S` | 20 | Seconds for one decision, from 5 to 60 |
| `--claude-battle-budget USD` | 0.5 | The cost limit for one battle |
| `--service-type T` | `pkmn-emerald` | The Bonjour service type. Helpers list only trainers with the same type. |

### Run the battle helper at login (optional)

`helper/launchd/` has an optional LaunchAgent that starts the battle helper at login and starts it again after a crash. The battle helper works without it.

To see what the install does, run it with no option. It changes nothing.

```bash
./helper/launchd/install.sh
```

To install the LaunchAgent:

```bash
./helper/launchd/install.sh --yes
```

To remove it:

```bash
./helper/launchd/uninstall.sh
```

The log is `~/Library/Logs/pokemon-emerald-helper.log`. Stop a battle helper that runs in a Terminal tab before you install the LaunchAgent.

## Update

1. Get the new version.

   ```bash
   git pull
   ```

2. Build again.

   ```bash
   ./build.sh
   ```

3. Install again.

   ```bash
   ./install.sh
   ```

4. If the battle helper runs, stop it and start it again.

To update Cinnamon itself:

```bash
cinnamon update
```

If Cinnamon stops after an update, read the known problem in "Install Cinnamon".

## Turn off or uninstall

To go back to Claude's own colors:

```bash
cinnamon theme default
```

To turn one extension off, use its id. The ids are `pokemon-emerald`, `pokemon-icons`, `pokemon-partners`, `pokemon-audio` and `pokemon-battle`.

```bash
cinnamon ext disable pokemon-battle
```

To turn it on again:

```bash
cinnamon ext enable pokemon-battle
```

To remove everything, run these commands.

```bash
cinnamon theme default
```

```bash
cinnamon theme remove pokemon-emerald
```

```bash
cinnamon ext remove pokemon-battle --yes
```

```bash
cinnamon ext remove pokemon-audio --yes
```

```bash
cinnamon ext remove pokemon-partners --yes
```

```bash
cinnamon ext remove pokemon-icons --yes
```

```bash
cinnamon ext remove pokemon-emerald --yes
```

Then stop the battle helper and delete the folder of your clone. If you installed the LaunchAgent, run `./helper/launchd/uninstall.sh` before you delete the folder.

Cinnamon keeps the settings of a removed extension. To remove them, open `~/.config/claude-cinnamon/config.json` in a text editor. In the `"settings"` object, delete the keys `"pokemon-emerald"`, `"pokemon-icons"`, `"pokemon-partners"`, `"pokemon-audio"` and `"pokemon-battle"`.

The Claude app also keeps five entries in its page storage: `pokemon-partners:v1` (nicknames and reply counts), `pokemon-partners:exp:v1` (EXP), `pokemon-partners:shiny:v1` (shiny rolls), `pokemon-partners:cries:v1` (cry records) and `pokemon-emerald-sound:v1` (sound settings). They are small and have no effect after the removal. To delete them, do this before you remove the extensions: open the developer tools of the Claude app, go to the Console and run the lines below.

```js
localStorage.removeItem("pokemon-partners:v1")
```

```js
localStorage.removeItem("pokemon-partners:exp:v1")
```

```js
localStorage.removeItem("pokemon-partners:shiny:v1")
```

```js
localStorage.removeItem("pokemon-partners:cries:v1")
```

```js
localStorage.removeItem("pokemon-emerald-sound:v1")
```

To remove Cinnamon itself, remove the login item first.

```bash
cinnamon uninstall
```

```bash
brew uninstall cinnamon
```

## Troubleshooting

Start with these two commands. `cinnamon status` shows the current theme, the extensions that are on, and if Cinnamon is applied. `cinnamon doctor` examines the setup and tells you how to fix each problem.

```bash
cinnamon status
```

```bash
cinnamon doctor
```

| Problem | Cause and fix |
| --- | --- |
| The theme is not applied, and `cinnamon status` does not show `applied yes`. | Cinnamon Helper did not turn Cinnamon on. Make sure that Developer Mode is on in the Claude app. Then do the minus button fix in "Install Cinnamon". Then run `cinnamon apply`. |
| The colors are correct, but the text uses system fonts. | The `pokemon-emerald` extension is off or not installed. Run `cinnamon ext` to see the list. Install or enable the extension. |
| An extension is on, but a part of it is missing. | Cinnamon ignores a page file larger than approximately 60 KB after compilation and a CSS file larger than approximately 785 KB. Run `./build.sh` again and make sure that it completes. |
| `cinnamon` stops with an error about a preload or a module that it cannot find. | The current folder has a `bunfig.toml` file with a preload that breaks the command. Run `cd ~` and try again. |
| The battle window shows BATTLE HELPER OFFLINE. | Start the battle helper with `./helper/start.sh` in its own Terminal tab. |
| CLAUDE is gray in the OPPONENT menu. | The battle helper did not find the `claude` command when it started. Install Claude Code, log in, and start the battle helper again. You can also give the path with `--claude-bin`. |
| The battle window does not find other trainers. | Some Wi-Fi networks block discovery. Use "Add by IP" in the battle window. Also make sure that you clicked Allow in the macOS firewall and Local Network prompts. |
| There is no sound. | The sound of the battle window starts muted. Click the speaker button in the title bar of the window. |
| `build.sh` stops with `missing: pyftsubset`. | The Python packages are not installed in `.venv`. Do steps 3 and 4 of "Build the assets" again. |
| `build.sh` stops during a download. | Run it again. It continues with the files that are missing. |
| `source/partners/download.sh` stops with a 403 error from `api.github.com`. | You ran the script alone, and GitHub limits requests that are not signed in to 60 each hour. Run `./build.sh`, which does not use that API, or wait one hour. |

To see what Cinnamon Helper did when the Claude app started:

```bash
cinnamon logs
```

## What each extension does

| Folder | Id | Function |
| --- | --- | --- |
| `themes/` | `pokemon-emerald` (theme) | The colors, the text box frames, the PC box sidebar and the pixel scrollbars. `build.sh` writes it from `source/theme/`. |
| `extension-theme/` | `pokemon-emerald` | Loads the pixel fonts, sets the pixel scale and moves the black selection cursor. Draws the icon before each sidebar group title. |
| `extension-icons/` | `pokemon-icons` | Draws the app's icons again as 1-bit pixel art on the font grid. Can make connector logos look like pixel art. |
| `extension-partners/` | `pokemon-partners` | Gives each chat thread a partner Pokemon with EXP, a summary window and a nickname. Shows your trainer sprite on your messages. |
| `extension-audio/` | `pokemon-audio` | Plays the sound effects, the cries and the battle music for the other extensions. |
| `extension-battle/` | `pokemon-battle` | The battle window. It needs the battle helper. |
| `helper/` | | The battle helper, a local Node.js server. |
| `source/` | | The build scripts, the font tools and the hand-drawn icon art. Cinnamon does not install this folder. |

All settings are in Cinnamon's `config.json`, in `~/.config/claude-cinnamon/`, under `settings["<extension id>"]`. Most of them also have a row in the Claude app: open Settings, then Appearance.

### Theme extension

| Key | Values | Default |
| --- | --- | --- |
| `scale` | Device pixels for each font pixel, a whole number from 1 to 12. Set it to fix the size and ignore zoom. | At 100% app zoom, the default is `round(display scale * 1.2)`. Each app zoom step changes it by one. |
| `textSize` | `"classic"`, `"large-chat"` (messages and the input box one font pixel step larger) or `"large"` (everything one step larger). The row is Text size. | `"classic"` |
| `groupBall` | The default icon before each sidebar group title. The row is Default group icon. | `"poke"` |
| `groupBalls` | The icon of each group that has its own icon. The app writes this key. | none |
| `partner` | `"mudkip"`, `"treecko"`, `"torchic"` or `"none"`. A partner that floats in the sidebar. Set it to `"none"` when you use `pokemon-partners`. | `"mudkip"` |

Group icons: click the icon before a sidebar group title to select an icon for that group. To change the default for all groups, use the Default group icon row. You can select a Poke Ball or any item that you can get in Emerald. TMs and HMs are not in the list, and items that come only from events are not in the list.

The fonts stay sharp only at whole multiples of their pixel grid. The extension calculates all font sizes, line heights and frame sizes from `scale`. Each app zoom step (Cmd+= or Cmd+-) changes `scale` by one.

Korean (Hangul) text uses the Galmuri9 pixel font on the same pixel grid as the Emerald font. The arrow and keyboard symbols that the Emerald font does not have use Galmuri9 or Departure Mono.

### Partners

- The partner comes from the thread's id, so the same thread always gets the same Pokemon. The pool is the base stage of each Gen 1 to 3 evolution family, plus single-stage Pokemon at a lower weight.
- The partner gets EXP from Claude's work in the thread: 1 EXP for each 100 output tokens and 3 EXP for each tool call. The extension estimates the tokens as 4 characters for each token.
- The level comes from the EXP on the Medium Fast curve (level cubed). A new partner starts at level 5. The maximum is level 100.
- The partner evolves at level 15 and level 35. When the partner of the open thread evolves, a short scene plays over the chat.
- Each new partner rolls one time for shiny. The Shiny odds row sets the chance: 1/8192 (the game's value and the default), 1/4096, 1/512 or 1/64. The key is `shinyOdds`.
- The partner shows as a party icon on each sidebar row, next to the chat title and next to the first assistant message of each reply. While Claude responds, the icon moves faster.
- Hover over a partner to see its healthbox. Click it to open the summary window. Drag the title bar to move the window and drag the corner to change its size.
- In the summary window, the left and right arrow keys change the page. Return opens the name or the move data. Esc goes back and closes the window.
- On the INFO page, Return opens the naming screen in the same window. The naming screen uses Tab, Delete, Return and Esc. Type on your keyboard or select keys with the arrow keys and Space. A nickname has a maximum of 10 characters. Each thread keeps its nickname.
- Nature, IVs, gender and ability come from the thread's seed. Stats use the Gen 3 formulas.

Two rows control the sounds of the partners. Both are on by default, and both need the `pokemon-audio` extension.

| Row | Key | Effect |
| --- | --- | --- |
| Play the partner's cry when Claude finishes | `replyCry` (`1` or `0`) | The cry plays when a reply is complete. It plays only for the chat on the screen, while the app has focus. |
| Play level-up sounds while Claude works | `workSounds` (`1` or `0`) | The EXP bar sound and the level-up fanfare play when a partner gains a level. |

To change your trainer, open Settings, then Appearance, then Pokemon partners, then Customize. Select a trainer class, change the colors of its parts and set a name. Cinnamon saves the selection as `settings["pokemon-partners"].trainer`.

### Battle

- Press Ctrl+Shift+B to open the battle window. The battles are Gen 3 random battles: each side gets a random team.
- In the lobby, BATTLE CPU opens the OPPONENT menu. CPU starts a battle against the scripted CPU trainer.
- CLAUDE starts a battle where Claude selects the opponent's moves. This needs the `claude` command (Claude Code), installed and logged in, on the Mac that runs the battle helper. The battle helper runs one isolated `claude -p` call for each decision. Claude sees only its own side of the battle.
- MODEL changes the Claude model: HAIKU (the default), SONNET, OPUS or FABLE. Larger models cost more.
- Claude battles use your Claude Code account. The battle helper stops Claude at 0.50 USD for one battle, and the scripted CPU continues the battle. One decision has a limit of 0.05 USD and 20 seconds. The helper's protocol document shows a 22 move battle on Haiku at approximately 0.02 USD. The result screen shows the cost that Claude Code estimates.
- The lobby also lists the trainers that the battle helper finds on your Wi-Fi. Each trainer needs this setup and a battle helper that runs.
- OPTIONS, then MUSIC opens the music list. AUTO lets the game select the battle music. The 12 other entries are the Emerald battle themes, from VS. WILD POKéMON to VS. RAYQUAZA. The selected track plays in your battles and in the lobby, and the correct victory music plays after a win.
- The sound of the battle window starts muted. The speaker button in the title bar turns it on.

### Icons

- The app draws each icon as one glyph of its icon font. The extension reads the glyph's codepoint and finds it in a table. On a match, it hides the glyph and draws a mask image in the current text color, so the theme colors apply.
- A glyph that is not in the table keeps the app's drawing. New icons from an app update stay as they are.
- `settings["pokemon-icons"].motifs` selects the game object stand-ins: the Bag for Customize, the PokeNav for the terminal and the Town Map for the browser. Set it to `false` to get a toolbox, a prompt and a globe.
- `settings["pokemon-icons"].logos` sets a bitcrush filter for connector and app logos, which are brand images that the extension does not draw again. The values are `"off"`, `"light"`, `"medium"` (the default), `"heavy"` and `"max"`. A higher level uses larger pixels and fewer colors.

The art is in `source/icons/glyphs.mjs` as text grids. `MATCH` connects each codepoint to its art. To add your own art on one Mac, make `source/icons/glyphs.local.mjs`. It exports `ART` (more arts) and `MATCH` (changes for a codepoint), and `build-icons.mjs` merges it. Git ignores that file.

## For developers

`build.sh` runs these scripts. You can run one of them alone after you change its source.

| Script | Output |
| --- | --- |
| `source/fonts/subset-emerald.sh`, `subset-galmuri.sh`, `subset-symbols.sh` | The font subsets in `source/fonts/` |
| `node source/fonts/build-fonts.mjs` | `extension-theme/fonts.css` and `fonts-hangul.css` |
| `node source/theme/build-theme.mjs` | `themes/pokemon-emerald.json` from `source/theme/theme.css` |
| `node source/sprites/build-sprites.mjs` | `extension-theme/sprites.css` |
| `python3 source/sprites/item-list.py`, then `node source/sprites/build-items.mjs` | `source/sprites/items.json`, then `extension-theme/items.ts` and the four `items-*.css` files |
| `node source/icons/build-icons.mjs` | `extension-icons/icons.css` |
| `node source/battle/build-assets.mjs` | The five `extension-battle/battle-*.css` files |
| `node source/partners/build-assets.mjs` and `build-ui.mjs` | The six `extension-partners/partners-*.css` files |
| `node source/audio/build-audio.mjs` | The `extension-audio/audio-*.css` files: sound effects, samples, cries and music |

Each `sync-live.sh` script under `source/` copies one built extension directly into `~/.config/claude-cinnamon/`. The scripts for the icons, partners, battle and audio extensions need Bun to measure the compiled page files. They refuse a page file larger than 55 KB after compilation and a CSS file larger than 500 KB.

The battle helper has an end-to-end test. It starts its own helpers on test ports and a test service type, and stops them at the end. It uses a fake `claude` command, so it does not call Claude.

```bash
cd helper
```

```bash
node test/run-tests.js
```

The sound code has tests that run with Bun after the build.

```bash
bun test source/audio/test
```

## Credits

- Pokemon Emerald Pro font: crystalwalrein, CC BY-SA 3.0. The build makes a subset of it. See `extension-theme/PokemonEmeraldPro-LICENSE.txt`.
- Departure Mono font: Helena Zhang, SIL Open Font License 1.1. See `extension-theme/DepartureMono-LICENSE`.
- Galmuri9 font: Lee Minseo (quiple), SIL Open Font License 1.1, from github.com/quiple/galmuri. The build makes a subset of it. See `extension-theme/Galmuri-OFL.txt`.
- Game graphics, game fonts, sound data and move and ability texts: the pret/pokeemerald decompilation and the PokeAPI sprites repository. The build fetches them. See the `SPRITES-NOTICE.txt` and `AUDIO-NOTICE.txt` files in the extension folders.
- Battle rules, stats, learnsets and the evolution table: the MIT-licensed `pokemon-showdown` package.
- The text box frames, the cursor and the pixel icons are new pixel art. The frames and the cursor come from `source/lib/png.mjs` and the icons from `source/icons/glyphs.mjs`.
