# Mobile detail view — design

Three complaints from using the site on a phone, and what they turn out to be.

## Why

**"It flickers and shows book shapes when it loads."** The static catalog — the
no-WebGL fallback — is displayed for the whole of loading and then snaps away.
Traced on a 390×844 viewport with 4× CPU throttling and a 1.6 Mbps line:

| | `.static-fallback` | canvas | `#loading` |
|---|---|---|---|
| t+0.3s – t+13s | full screen, 390×844 | opacity 0 | hidden until t+4.5s |
| t+18s | gone | 0.77 | hidden |

Fifteen seconds of a catalog nobody asked for, which also overflows horizontally
on a phone — the title clips and the cards run off the right edge. And no loading
signal at all for the first four seconds.

**"Make the book info a panel you can open and close, or a popup."** Today the
information is a bare block of text pinned over the bottom 40vh of the canvas.
The paper background, border, shadow and blur the base layer defined are all
stripped by a later unconditional rule, so the copy floats directly on the 3D
scene with nothing behind it. The deck is clamped to three lines and the binding
specs are `display: none` below 820px, so most of what the panel is for does not
render on the device where it takes the most room.

**"Make the book easier to zoom and drag — bottom controls or buttons."** The
book is sized to 94% of the viewport width, so there is almost no background left
to start a one-finger orbit on. Pinch works but competes with the page-drag
handler. The two controls that exist, `Open book` and `Reset view`, are 32px tall
with no padding — below the 44px touch minimum — and both vanish entirely when
the book is open, leaving `Esc` as the only way to close it. There is no `Esc` on
a phone.

Underneath all three is one more thing, and it is the reason zooming feels
broken rather than merely awkward: `resize()` calls `resetInspectionView()`
unconditionally, and a mobile URL bar collapsing fires `resize`. Zoom in, scroll,
and the camera you set is gone.

## What changes

### 1. The static catalog appears only when WebGL fails

It is a fallback, not a loading screen. Default it to hidden and let
`showFallback()` reveal it; the loading indicator takes its place and appears
immediately rather than four seconds in. Give the catalog a mobile layout for the
case where it is genuinely needed.

### 2. Cover decoding comes off the critical path

`initialize()` awaits `Promise.all` over six 1024×1536 WebP covers — 2.7 MB of
blocking network and decode — before the renderer is built. Covers are lazily
printed now, so nothing in the first frame needs them. Moving the decode into the
dressing unit that actually uses it shortens the wait and drops the 37.7 MB of
decoded bitmaps the session was holding for the whole visit.

### 3. Volume information becomes a bottom sheet, collapsed by default

Collapsed: a handle and one line — `01 · Thus Spoke Zarathustra`. Tap or drag up
to expand.

Expanded, it shows what a phone cannot currently see: the deck unclamped, and the
binding, format, theme and motif restored.

Reuses the transform-and-`is-open` pattern of the existing `.index-panel` drawer
and the glass scrim already used by the reading-mode buttons
(`color-mix(in srgb, var(--paper-deep) 46%, transparent)` + `blur(8px)`). No new
visual language.

### 4. Camera controls get a touch-sized rail

| State | Bottom of screen |
|---|---|
| Book closed | `⊕ ⊖ ↺` left, `Open book` right, sheet handle below |
| Book open (reading) | existing `‹ 04/10 ›` page navigation; sheet collapsed and its handle hidden |

Every target at least 44px. Gestures are unchanged — pinch, drag and orbit all
still work. The buttons are the way out for someone who does not know the
gestures, not a replacement for them.

Closing the book from touch gets an answer: a `Close book` control at top left in
reading mode, mirroring the ✕ at top right, clear of the page.

### 5. The camera survives a resize, and controls clear the home indicator

- `resize()` resets the inspection view only when the size change is real, not
  when browser chrome collapses.
- `viewport-fit=cover` plus `env(safe-area-inset-*)` on the bottom controls.
  Neither exists in the file today.
- Bottom offsets move from `vh` to `dvh`, so they resolve against the visible
  viewport instead of sliding under browser chrome.

## What this does not do

- No change to the desktop layout. The sheet is a narrow-viewport treatment; the
  right-hand panel stays as it is.
- No new gesture vocabulary. Nothing is remapped, and the page-drag hit test that
  arbitrates page-turn versus camera is left alone.
- No redesign of the reading view beyond adding the missing close control.

## Notes for implementation

**The panel's CSS is layered, not cascaded.** `.detail-panel` is redefined seven
times at identical specificity — lines 652, 1031, 1120, 1285, 1387, 1633, 1838 —
and two of those (1285, 1633) sit *after* media queries as unconditional rules
that silently re-override them. 1633 sets `top`/`right`/`width` while leaving
`bottom`/`left` leaking from the 820px block. Editing one block without tracing
the rest produces no-ops. The sheet should collapse this pile rather than add an
eighth layer.

**The keyboard focus trap is a hard-coded array** at line 8382:
`[closeButton, toggleBookButton, previousPageButton, nextPageButton, resetButton]`.
Any new control that is not added there is unreachable by keyboard.

**`is-single-page` is measured, not a breakpoint** (`isSinglePageReading()`), and
`--reading-spread` publishes the book's on-screen width to CSS. Layout that needs
to know whether the book fits should read those rather than add a media query;
the comments in the file argue this explicitly.

**The panel is a real dialog** — `role="dialog" aria-modal="true"` with `inert`
and `aria-hidden` toggled in JS, and `#detail-title` is its accessible name. That
is why reading mode clips `.detail-editorial` to 1×1px instead of hiding it. A
sheet must keep the name reachable in both states.

## Verification

- Load trace at 390×844 with 4× CPU throttling: the static catalog must never be
  visible on a successful load, and a loading indicator must be on screen within
  the first second
- Time to `webgl-ready` before and after the cover-decode change
- Sheet: collapsed by default, expands on tap and on drag, shows binding specs
  and an unclamped deck when open, collapses when the book opens
- Every touch target in detail mode measured at ≥44px
- Reading mode: `Close book` reachable by touch; page navigation unchanged
- Zoom, then trigger a resize (URL bar collapse / rotation): the camera holds
- Bottom controls clear the home indicator on a notched viewport
- Keyboard: tab reaches every new control; `Esc` still closes the book
- Zero console errors and warnings
