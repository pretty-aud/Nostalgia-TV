# Nostalgia TV

Your own TV channel from a folder of episodes. Shows come up in a random order,
but each show always plays its next episode in sequence — and a bumper between
episodes tells you what's coming.

## Two names that are deliberately still "shuffle-tv"

The app was renamed from Shuffle TV, but two identifiers were left alone on
purpose, because changing either causes real damage:

- **`app.setPath('userData', …/shuffle-tv)`** in `electron/main.js` is the live
  save location — every show's place, the thumbnail cache and the prepared-file
  cache. Renaming it to match the product would abandon all of it. It is
  invisible to the viewer, so the tidiness is not worth the data.
- **`build.appId`** in `package.json` is the installer's identity. Keeping it
  means the next install upgrades the existing entry instead of leaving a dead
  "Shuffle TV" behind in Add/Remove Programs.

## Running it

```bash
npm install
```

```bash
npm start
```

Then click **Choose your TV folder** and point it at the folder holding your shows.

## How it decides what plays

Two rules, and the tests exist to keep them honest:

1. **Shows shuffle.** Every show goes into a deck, the deck is shuffled, and it
   deals from that deck until it is empty before shuffling a new one. So no show
   comes back around until every other show has had a turn. Rolling a die at each
   transition instead would let shows clump and starve — that is the thing this
   design exists to avoid.
2. **Episodes don't.** Within a show the cursor only ever moves forward, one
   episode at a time, in broadcast order.

### The bumper does not lie

The schedule is **committed in advance** and saved to disk, not recomputed at
each transition. The bumper reads the same queue the player consumes, so the
three things it promises are the three things that play. `test/scheduler.test.js`
asserts exactly that: peek three, play three, compare.

### Rotation modes

| Mode | Behaviour |
|---|---|
| **One each** (default) | Every show gets a turn before any repeats. |
| **Blocks** | Two episodes of a show back to back, then move on. |
| **Random** | Straight random pick, still never twice in a row. |

## Folder layouts it understands

You should not have to reorganise anything. All of these work, mixed together:

```
TV/Detective Marlow/Detective Marlow - S01E01 - Cold Open.mp4
TV/Kitchen Nightmares/Kitchen Nightmares 1x01.mp4
TV/Some Show/Season 1/ep1.mp4
TV/Some Show/Specials/Christmas.mp4
TV/The Grand Tourist/The.Grand.Tourist.S01E02.Lisbon.1080p.WEB-DL.x264-GRP.mp4
TV/Night Radio/Night Radio 2024.03.15.mp4
TV/Loose Show - S01E01.mp4
```

Notes on the parsing:

- Show name comes from the top-level folder; a loose file at the root falls back
  to the text before the episode number.
- `Season 1`, `S02`, and `Specials` subfolders are read as seasons, not shows.
- Release noise (`1080p`, `x264`, `WEB-DL`, `-GROUP`, `[tags]`) is stripped from
  titles and never mistaken for an episode number. `1920x1080` does **not** parse
  as season 20 episode 108.
- Specials (season 0) sort **after** the main run, so a channel never opens a
  show on a Christmas special instead of the pilot.
- Files with no readable number fall back to natural filename order (`ep2` before
  `ep10`, not after) and the show is flagged **check naming** in the sidebar
  rather than being silently misordered.

## Progress and resuming

Saved to `channel-state.json` in the app's user-data folder, written atomically.

Progress is anchored by **file path**, not by position in the list. If you add or
remove an episode, a rescan re-anchors to the right place instead of silently
jumping. Mid-episode position is saved too, so closing the app offers a resume.

## Keyboard

| Key | Action |
|---|---|
| `Space` | Play / pause (or start the channel) |
| `←` / `→` | Back 10s / forward 30s |
| `N` | Next episode |
| `M` | Mute |
| `F` | Fullscreen |
| `L` | Library (while playing) / resume or start (on the library screen) |
| `Esc` | Leave fullscreen, or close an open dialog |
| Any key | During a bumper: start the next episode now |

## Formats

Anything Chromium can decode plays natively — `.mp4` (H.264/AAC) and `.webm` are
the safe cases. `.mkv` containers often carry AC3/DTS audio that Chromium cannot
decode, which shows up as video with no sound; older `.avi`/`.wmv` codecs may not
play at all. A file that fails is reported and skipped rather than stalling the
channel.

The installer carries ffmpeg, so those cases are handled on any machine without
anything else being installed first: the app converts ahead of time, from the
committed queue, while the current episode is still playing. It still prefers a
copy bundled inside itself over one on the system, so a machine that already has
ffmpeg gets the version this build was tested against rather than whatever
happens to be on its PATH.

## Building an installer

```bash
npm run dist
```

Leaves `dist/Nostalgia TV Setup.exe` — a one-click, per-user installer needing
no admin rights, and `dist/Nostalgia TV (portable).exe`, which runs without
installing at all. Both are self-contained: Electron, the app and ffmpeg. About
140 MB packed, 508 MB installed.

The first build fetches ffmpeg, because 160 MB of binaries do not belong in a
git repo — GitHub refuses single files over 100 MB outright. It is cached in
`vendor/` and only fetched again if that copy is missing or will not run:

```bash
npm run vendor:ffmpeg
```

The build fetches it as a hard prerequisite rather than a warning. An installer
that quietly shipped without ffmpeg would install perfectly and then fail only on
the files that needed converting — the worst possible place to find out.

It is a GPL build (FFmpeg n9.0, win64-gpl-shared, from BtbN's releases), because
the full-conversion tier encodes with libx264 and LGPL builds do not carry it.
Shared rather than static: `ffmpeg.exe` is 0.5 MB and `ffprobe.exe` 0.2 MB
against one shared set of DLLs, where the static build every winget install lands
on is 212 MB *each*. The licence travels with the binaries in
`resources/ffmpeg/LICENSE.txt`.

```bash
npm run deploy
```

Same build, then installs it over the local copy and verifies the installed hash
matches — for testing a change on this machine. It deletes the loose exes
afterwards on purpose, so use `npm run dist` when you want an installer to keep.

## Testing

```bash
npm test
```

The vitest suite (22 files) covers the filename parser, the scheduler, set
schedules, locks, the browse library, the IPC surface, the markup/id wiring,
media streaming, and the prepare pipeline — including the invariants that
matter: episodes never go backwards, no show plays twice in a row, every show
gets a turn per round, and the bumper's promise matches what plays. The exact
test count changes as features land; `npm test` prints it.

### Test fixtures

Needs no ffmpeg and no downloads — Chromium encodes the clips itself:

```bash
npx electron scripts/make-fixtures.js "C:\path\to\output"
```

Writes 22 short clips across 8 shows, deliberately using mixed naming
conventions so the run exercises every branch of the parser. Each clip burns its
show name, episode code and a running clock into the picture, so you can see at a
glance whether what played matches what the bumper promised.

## Architecture

| Path | Role |
|---|---|
| `src/shared/parseEpisode.js` | Filename → show/season/episode. Pure, no filesystem. |
| `src/shared/scheduler.js` | The deck shuffle and the committed queue. Pure, injectable RNG. |
| `electron/main.js` | Folder scan, state persistence, and the `media://` protocol. |
| `electron/preload.js` | The whole renderer-facing API surface, explicitly enumerated. |
| `src/renderer/` | UI. Bundled by esbuild; no framework. |

Both rule-bearing modules are pure and take their randomness as a parameter,
which is what makes the invariants testable rather than a matter of opinion.

The fonts in `src/renderer/fonts/` are vendored woff2 copies of Inter,
Space Grotesk and JetBrains Mono, originally taken from the
`@fontsource-variable` npm packages (v5.3). They are committed directly and
loaded by relative `url()` from `styles.css`; nothing depends on the npm
packages, so a font refresh means replacing the woff2 files by hand.

### Security posture

`contextIsolation` on, `nodeIntegration` off, and no generic `invoke(channel)`
escape hatch in the preload. The `media://` handler serves files **only** from
inside a folder you actually picked, so a bug in the UI cannot turn into a read
of arbitrary files on disk. It answers real HTTP `206` range requests, which is
what makes seeking work in a multi-gigabyte episode.
