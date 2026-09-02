# The mpv player branch

Branch `mpv-player`. Goal: Nostalgia TV with **no conversion pipeline at all** —
mpv decodes everything the library holds (E-AC3/AC3/DTS audio, Matroska,
image subtitles), switches audio tracks instantly, and renders into a native
window this app owns. `main` stays the shipping Chromium-player app until
Audrey has tested this branch and said so; **nothing here deploys over her
shortcuts before that**.

## The two-plane design

- **Video plane** — the existing main BrowserWindow, reduced to a black host.
  mpv is spawned with `--wid=<its HWND>` (via `getNativeWindowHandle()`) and
  renders into it. mpv also draws **subtitles** here (its own renderer: full
  ASS styling, PGS/VobSub work — both currently impossible).
- **Interface plane** — a second frameless, `transparent: true` BrowserWindow,
  `parent`-owned by the video plane, bounds-synced to it on every move/resize/
  fullscreen change. It loads the EXISTING `index.html` renderer, unchanged.
  Where the DOM is transparent you see video; opaque screens (library,
  settings, cards, welcome) simply cover the plane. **All input lands here** —
  a click that hits no control is "clicked the video", exactly the current
  semantics. Keyboard focus lives here permanently.

Why this app suits the design: episodes already play with no chrome (chrome
is hover/press-only, Audrey's rule), and every heavyweight surface is an
opaque full-screen. The interface plane is invisible during exactly the hours
that matter.

## Control channel

`electron/mpvClient.js` — JSON IPC over a named pipe (`\\.\pipe\ntv-mpv-<pid>`),
request_id-correlated, property observers, teardown-rejects-pending. Built and
tested against a fake mpv speaking the real wire protocol
(`test/mpvClient.test.js`, 12 tests; correlation + teardown mutation-checked).

Still to build, in order:

1. **S-mpv-2: process + window plumbing.** ✅ **The embedding is PROVEN**
   (`scripts/mpv-embed-proof.cjs`, all five checks green: mpv renders, video
   visible through the transparent plane, interface paints above it, a real
   OS click lands on the interface, and a control click off the button does
   not count). mpv v0.41.0 vendored via `scripts/vendor-mpv.mjs` (release-API
   asset discovery, proof-by-running, `--ensure` wired into `npm run dist`,
   extraResource `vendor/mpv` → `resources/mpv`).
   **Findings the production module MUST honour:**
   - 🚨 **Chromium's compositor children (`Chrome_RenderWidgetHostHWND`,
     `Intermediate D3D Window`) sit ABOVE mpv's `--wid` child and paint over
     it** — mpv keeps reporting vo-configured and advancing time, invisibly.
     **After spawning mpv, raise its child** (class `mpv`) with
     `SetWindowPos(HWND_TOP)`; a one-shot hidden PowerShell call does it with
     zero native deps. Covers the whole client area — the video window's DOM
     is deliberately unused.
   - 🚨 **PowerShell marshals `$null` to an EMPTY STRING for string P/Invoke
     parameters** — every FindWindowEx "wildcard" silently matches nothing.
     Use `[NullString]::Value`.
   - `getNativeWindowHandle().readBigUInt64LE(0)` round-trips correctly
     (verified against FindWindowEx by title).
   - Her desktop is multi-monitor (mpv landed on `\\.\DISPLAY2`, 3440x1440
     ultrawide) — any screen-coordinate work must use per-display scale
     factors, not the primary's.
   - The harness pins userData to a scratch profile FIRST — the package name
     is shuffle-tv, so a default-profile harness would collide with her
     RUNNING app.
   ✅ **S-mpv-2 COMPLETE (`bef76f6`):** `electron/mpvPlayer.js` (vendored-only
   binary discovery, the argument contract, raise-after-every-spawn, restart
   policy — pure + 11 tests) and `electron/planeManager.js` (window pair,
   bounds glue on every content-moving event + trailing settle pass, focus
   forwarded to the interface plane, one taskbar entry). The proof harness
   now runs THROUGH the production modules — six checks green, including
   kill-mpv-externally → auto-restart → the red pixel physically back on
   screen. ⚠️ The harness's crash check uses `taskkill /IM mpv.exe` — it
   would kill any unrelated mpv on the machine; fine for a dev proof, do not
   copy the pattern.
2. **S-mpv-3: the player facade.** ✅ **COMPLETE (`0f6b5cf`).**
   `src/renderer/mpvBridge.js` (the `<video>` face) + `electron/mpvHost.js`
   (typed IPC, path-guarded open, observer registry) + the preload surface.
   Two review rounds, 30 confirmed findings folded in. **Contracts the next
   steps build on:**
   - 🚨 **The staleness gate**: the prop stream and command channel are not
     synchronised; `open()` increments `pendingLoads`, mpv's `start-file`
     event (exactly one per loadfile, FIFO) decrements, and per-file
     messages are dropped while a load is pending. **Its failure paths are
     load-bearing**: mpv:restarted RESETS the gate, a refused open unwinds
     its increment, `mpv:died` suspends all mirrors until the restore.
   - `intended` (pause/volume/mute) = what the viewer chose; observed props
     never write it; crash restores read it.
   - The player swaps its live client LAST during respawn; the host attaches
     event handlers synchronously FIRST — no command may reach a process
     whose start-file has no listener.
   - 'ended' = `eof-reached` rising edge (keep-open); 'error' = end-file
     reason error, gated; loadedmetadata once per open; timeupdate ~4 Hz.
   - The channel-contract suite pins EXACTLY which mpv:* channels main.js
     does not register yet — the S-mpv-5 switchover must turn that pin empty.
3. **S-mpv-4: features onto mpv properties.** ✅ **COMPLETE (`be21a9b`).**
   `src/shared/mpvTracks.js` (playability's ladder mirrored; SHARED
   isCommentary + mpv's `visual-impaired` flag; menus read mpv's own
   `selected`), `src/shared/mpvSubStyle.js`, `src/shared/mpvCrop.js`, host
   verbs (`mpv:setSubStyle` allowlist w/ hasOwn + typeof-before-regex,
   `mpv:setSubVisibility`, `mpv:setVideoCrop`). **Contracts learned:**
   - 🚨 **mpv 0.39+ subtitle model: the box only draws in
     `sub-border-style=background-box`** — colours alone render NOTHING on
     the default mode (invisible-subs blocker, pixel-proven fixed:
     rgb(0,0,64) over the blue clip). Box-off = outline-and-shadow +
     outline 3. **ASS tracks keep their authored look — deliberate.**
   - 🚨 **Crop is `video-crop` (pixel box), NOT zoom/pan** — the CSS zoom
     came from the window aspect, which static properties cannot know;
     video-crop re-fits at every window size. Rounding keeps picture in
     every direction: origins floor, sizes grow FROM THE FAR EXTENT.
   - Sub style: sizes are % of mpv's default 38; colours are `#AARRGGBB`;
     positions top/middle/bottom → sub-pos 10/50/100; one real font family
     per role.
   14-check harness; suite 512.
4. **S-mpv-5: retire the conversion world (branch-only).** prepare-ahead,
   playableUrls, the preparing overlay, filler promos, tier planning,
   measured verdicts, the prepared cache + cleanup + budget, `media://` for
   playback. Library-table "conversion" column becomes "plays directly".
   Thumbnails move fully onto the bundled-ffmpeg artwork machinery (the
   in-page `<video>`-canvas decoder goes with the `<video>` element).
5. **S-mpv-6: soak + Audrey's test pass**, then the merge/ship decision.

## Traps and open questions

- **Owned-window glue is hand-rolled**: Electron `parent` gives z-order, not
  bounds-sync. Sync on `move`/`resize`/`enter-full-screen`/`restore`; verify
  on a DPI change and on her multi-monitor setup.
- **The drive is back on the critical path.** Conversion accidentally moved
  playback reads to C:. Direct play streams off the USB drive that still
  negotiates USB 2.0 and dislikes sustained reads. Default mpv cache modest
  (`--cache=yes`, bounded `demuxer-max-bytes`); revisit after the drive is
  fixed. Do NOT benchmark the drive.
- **Same userData** (`shuffle-tv`) so her progress carries over — but the two
  builds must not RUN simultaneously. Test builds run from the branch
  (`npm start` or a portable exe), never `npm run deploy`, until blessed.
  Remember the packaged-rename orphan trap before giving this build its own
  productName/appId.
- **shoot-state.js** captures the interface plane only; screenshots of
  composited video+UI need a different proof (mpv `screenshot-raw`, or accept
  UI-only shots).
- mpv Windows builds ship as an archive (~70–90 MB); vendored like ffmpeg
  (binary NOT in git; README records provenance + version).
