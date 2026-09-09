# Outstanding

Things that are **broken or unfinished**, and nothing else. Not a backlog of
ideas — if it works, it does not belong here.

Last reviewed: 2026-09-09, on `feat/upnext-bumpers`.

---

## 1. A card sometimes plays on black

**What happens.** Roughly one Minimal Lofi card in fifteen comes up with no
footage behind it — music and text play normally, the backdrop is black.

**Why.** `readyBackdrop` in `electron/bumperFootage.js` picks ONE clip at
random and returns `null` if that clip turns out to be too short to fill the
card. It does not try another. The card handles a missing backdrop gracefully,
which is exactly why this looks like a working feature rather than a fault.

Three of the 44 shots in her folder are under the floor:

| clip | length |
|---|---|
| `Japan_Subway_Passengers_On_The_Platform` | 6.1s |
| `Timelapse_Of_Urbanisation_In_The_City` | 7.2s |
| `Sao_Paulo_City_During_Sunset` | 7.5s |

**The fix.** Filter the pool by what can actually fill the card before picking,
and fall back to another clip if a cut fails. Small; not done because she was
mid-review and asked for renders rather than changes.

---

## 2. The window will not snap, and cannot without a design decision

**What happens.** Dragging the window to a screen edge does not snap it, and
the Windows 11 Snap Layouts flyout never appears.

**Why — measured, not theorised.** `transparent: true` makes Electron strip
`WS_THICKFRAME` and `WS_CAPTION`, and those are the two bits Windows snaps
from. Four windows built and their styles read back:

| window | style | |
|---|---|---|
| video plane (opaque) | `0x14c70000` | +THICKFRAME +CAPTION |
| overlay AS SHIPPED (transparent, child) | `0x14010000` | **−THICKFRAME −CAPTION** |
| same but opaque | `0x14c70000` | +THICKFRAME +CAPTION |
| transparent with NO parent | `0x14010000` | −THICKFRAME −CAPTION |

Being a child window is irrelevant; transparency alone does it. An earlier
attempt added `maximizable: true`, which supplies `WS_MAXIMIZEBOX` — necessary
but not sufficient — and was wrongly reported as a fix.

`titleBarStyle: 'hidden'` does not help; a transparent window loses the bits
either way. `backgroundColor: '#00000000'` on a non-transparent window KEEPS
the bits, but whether such a window is genuinely see-through was **not**
established — the probe's own control failed, so that avenue is untested
rather than ruled out.

**Options, all needing her call.**
1. Hand the caption drag to the video plane, which has the full style set, via
   `ReleaseCapture()` + `WM_NCLBUTTONDOWN`/`HTCAPTION`. Needs a native call;
   this project has deliberately avoided a native build step.
2. Restructure so the draggable strip is not on the transparent window.
3. Re-test the alpha-background route with a probe whose control works.

---

## 3. The squished picture — fixed, but her symptom was never reproduced

**What she saw.** After a transition while full screen, the video occupied the
top two thirds with black beneath, until she resized the window several times.

**What was found.** mpv sizes its `--wid` child once at creation from
`GetClientRect(parent)` and afterwards only from its own
`SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE)` — asynchronous, coalescible and
cross-process. Nothing in this app ever set that geometry; the raise passed
`SWP_NOSIZE | SWP_NOMOVE`. One lossy hook was the only thing keeping the
picture the size of the plane.

**What shipped.** The raise now sizes the child to the parent's client rect.

**Why it is still listed.** The mechanism is sound and `mpv-embed-proof`
passes, but a stale child was never reproduced on demand, so what shipped
removes the *dependency* on the flaky hook rather than a demonstrated repro. If
she sees it again, it needs a real reproduction before another fix.

---

## 4. Never exercised by a person

Not known to be broken — known to be untested where a person is the only
instrument.

- **A placed film in a schedule has never actually played.** The model has 28
  tests and the editor has screenshot probes, but "the block comes up, the card
  announces the film, the right film rolls" has only ever run in tests.
- **Whether the Minimal Lofi cuts land on the beat** over a full run. Two of 33
  tracks fall back to a plain 90 BPM pulse — `Going Up` (18s, too short to
  analyse) and `Night Owl` (65/53/99, no two ranges agree).
- **The importable bumper template format** from the original brief. Never
  started.

---

## 5. Housekeeping

- Version is still `0.1.0`.
- `feat/upnext-bumpers` has never been merged to `main`.
