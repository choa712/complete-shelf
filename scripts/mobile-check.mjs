#!/usr/bin/env node
// Measures the phone experience over the DevTools Protocol.
//
// This repo has no test framework, and the things that break on a phone are all
// invisible in a diff: a fallback catalog that shows during a normal load, a
// control too small to hit, a camera thrown away by a URL bar sliding up. None
// of them fail a build. So they get measured instead.
//
//   node scripts/mobile-check.mjs            local server, table output
//   node scripts/mobile-check.mjs --json     machine-readable
//   node scripts/mobile-check.mjs --url URL  measure a deployed build
//
// Exits non-zero if any check fails.
// Uses the WebSocket built into Node rather than the `ws` package, which is
// only present here as a transitive dependency of wrangler and would take this
// script with it the day that changes. That global landed in Node 21, so say so
// here instead of failing with a bare ReferenceError forty lines in.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 8910;
const CDP_PORT = 9360;
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml"
};
const CHROME = process.env.CHROME_PATH || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "google-chrome");

if (typeof WebSocket !== "function") {
  console.error(`Node ${process.versions.node} has no global WebSocket; this needs Node 21 or newer.`);
  process.exit(1);
}

const args = process.argv.slice(2);
const urlArg = args.includes("--url") ? args[args.indexOf("--url") + 1] : null;
const asJson = args.includes("--json");

const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok, detail });
const skip = (name, detail) => checks.push({ name, ok: null, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serve() {
  const server = createServer(async (req, res) => {
    const requested = resolve(ROOT, `.${decodeURIComponent(req.url.split("?")[0])}`);
    // join() happily normalises ../.. straight out of the repo, and this server
    // runs on a predictable localhost port while a browser is pointed at it.
    if (requested !== ROOT && !requested.startsWith(`${ROOT}/`)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const info = await stat(requested);
      const file = info.isDirectory() ? join(requested, "index.html") : requested;
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  return server;
}

async function waitForTab() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
      if (r.ok) return r.json();
    } catch { /* chrome is still coming up */ }
    await sleep(250);
  }
  throw new Error("Chrome never answered on the debugging port");
}

async function connect() {
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${join(tmpdir(), "shelf-mobile-check")}`,
    "--no-first-run", "about:blank"
  ], { stdio: "ignore" });
  chrome.on("error", (error) => {
    console.error(`Could not start Chrome at ${CHROME}: ${error.message}`);
    console.error("Set CHROME_PATH to override.");
    process.exit(1);
  });

  const tab = await waitForTab();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener("message", (event) => {
    const m = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") {
      problems.push(m.params.exceptionDetails.exception?.description
        || m.params.exceptionDetails.text);
    }
    if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
      problems.push(`${m.params.type}: ${m.params.args
        .map((a) => a.value ?? a.description).join(" ")}`);
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { send, evaluate, problems, close: () => { ws.close(); chrome.kill(); } };
}

// A fallback that is right to show when WebGL is dead is wrong to show while
// WebGL is still starting. Sample the whole load, not the end of it.
async function checkLoad({ send, evaluate }, url) {
  const readState = () => evaluate(`JSON.stringify({
    fallback: (() => { const f = document.querySelector(".static-fallback");
      return f ? getComputedStyle(f).display : "absent"; })(),
    loading: document.getElementById("loading")?.hidden ?? null,
    ready: document.getElementById("experience")?.classList.contains("webgl-ready") ?? false
  })`);

  send("Page.navigate", { url });
  let fallbackSeenAt = null;
  let indicatorAt = null;
  let readyAt = null;
  const started = Date.now();
  while (Date.now() - started < 40000) {
    await sleep(200);
    const at = Date.now() - started;
    let state;
    try { state = JSON.parse(await readState()); } catch { continue; }
    if (state.fallback === "grid" && fallbackSeenAt === null) fallbackSeenAt = at;
    if (state.loading === false && indicatorAt === null) indicatorAt = at;
    if (state.ready) { readyAt = at; break; }
  }

  record("load-no-fallback", fallbackSeenAt === null,
    fallbackSeenAt === null ? "catalog never shown" : `catalog shown from t+${fallbackSeenAt}ms`);
  record("load-indicator-early", indicatorAt !== null && indicatorAt <= 1000,
    indicatorAt === null ? "loading indicator never shown" : `loading indicator at t+${indicatorAt}ms`);
  return readyAt;
}

// Measured where they are actually used. On the shelf the detail controls are
// laid out but transparent, which is not the state anyone taps them in.
async function enterDetail({ evaluate }) {
  await evaluate('document.getElementById("inspect")?.click()');
  await sleep(4500);
  return evaluate('document.getElementById("experience")?.classList.contains("mode-detail") ?? false');
}

const MEASURE_TARGETS = `(() => {
  const ids = ["close-detail", "toggle-book", "reset-view", "previous-page", "next-page",
               "zoom-in", "zoom-out", "reset-camera", "sheet-handle", "close-book"];
  return ids.flatMap((id) => {
    const el = document.getElementById(id);
    if (!el || el.hidden || el.offsetParent === null) return [];
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return [];
    return (box.width < 44 || box.height < 44)
      ? [id + " " + Math.round(box.width) + "x" + Math.round(box.height)] : [];
  });
})()`;

// Both states, because they show different controls. Close book and the page
// arrows only exist once the covers are open, so measuring the closed book
// alone reports a clean pass over controls it never looked at.
async function checkTouchTargets({ evaluate }) {
  const closed = await evaluate(MEASURE_TARGETS);
  await evaluate('document.getElementById("toggle-book")?.click()');
  await sleep(4000);
  const reading = await evaluate('document.getElementById("experience")?.classList.contains("is-reading") ?? false');
  const open = reading ? await evaluate(MEASURE_TARGETS) : ["(could not open the book to measure)"];
  await evaluate('document.getElementById("close-book")?.click()');
  await sleep(2500);

  const small = [...new Set([...closed, ...open])];
  record("touch-targets", small.length === 0,
    small.length
      ? `below 44px: ${small.join(", ")}`
      : "every visible target >= 44px, covers closed and open");
}

// A mobile URL bar collapsing fires resize. If that throws the camera away, the
// zoom the reader just set is gone - which is experienced as "zoom is broken".
async function checkCameraAcrossResize({ send, evaluate }) {
  const hooked = await evaluate('typeof window.__cameraState === "function"');
  if (!hooked) {
    skip("camera-survives-resize", "the page exposes no camera state to read");
    return;
  }
  // Driven through the real control, not a back door, so the check covers the
  // button as well as the resize.
  for (let i = 0; i < 3; i += 1) {
    await evaluate('document.getElementById("zoom-in")?.click()');
    await sleep(400);
  }
  await sleep(900);
  const before = JSON.parse(await evaluate("JSON.stringify(window.__cameraState())"));
  // Height only: exactly what browser chrome sliding away looks like.
  await send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, height: 760 });
  await sleep(1500);
  const after = JSON.parse(await evaluate("JSON.stringify(window.__cameraState())"));
  await send("Emulation.setDeviceMetricsOverride", VIEWPORT);
  const moved = Math.hypot(before.x - after.x, before.y - after.y, before.z - after.z);
  record("camera-survives-resize", moved < 0.02,
    `camera moved ${moved.toFixed(4)} world units on a height-only resize`);
}

// The shelf builds its volumes out of canvases, and building all of them at
// once is what used to kill the tab. Two things have to stay true: the resident
// canvas bytes stay under budget, and swapping a volume's dressing swaps a
// texture rather than changing a material's shape - a changed shape recompiles
// every material on the book, which shows up as the program count climbing.
const MEMORY_BUDGET_MB = 150;

async function checkMemory({ evaluate }) {
  const census = await evaluate('typeof window.__canvasCensus === "function"');
  const info = await evaluate('typeof window.__rendererInfo === "function"');
  if (!census || !info) {
    record("memory-budget", false,
      "the page exposes no renderer info, or the census was not installed");
    return;
  }

  // navigate() returns immediately unless the shelf is the active mode, so the
  // walk has to start from the shelf or it silently does nothing and the check
  // passes on a build that never cycled a volume.
  await evaluate('document.getElementById("close-detail")?.click()');
  await sleep(3500);
  const onShelf = await evaluate('!document.getElementById("experience").classList.contains("mode-detail")');
  if (!onShelf) {
    record("memory-budget", false, "could not return to the shelf to walk the volumes");
    return;
  }

  const before = JSON.parse(await evaluate("JSON.stringify(window.__rendererInfo())"));
  const startedAt = await evaluate('document.getElementById("counter")?.textContent');

  // Proven on the first step rather than the last: a full lap of 26 lands back
  // on the volume it started from, so comparing the ends cannot tell a walk
  // from a stall.
  await evaluate('document.getElementById("next")?.click()');
  await sleep(600);
  const afterOne = await evaluate('document.getElementById("counter")?.textContent');
  if (startedAt === afterOne) {
    record("memory-budget", false, `the walk never moved: counter stayed at ${startedAt}`);
    return;
  }

  // The rest of the lap, so every volume has been dressed at least once.
  for (let i = 1; i < 26; i += 1) {
    await evaluate('document.getElementById("next")?.click()');
    await sleep(320);
  }
  await sleep(4000);
  const after = JSON.parse(await evaluate("JSON.stringify(window.__rendererInfo())"));
  const resident = JSON.parse(await evaluate("JSON.stringify(window.__canvasCensus())"));

  const problems = [];
  if (resident.rgbaMB > MEMORY_BUDGET_MB) {
    problems.push(`${resident.rgbaMB} MB resident, over ${MEMORY_BUDGET_MB}`);
  }
  if (after.programs !== before.programs) {
    problems.push(`programs ${before.programs} -> ${after.programs}`);
  }
  record("memory-budget", problems.length === 0,
    problems.length
      ? problems.join("; ")
      : `${resident.rgbaMB} MB across ${resident.live} canvases, programs steady at ${after.programs}`);
}

async function main() {
  const server = urlArg ? null : await serve();
  const url = urlArg || `http://127.0.0.1:${PORT}/index.html`;
  const session = await connect();
  try {
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    await session.send("Network.enable");
    // Installed before any page script runs, so it sees every canvas the shelf
    // makes. WeakRef, or the census itself would keep the released ones alive
    // and report the total ever made instead of the total resident.
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const create = document.createElement.bind(document);
        const seen = [];
        document.createElement = function (tag) {
          const el = create(tag);
          if (String(tag).toLowerCase() === "canvas") seen.push(new WeakRef(el));
          return el;
        };
        window.__canvasCensus = () => {
          let px = 0;
          let live = 0;
          for (const ref of seen) {
            const canvas = ref.deref();
            if (!canvas) continue;
            live += 1;
            px += canvas.width * canvas.height;
          }
          return { made: seen.length, live, rgbaMB: +(px * 4 / 1048576).toFixed(1) };
        };
      })();`
    });
    await session.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
    // Throttled, or the load phase is over before it can be sampled. The
    // network matters as much as the CPU here: the loading indicator is only
    // late because the code that reveals it is inside the module, and on a fast
    // line the module arrives before anyone could notice.
    await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await session.send("Network.emulateNetworkConditions", {
      offline: false, latency: 150,
      downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8
    });

    const readyAt = await checkLoad(session, url);
    if (readyAt === null) {
      record("console-clean", false, "the shelf never became ready");
    } else {
      const inDetail = await enterDetail(session);
      if (!inDetail) record("enter-detail", false, "could not open a volume from the shelf");
      await checkTouchTargets(session);
      await checkCameraAcrossResize(session);
      await checkMemory(session);
      record("console-clean", session.problems.length === 0,
        session.problems.length ? session.problems.slice(0, 5).join(" | ") : "no errors or warnings");
    }
    if (readyAt !== null) skip("time-to-ready", `${readyAt}ms at 4x CPU throttling`);
  } finally {
    session.close();
    server?.close();
  }

  if (asJson) {
    console.log(JSON.stringify(checks, null, 2));
  } else {
    for (const check of checks) {
      const mark = check.ok === null ? "····" : check.ok ? "PASS" : "FAIL";
      console.log(`${mark}  ${check.name.padEnd(24)} ${check.detail}`);
    }
  }
  process.exit(checks.some((check) => check.ok === false) ? 1 : 0);
}

main();
