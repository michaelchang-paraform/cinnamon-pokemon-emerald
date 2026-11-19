# pokemon-audio acceptance test

`run.ts` checks that a build of the pokemon-audio extension makes exactly the same sound as the recorded set in
`golden.json`, the output of v1.0.2. It uses only the public `window.__peAudio` API, so it works for any engine
behind that API.

## What it does

1. It reads `extension-audio/manifest.json` and loads every page file in manifest order. Stand-ins replace the
   browser APIs that the files use: `window`, `document`, `getComputedStyle` (it serves the custom properties from
   the manifest's CSS files), `localStorage` (every window unmuted), `AudioContext`, `AudioBuffer` and `cinnamon`.
2. It waits for `__peAudio.ready`, then sends one `pointerdown` so the extension creates its audio context.
3. It asks for every sound, and records the buffer that the extension hands to its source:
   - `play(id, { window: 'summary', pitch })` for each effect in `sfxList()`, at pitch 0 and 3.
   - `cry(dex, { window: 'summary', mode })` for dex 1 to 386, in the modes normal, weak, faint, doubles,
     high_pitch, growl, roar and echo.
   - `prepareMusic(id)`, then `music(id, { window: 'battle' })` for every track and victory track in `musicList()`.
     It uses `fanfare(id, { window: 'summary' })` for MUS_LEVEL_UP and MUS_EVOLVED.
4. It hashes each buffer (SHA-256 of the Float32 samples, the sample rate, and the loop start and end of a looping
   buffer) and compares the hashes with `golden.json`. There are 3,345 hashes: 238 effects, 3,088 cries and 19 music
   tracks.

## Use

Run these commands from the project root after `source/audio/download.sh` and `source/audio/build-audio.mjs`:

```sh
bun source/audio/acceptance/run.ts                          # compare with golden.json; exit 1 on any difference
bun source/audio/acceptance/run.ts --only cry:25            # compare one group, for example Pikachu's cries
bun source/audio/acceptance/run.ts --ext path/to/extension  # check another build of the extension folder
bun source/audio/acceptance/run.ts --write new.json         # record a new hash set
```

A full run takes about one minute. The output names each key that differs or is missing, for example
`differs music:MUS_VS_WILD`.

## Requirements for an engine

- Publish `window.__peAudio` with `ready`, `sfxList()`, `play()`, `stop()`, `cry()`, `musicList()`,
  `prepareMusic()`, `music()`, `fanfare()` and `stopMusic()`, and keep the options listed above.
- Read the generated data from the CSS custom properties through `getComputedStyle`.
- Create audio only through `AudioContext.createBuffer` with `copyToChannel`, or `new AudioBuffer` with
  `copyToChannel`, and play it through `createBufferSource()` and `start()`. The test records the buffer at
  `start()`.
- The hashes depend on the generated CSS. Build the data from the same pokeemerald commit as `download.sh`.
