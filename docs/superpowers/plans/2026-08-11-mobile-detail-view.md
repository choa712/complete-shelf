# Mobile Detail View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the phone experience hold together — stop the load flicker, give volume information a sheet that opens and closes, and give the camera touch-sized controls that survive a resize.

**Architecture:** Everything lands in the single `index.html`. A checked-in headless-Chrome harness (`scripts/mobile-check.mjs`) replaces the test framework this repo does not have: it drives the page over CDP at a phone viewport and asserts on measured facts — load timing, touch-target sizes, camera state across a resize. Each task ends by running it.

**Tech Stack:** Vanilla HTML/CSS/ES modules, Three.js 0.165 via importmap, Node 20 + `ws` (already a transitive dependency of wrangler) for the harness, headless Chrome over the DevTools Protocol.

**Spec:** `docs/superpowers/specs/2026-08-11-mobile-detail-view-design.md`

## Global Constraints

- The site stays **one self-contained `index.html`** with inline CSS and JS (`PROMPT.md:69`). Tooling may live in `scripts/`; the deliverable page may not gain external CSS or JS.
- Textures stay **procedural** (`PROMPT.md:50`). No new image assets.
- **Zero console errors or warnings** (`PROMPT.md:90`).
- `prefers-reduced-motion` is honoured — CSS kills durations at `index.html:1155`, and JS branches on `reducedMotion`.
- Desktop layout does not change. Every rule added here is inside a narrow-viewport media query or a new state class.
- Touch targets in detail mode: **≥44px** in both dimensions.
- The keyboard focus trap at `index.html:8382` is a hard-coded array. **Any new control must be added to it.**
- `.detail-panel` is redefined seven times at identical specificity (652, 1031, 1120, 1285, 1387, 1633, 1838). Source order decides. Do not add an eighth layer — collapse what you touch.
- Memory budget from the previous change must hold: mobile canvas RGBA **< 150 MB**, `renderer.info.programs` constant across selections.

---

### Task 1: Verification harness

The four tasks after this one are all "does the phone behave differently now", and none of them can be answered by reading the diff. This builds the instrument first.

**Files:**
- Create: `scripts/mobile-check.mjs`
- Modify: `package.json` (add a `check:mobile` script)

**Interfaces:**
- Produces: `node scripts/mobile-check.mjs [--url <url>] [--json]`, exiting non-zero on any failed assertion. Later tasks call it with no arguments (defaults to a local server on port 8910) and read the named checks below.
- Named checks it reports, each `{name, ok, detail}`: `load-no-fallback`, `load-indicator-early`, `touch-targets`, `camera-survives-resize`, `console-clean`, `memory-budget`.

- [ ] **Step 1: Write the harness**

Create `scripts/mobile-check.mjs`. It starts headless Chrome with a remote debugging port, opens one tab, applies `Emulation.setDeviceMetricsOverride` at 390×844 / DPR 3 / `mobile: true`, applies 4× CPU throttling so the load phase is observable, and drives the page.

The blocks below are the load-bearing parts. Around them, write the ordinary
scaffolding they refer to:

- `CHROME` — `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on
  darwin, `google-chrome` elsewhere; overridable with `CHROME_PATH`. Exit 1 with
  a clear message if it is not executable.
- `tmpdir` — from `node:os`.
- `waitForTab()` — `PUT http://127.0.0.1:${CDP_PORT}/json/new?about:blank` in a
  retry loop, 40 attempts, 250ms apart; throws if Chrome never answers.
- `main()` — serve, connect, `Runtime.enable` + `Page.enable`, apply the metrics
  override and `Emulation.setCPUThrottlingRate {rate: 4}`, run the checks in
  order, record `console-clean` from `problems`, record `memory-budget` from
  `renderer.info` if `window.__peek` exists (else skipped), print a table or
  `JSON.stringify(checks)` under `--json`, close everything, and
  `process.exit(checks.some((c) => c.ok === false) ? 1 : 0)`.

```js
#!/usr/bin/env node
// Measures the phone experience over CDP. This repo has no test framework and
// the things that break on a phone - a fallback that shows during a normal
// load, a control too small to hit, a camera thrown away by a URL bar - are all
// invisible in a diff and none of them fail a build.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import WebSocket from 'ws';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 8910;
const CDP_PORT = 9360;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.webp': 'image/webp',
                '.jpg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css' };

const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const asJson = args.includes('--json');
const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
```

Serve the repo root over `http` when no `--url` is given, so the harness has no
external dependency:

```js
async function serve() {
  const server = createServer(async (req, res) => {
    const path = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    try {
      const info = await stat(path);
      const file = info.isDirectory() ? join(path, 'index.html') : path;
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  return server;
}
```

Connect to Chrome and expose the two primitives every check needs:

```js
async function connect() {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(tmpdir(), 'shelf-mobile-check')}`, '--no-first-run', 'about:blank'],
    { stdio: 'ignore' });
  const tab = await waitForTab();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      problems.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await new Promise((r) => ws.on('open', r));
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { send, evaluate, problems, close: () => { ws.close(); chrome.kill(); } };
}
```

The load check samples during loading rather than after it — the flicker is only
visible while it is happening:

```js
// A fallback that is correct to show when WebGL is dead is wrong to show while
// WebGL is still starting. Sample the whole load, not the end of it.
async function checkLoad({ send, evaluate }, url) {
  const state = () => evaluate(`JSON.stringify({
    fallback: (() => { const f = document.querySelector(".static-fallback");
      return f ? getComputedStyle(f).display : "absent"; })(),
    loading: document.getElementById("loading")?.hidden ?? null,
    ready: document.getElementById("experience")?.classList.contains("webgl-ready") ?? false
  })`);
  send('Page.navigate', { url });
  let fallbackSeen = null;
  let indicatorBy = null;
  const started = Date.now();
  while (Date.now() - started < 30000) {
    await sleep(250);
    const at = Date.now() - started;
    const s = JSON.parse(await state());
    if (s.fallback === 'grid' && fallbackSeen === null) fallbackSeen = at;
    if (s.loading === false && indicatorBy === null) indicatorBy = at;
    if (s.ready) break;
  }
  record('load-no-fallback', fallbackSeen === null,
    fallbackSeen === null ? 'catalog never shown' : `catalog shown at t+${fallbackSeen}ms`);
  record('load-indicator-early', indicatorBy !== null && indicatorBy <= 1000,
    indicatorBy === null ? 'loading indicator never shown' : `loading indicator at t+${indicatorBy}ms`);
}
```

Touch targets are measured from the live layout, not asserted from CSS:

```js
async function checkTouchTargets({ evaluate }) {
  const small = await evaluate(`(() => {
    const ids = ["close-detail", "toggle-book", "reset-view", "previous-page", "next-page",
                 "zoom-in", "zoom-out", "reset-camera", "sheet-handle", "close-book"];
    return ids.flatMap((id) => {
      const el = document.getElementById(id);
      if (!el || el.offsetParent === null) return [];
      const b = el.getBoundingClientRect();
      return (b.width < 44 || b.height < 44)
        ? [id + " " + Math.round(b.width) + "x" + Math.round(b.height)] : [];
    });
  })()`);
  record('touch-targets', small.length === 0,
    small.length ? `below 44px: ${small.join(', ')}` : 'all visible targets >= 44px');
}
```

The camera check reproduces a URL-bar collapse — a height-only resize — and
asserts the camera did not move:

```js
// A mobile URL bar collapsing fires resize. If that throws the camera away, the
// zoom the reader just set is gone, which reads as "zoom does not work".
async function checkCameraAcrossResize({ send, evaluate }) {
  await evaluate('window.__select(4)'); await sleep(2500);
  await evaluate('window.__open()');   await sleep(4500);
  await evaluate('window.__zoomBy(-0.6)'); await sleep(1200);
  const before = await evaluate('JSON.stringify(window.__cameraState())');
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 760, deviceScaleFactor: 3, mobile: true });
  await sleep(1500);
  const after = await evaluate('JSON.stringify(window.__cameraState())');
  const a = JSON.parse(before); const b = JSON.parse(after);
  const moved = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  record('camera-survives-resize', moved < 0.02,
    `camera moved ${moved.toFixed(4)} world units on a height-only resize`);
}
```

`__zoomBy` and `__cameraState` are debug hooks added in Task 5. Guard the check
so it reports `skipped` rather than throwing if they are absent.

- [ ] **Step 2: Run it against the current build and watch it fail**

```bash
node scripts/mobile-check.mjs --json
```

Expected: `load-no-fallback` **FAIL** ("catalog shown at t+~300ms"),
`load-indicator-early` **FAIL** (indicator arrives after the module loads, ~3-4s),
`touch-targets` **FAIL** (`toggle-book` and `reset-view` at 32px),
`camera-survives-resize` **skipped** (hooks not present yet).

This failure list is the baseline. If any of these pass now, the harness is
measuring the wrong thing — fix the harness before going on.

- [ ] **Step 3: Wire the npm script**

```json
"scripts": {
  "deploy": "./deploy.sh",
  "deploy:dry-run": "./deploy.sh --dry-run",
  "check:mobile": "node scripts/mobile-check.mjs"
}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/mobile-check.mjs package.json
git commit -m "test(mobile): measure the phone experience over CDP"
```

---

### Task 2: Show the static catalog only when WebGL fails

**Files:**
- Modify: `index.html:816-833` (fallback CSS), `index.html:2202` (loading markup), `index.html:3217` (loading reveal), `index.html:8445-8449` (`showFallback`), `index.html:1136-1142` (narrow fallback layout)

**Interfaces:**
- Produces: an `experience.webgl-failed` state class. Task 3 and 4 must not assume `.static-fallback` is visible during load.

- [ ] **Step 1: Invert the default**

The catalog is a fallback, not a loading screen. Replace `index.html:830-832`:

```css
/* The catalog answers "this browser cannot run the shelf", which is not the
   same question as "the shelf is still starting". It waits to be asked. */
.static-fallback { display: none; }
.webgl-failed .static-fallback { display: grid; }
```

and delete the `display: grid` from the base rule at 816-828, keeping its
positioning and background.

- [ ] **Step 2: Show the loading indicator on the first paint**

Remove the `hidden` attribute at `index.html:2202`:

```html
<div class="loading" id="loading" aria-live="polite">
```

and delete `loading.hidden = false;` at `index.html:3217` — it lives in the
module, which cannot run until Three.js has come off the CDN, which is the whole
four-second gap.

- [ ] **Step 3: Set the state class where the failure is known**

`index.html:8445`:

```js
function showFallback(message) {
  loading.hidden = true;
  experience.classList.remove("webgl-ready");
  experience.classList.add("webgl-failed");
  fallbackStatus.textContent = message;
}
```

- [ ] **Step 4: Cover the two paths that never reach `showFallback`**

With JS off, or with the module blocked, nothing ever adds `webgl-failed` and the
reader is left on a loading indicator forever — worse than today. Add both
escapes immediately after the `<div class="loading">` block:

```html
<noscript>
  <style>
    #loading { display: none; }
    .static-fallback { display: grid; }
  </style>
</noscript>
<script>
  // The module may never arrive - a blocked CDN, a proxy that eats importmaps.
  // Nothing downstream can report that, because nothing downstream runs.
  window.setTimeout(() => {
    const experience = document.getElementById("experience");
    if (experience && !experience.classList.contains("webgl-ready")) {
      experience.classList.add("webgl-failed");
      document.getElementById("loading").hidden = true;
      document.getElementById("fallback-status").textContent =
        "The interactive shelf did not finish loading. The complete static catalog remains available.";
    }
  }, 25000);
</script>
```

25s is past the measured worst case (18s at 4× CPU throttling on a 1.6 Mbps
line) with room to spare, so a slow-but-working load is not interrupted.

- [ ] **Step 5: Give the catalog a phone layout**

`index.html:1136` only sets padding. The grid overflows horizontally at 390px —
the title clips and the cards run off the edge. Inside that same media query:

```css
.fallback__grid {
  grid-auto-flow: row;
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
  gap: 14px;
}
.fallback-book { --book-height: 132px; }
#fallback-title { font-size: clamp(1.6rem, 7vw, 2.4rem); }
```

- [ ] **Step 6: Verify**

```bash
node scripts/mobile-check.mjs --json
```

Expected: `load-no-fallback` **PASS**, `load-indicator-early` **PASS**
(indicator within 1s), `console-clean` **PASS**.

Then confirm the fallback still works when it *should*. Three paths, by hand,
once each at 390px wide:

1. **WebGL refused** — in devtools run
   `document.getElementById("experience").classList.add("webgl-failed")`. The
   catalog appears, reads correctly, and has no horizontal scroll.
2. **JS off** — reload with JavaScript disabled. The `<noscript>` block shows the
   catalog and hides the loading indicator.
3. **Module blocked** — in devtools, block `cdn.jsdelivr.net` under Network
   request blocking and reload. After 25s the timeout reveals the catalog with
   the "did not finish loading" status.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "fix(load): show the static catalog only when WebGL fails"
```

---

### Task 3: Take cover decoding off the critical path

**Files:**
- Modify: `index.html:8290-8299` (the `Promise.all` in `initialize`), the cover dressing unit added in the previous change (search `rig.dressing.cover = makeCoverTexture(book)`)

**Interfaces:**
- Produces: `async function coverImageFor(book)` returning a decoded `Image` or `null`. The cover dressing unit awaits it. `customCoverImages` stays the cache, but is filled on demand.

- [ ] **Step 1: Replace the eager decode with a cache-filling helper**

Delete the `await Promise.all(...)` block at `index.html:8290-8299` and add, near
`customCoverImages`:

```js
// Six covers at 1024x1536 are 37.7 MB of decoded bitmap and 2.7 MB of network.
// None of it is on screen until a volume is chosen, and waiting for it before
// the first frame is the longest single thing between a tap and a shelf.
async function coverImageFor(book) {
  if (!book.coverArt) return null;
  if (customCoverImages.has(book.id)) return customCoverImages.get(book.id);
  try {
    const artImage = new Image();
    artImage.decoding = "async";
    artImage.src = book.coverArt;
    await artImage.decode();
    customCoverImages.set(book.id, artImage);
    return artImage;
  } catch (error) {
    // Missing artwork falls back to the shared atlas.
    customCoverImages.set(book.id, null);
    return null;
  }
}
```

- [ ] **Step 2: Make the cover dressing unit await it**

The unit currently calls `makeCoverTexture(book)` synchronously. `makeCoverTexture`
reads `customCoverImages`, so the image has to be in the cache first:

```js
async () => {
  await coverImageFor(book);
  rig.dressing.cover = makeCoverTexture(book);
  rig.coverArt.map = rig.dressing.cover;
  rig.coverArt.color.setHex(0xffffff);
},
```

- [ ] **Step 3: Let the pump await a unit**

`pumpDressing` runs units synchronously. One unit is now async. Make the pump
`async`, `await` each unit, and re-check `suspended` after the await — a context
loss or a page unload can land inside that await:

```js
async function pumpDressing() {
  dressingTimer = 0;
  if (suspended) return;
  const started = performance.now();
  let printed = false;
  while (dressingQueue.size) {
    const [rig, units] = dressingQueue.entries().next().value;
    if (!units.length) { dressingQueue.delete(rig); continue; }
    await units.shift()();
    if (suspended) return;
    if (!rig.dressing) continue;   // evicted while we were awaiting
    printed = true;
    if (performance.now() - started >= 6) break;
  }
  if (printed) requestFrame();
  if (dressingQueue.size) dressingTimer = window.setTimeout(pumpDressing, 0);
}
```

The synchronous drain in `requestDressing({ immediate: true })` must also become
`await`-aware. `openDetail` is not async, so make the immediate path return a
promise the caller ignores, and keep the blank-paper placeholder as the visible
state until it settles — that is exactly what the placeholder is for.

- [ ] **Step 4: Verify**

```bash
node scripts/mobile-check.mjs --json
```

Expected: `load-no-fallback` and `load-indicator-early` still **PASS**, and the
reported time to `webgl-ready` is lower than the Task 2 run. Record both numbers
in the commit message.

Then confirm the covers still print: open a volume and screenshot it. The cover
art, foil frame and motif must all be there.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "perf(load): decode cover artwork when a volume is chosen"
```

---

### Task 4: Volume information becomes a bottom sheet

**Files:**
- Modify: `index.html:2113-2175` (panel markup), the seven `.detail-panel` blocks (652, 1031, 1120, 1285, 1387, 1633, 1838), `index.html:1405` (deck clamp), `index.html:1412` (`.meta-list` display), `index.html:8382` (focus trap), `openDetail`/`closeDetail`/`setReadingOpen`

**Interfaces:**
- Produces: `#sheet-handle` (a `<button>`), the `experience.sheet-open` state class, and `setSheetOpen(open)`. Task 5 positions its control rail relative to the collapsed handle.

- [ ] **Step 1: Add the handle to the markup**

Inside `<aside class="detail-panel">`, before `.detail-editorial`:

```html
<button class="sheet-handle" id="sheet-handle" type="button" aria-expanded="false"
        aria-controls="detail-editorial">
  <span class="sheet-handle__grip" aria-hidden="true"></span>
  <span class="sheet-handle__label" id="sheet-handle-label">01 · Thus Spoke Zarathustra</span>
  <svg class="sheet-handle__chevron" viewBox="0 0 16 16" aria-hidden="true">
    <path d="m3.5 10.5 4.5-4.5 4.5 4.5"></path>
  </svg>
</button>
```

The handle is the accessible toggle; `aria-expanded` carries the state.

- [ ] **Step 2: Collapse the CSS pile into one narrow-viewport block**

Delete the `.detail-panel` positioning declarations in the `@media` blocks at
1031, 1120, 1387 and 1838 — they contradict each other and only the last wins.
Keep the desktop rules (652, 1285, 1633) untouched. Add one block after 1838:

```css
@media (max-width: 880px) {
  /* A sheet, not a caption floating on the scene. The reader gets the book at
     full height and asks for the copy; today the copy takes the bottom 40% and
     is never asked for. */
  .detail-panel {
    top: auto; right: 0; bottom: 0; left: 0;
    width: auto; max-height: min(76dvh, 620px);
    padding: 0 18px calc(14px + env(safe-area-inset-bottom));
    display: flex; flex-direction: column;
    background: color-mix(in srgb, var(--paper-deep) 92%, transparent);
    border-top: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
    backdrop-filter: blur(14px);
    transform: translateY(calc(100% - var(--sheet-collapsed, 76px)));
    transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .mode-detail .detail-panel { transform: translateY(calc(100% - var(--sheet-collapsed, 76px))); }
  .mode-detail.sheet-open .detail-panel { transform: translateY(0); }

  .sheet-handle {
    display: flex; align-items: center; gap: 12px;
    width: 100%; min-height: 56px; padding: 0;
    background: none; border: 0; color: inherit; text-align: left;
  }
  .sheet-open .sheet-handle__chevron { transform: rotate(180deg); }

  .detail-editorial {
    flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
    opacity: 0; transition: opacity 0.2s var(--ease-out);
  }
  .sheet-open .detail-editorial { opacity: 1; }

  /* What the sheet is for. Both of these are switched off below 820px today,
     which leaves the panel occupying the screen to say almost nothing. */
  .sheet-open .detail-deck { display: block; -webkit-line-clamp: none; overflow: visible; }
  .sheet-open .meta-list { display: grid; }
}
```

Note `dvh` and `env(safe-area-inset-bottom)`, neither of which exists in the file
today.

- [ ] **Step 3: Drive it from JS**

Declare `let sheetOpen = false;` beside the other mode flags (`readingOpen`,
`bookPulled`), then:

```js
function setSheetOpen(open) {
  sheetOpen = open;
  experience.classList.toggle("sheet-open", open);
  sheetHandle.setAttribute("aria-expanded", String(open));
}
```

Wire: `sheetHandle.addEventListener("click", () => setSheetOpen(!sheetOpen))`;
`openDetail` sets `setSheetOpen(false)` and writes the handle label from the
volume (`${pad(index + 1)} · ${book.title}`); `setReadingOpen(true)` forces
`setSheetOpen(false)`. Add a drag: pointerdown on the handle, and a move of more
than 24px vertically sets the state by direction.

- [ ] **Step 4: Keep the sheet out of reading mode**

`index.html:1931` already flattens `.detail-panel` in reading mode. Add the
handle to what reading hides:

```css
.experience.is-reading .sheet-handle { display: none; }
```

- [ ] **Step 5: Add the handle to the focus trap**

`index.html:8382`:

```js
const focusables = [closeButton, sheetHandle, toggleBookButton, previousPageButton,
                    nextPageButton, resetButton].filter((element) => !element.disabled);
```

- [ ] **Step 6: Verify**

```bash
node scripts/mobile-check.mjs --json
```

Expected: `touch-targets` now includes `sheet-handle` at ≥44px and still passes.

Screenshot four states at 390×844 and read them: shelf, detail collapsed
(book unobstructed, one line of copy at the bottom), detail expanded (deck in
full, binding/format/theme/motif present), reading (no handle, page controls
only).

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat(detail): collapse volume information into a sheet on phones"
```

---

### Task 5: Camera controls, and a camera that survives a resize

**Files:**
- Modify: `index.html` detail markup (new rail), narrow-viewport CSS, `resize()` (`index.html:8321-8354`), `index.html:5` (viewport meta), `index.html:8382` (focus trap)

**Interfaces:**
- Consumes: `#sheet-handle` and `.sheet-open` from Task 4 — the rail sits above the collapsed handle.
- Produces: `window.__zoomBy(delta)` and `window.__cameraState()` debug hooks that Task 1's `camera-survives-resize` check calls.

- [ ] **Step 1: Add the control rail**

Inside `.detail-panel`, before the sheet handle:

```html
<div class="camera-rail" id="camera-rail" role="group" aria-label="Adjust the view">
  <button class="page-button" id="zoom-in" type="button" aria-label="Zoom in">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"></path></svg>
  </button>
  <button class="page-button" id="zoom-out" type="button" aria-label="Zoom out">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9"></path></svg>
  </button>
  <button class="page-button" id="reset-camera" type="button" aria-label="Reset the view">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7M12 2v3H9"></path></svg>
  </button>
</div>
```

Reuse `.page-button` — it is the only control in the file with complete
disabled/hover/`:focus-visible` states, and it is already 40×40.

```css
@media (max-width: 880px) {
  .camera-rail { display: flex; gap: 12px; padding: 10px 0 4px; }
  .camera-rail .page-button { width: 44px; height: 44px; }
  .is-reading .camera-rail { display: none; }
}
```

- [ ] **Step 2: Give the buttons a camera to move**

```js
// The book is drawn at 94% of the viewport width, so there is almost no
// background left to start a one-finger orbit on. These are the way in for
// someone who has not discovered the pinch.
function zoomBy(delta) {
  if (mode !== "detail" || !controls) return;
  const toCamera = camera.position.clone().sub(controls.target);
  const distance = clamp(toCamera.length() * (1 + delta), controls.minDistance, controls.maxDistance);
  camera.position.copy(controls.target).add(toCamera.setLength(distance));
  controls.update();
  requestFrame();
}
zoomInButton.addEventListener("click", () => zoomBy(-0.18));
zoomOutButton.addEventListener("click", () => zoomBy(0.22));
resetCameraButton.addEventListener("click", resetInspectionView);
window.__zoomBy = zoomBy;
window.__cameraState = () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z });
```

Zoom-out is the larger step because `1/(1-0.18) ≈ 1.22` — equal-looking numbers
would make the pair asymmetric.

- [ ] **Step 3: Give reading mode a way to close the book**

`.detail-controls` is `display: none` while reading, which takes `Close book`
with it and leaves `Esc` — which a phone does not have. Mirror the ✕:

```html
<button class="round-button close-book" id="close-book" type="button" hidden>Close book</button>
```

```css
.experience.is-reading .close-book {
  display: grid; position: absolute; z-index: 12;
  top: clamp(16px, 2.4vw, 30px); left: clamp(16px, 2.4vw, 30px);
  min-width: 44px; min-height: 44px;
  background: color-mix(in srgb, var(--paper-deep) 46%, transparent);
  backdrop-filter: blur(8px); pointer-events: auto;
}
```

Toggle `hidden` alongside `is-reading` in `setReadingOpen`, and wire it to
`setReadingOpen(false)`.

- [ ] **Step 4: Stop throwing the camera away on a height-only resize**

`index.html:8352` calls `resetInspectionView()` on every resize. A mobile URL bar
collapsing is a resize. Track the last width and reset only when it changed:

```js
let lastResizeWidth = window.innerWidth;

function resize() {
  const widthChanged = window.innerWidth !== lastResizeWidth;
  lastResizeWidth = window.innerWidth;
  /* ... unchanged through applyDetailViewOffset() and updatePageControls(false) ... */
  } else if (mode === "detail" && activeBook) {
    /* ... */
    updatePageControls(false);
    // Browser chrome sliding away is not a new layout. Reframing on it discards
    // whatever the reader had just zoomed to.
    if (widthChanged) resetInspectionView();
  }
```

- [ ] **Step 5: Let the page use the whole screen safely**

`index.html:5`:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

Then add `env(safe-area-inset-bottom)` to the reading-mode bottom offsets at
`index.html:2011` and `2039`, and swap their `vh` for `dvh`:

```css
.experience.is-reading .page-status { bottom: calc(clamp(18px, 4.4dvh, 40px) + env(safe-area-inset-bottom)); }
.experience.is-reading.is-single-page .page-navigation { bottom: calc(clamp(14px, 3.4dvh, 34px) + env(safe-area-inset-bottom)); }
```

Without `viewport-fit=cover` the insets are always zero, so both halves are
needed or neither does anything.

- [ ] **Step 6: Add the new controls to the focus trap**

```js
const focusables = [closeButton, closeBookButton, sheetHandle, zoomInButton, zoomOutButton,
                    resetCameraButton, toggleBookButton, previousPageButton, nextPageButton,
                    resetButton].filter((element) => element && !element.hidden && !element.disabled);
```

- [ ] **Step 7: Verify**

```bash
node scripts/mobile-check.mjs --json
```

Expected: all six checks **PASS**, including `camera-survives-resize` (previously
skipped) and `touch-targets` covering the three new buttons.

Then by hand at 390×844: zoom in with the button, confirm the book grows; trigger
a height-only resize and confirm the zoom holds; open the book and confirm
`Close book` is reachable by touch at top left.

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "feat(detail): touch-sized camera controls that survive a resize"
```

---

## Final check before the PR

- [ ] `node scripts/mobile-check.mjs --json` — six checks, all pass
- [ ] Memory has not regressed: mobile canvas RGBA < 150 MB, `renderer.info.programs` constant across 26 selections
- [ ] `PROMPT.md` verification list items touched by this change: spread counts follow content, dragged pages do not spring back, shelf ↔ detail round trip from both closed and open, zero console errors and warnings
- [ ] Desktop at 1440×900 is visually unchanged from `main`
