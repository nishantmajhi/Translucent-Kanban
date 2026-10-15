#!/usr/bin/env node
"use strict";

/**
 * Drive the real board in real headless Chrome.
 *
 * tests/*.test.js check the board rules and the page's structure under Node.
 * None of that shows that the page actually renders three columns, that a card
 * dragged with the mouse lands in the column it was dropped on, or that what
 * goes to Drive is what is on screen. This does: it serves the project over
 * loopback, loads index.html in Chrome, sets a PIN, and uses the board the way
 * a person would, through the Chrome DevTools Protocol.
 *
 * Google is stubbed. A script injected ahead of everything else seeds a
 * signed-in session and answers the Drive upload calls itself, recording what
 * would have been written. The real client_config.json is never read or
 * served. React and Babel still come from unpkg, as in production, so this
 * needs the network.
 *
 * No dependencies: Node's own http server and WebSocket, and the installed
 * Chrome.
 *
 *   node tests/browser/run.js               run the checks
 *   node tests/browser/run.js --shots DIR   also save desktop and phone screenshots
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
const PIN = "135790";

const CHROME_CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA &&
    path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

/* Runs before any other script on the page. */
const STUB = `<script>
(function () {
  localStorage.setItem("crys_auth", JSON.stringify({
    token: "test-token",
    expiresAt: Date.now() + 3600000,
    user: { name: "Test Lead", email: "lead@example.test" },
  }));
  window.__writes = [];
  var realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    url = String(url);
    opts = opts || {};
    if (url.indexOf("https://www.googleapis.com/upload/drive/v3/files") === 0) {
      var body = JSON.parse(await opts.body.get("file").text());
      window.__writes.push({ method: opts.method, body: body });
      return new Response(JSON.stringify({ id: "file-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.indexOf("https://www.googleapis.com/") === 0) {
      return new Response("{}", { status: 404 });
    }
    return realFetch(url, opts);
  };
})();
</script>`;

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/client_config.json") {
      res.writeHead(200, { "content-type": TYPES[".json"] });
      return res.end(JSON.stringify({ web: { client_id: "test-client" } }));
    }
    const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    let body = fs.readFileSync(file);
    if (rel === "index.html") {
      body = body.toString("utf8").replace("<head>", "<head>" + STUB);
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

/* ── A minimal CDP client ─────────────────────────────────────── */

function launchChrome(profile) {
  const exe = CHROME_CANDIDATES.find((c) => {
    try {
      return fs.existsSync(c);
    } catch {
      return false;
    }
  });
  if (!exe) throw new Error("Chrome not found; set CHROME to its path");

  const proc = spawn(exe, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,800",
    "about:blank",
  ]);
  const ws = new Promise((resolve, reject) => {
    let err = "";
    proc.stderr.on("data", (d) => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    proc.on("exit", () => reject(new Error("Chrome exited:\n" + err)));
  });
  return { proc, ws };
}

async function connect(browserWs) {
  const port = new URL(browserWs).port;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    sock.onopen = r;
    sock.onerror = j;
  });

  let id = 0;
  const pending = new Map();
  const listeners = [];
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      sock.send(JSON.stringify({ id: n, method, params }));
    });
  const on = (fn) => listeners.push(fn);
  const once = (method, ms = 5000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), ms);
      listeners.push((m) => {
        if (m.method === method) {
          clearTimeout(t);
          resolve(m.params);
        }
      });
    });

  return { send, on, once, close: () => sock.close() };
}

/* ── Driving the page ─────────────────────────────────────────── */

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tk-chrome-"));
  const chrome = launchChrome(profile);
  const cdp = await connect(await chrome.ws);

  const errors = [];
  cdp.on((m) => {
    if (m.method === "Runtime.exceptionThrown") {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  });

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const evaluate = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };
  const waitFor = async (cond, what, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(`return !!(${cond});`)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const key = async (k, code, vk, text) => {
    await cdp.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, text,
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
  };
  const enter = () => key("Enter", "Enter", 13, "\r");
  const escape = () => key("Escape", "Escape", 27);
  const type = (text) => cdp.send("Input.insertText", { text });

  /* Each column as { label, cards: [{ text, who, prio }] }, left to right. */
  const board = () =>
    evaluate(`return [...document.querySelectorAll(".board .col")].map((c) => ({
      label: c.querySelector(".colhead").textContent.replace(/\\d+$/, ""),
      count: Number(c.querySelector(".colcount").textContent),
      empty: c.querySelector(".colempty")?.textContent || null,
      cards: [...c.querySelectorAll(".task")].map((t) => ({
        text: t.querySelector(".ttext").textContent,
        who: t.querySelector(".atag")?.textContent,
        prio: t.querySelector(".ptag")?.textContent || "",
      })),
    }));`);
  const texts = (b) => b.map((c) => c.cards.map((x) => x.text));
  const cardSel = (text) =>
    `[...document.querySelectorAll(".task")].find((t) => t.querySelector(".ttext").textContent === ${JSON.stringify(text)})`;

  const center = (sel) =>
    evaluate(`const r = (${sel}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 40) };`);

  /* A real mouse drag: Chrome starts the drag from the draggable element, and
     the intercepted drag data is dropped on the target the way a drop is. */
  async function mouseDrag(fromSel, toSel) {
    const a = await center(fromSel);
    const b = await center(toSel);
    await cdp.send("Input.setInterceptDrags", { enabled: true });
    const intercepted = cdp.once("Input.dragIntercepted");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 5; i++) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", button: "left", buttons: 1,
        x: a.x + ((b.x - a.x) * i) / 5, y: a.y + ((b.y - a.y) * i) / 5,
      });
    }
    const { data } = await intercepted;
    for (const t of ["dragEnter", "dragOver", "drop"]) {
      await cdp.send("Input.dispatchDragEvent", { type: t, x: b.x, y: b.y, data });
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 });
    await cdp.send("Input.setInterceptDrags", { enabled: false });
    await sleep(150);
  }

  async function addTask(text, who, prio) {
    await evaluate(`document.querySelector(".addin").focus();`);
    await type(text);
    await waitFor(`document.querySelector(".addwho")`, "the assign box");
    if (prio) await evaluate(`[...document.querySelectorAll(".pbtn")].find((b) => b.textContent === "${prio}").click();`);
    await evaluate(`document.querySelector(".addwho").focus();`);
    if (who) await type(who);
    await enter();
    await sleep(100);
  }

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `${base}/index.html` });

    /* Set the PIN twice. */
    await waitFor(`document.querySelector(".numpad")`, "the PIN screen");
    for (const d of PIN) await key(d, `Digit${d}`, d.charCodeAt(0), d);
    await waitFor(`/Confirm PIN/.test(document.body.textContent)`, "the confirm screen", 5000);
    await sleep(200);
    for (const d of PIN) await key(d, `Digit${d}`, d.charCodeAt(0), d);
    await waitFor(`document.querySelector(".board")`, "the board");

    let b = await board();
    check("three columns, in order", b.map((c) => c.label).join(",") === "Assigned,Completed,Submitted", b.map((c) => c.label));
    check("an empty board says where to start", b[0].empty === "Add a task below to start", b[0].empty);
    check("the header says Kanban", await evaluate(`return document.querySelector(".logo").textContent.trim();`) === "Translucent Kanban");
    check("no list-era filter tabs", !(await evaluate(`return [...document.querySelectorAll(".ftab")].some((t) => /^(all|active|done)$/i.test(t.textContent));`)));

    /* Add three tasks. New tasks start in Assigned. */
    await addTask("Write report", "Asha", "high");
    await addTask("Fix login", "Ravi", "");
    await addTask("Call vendor", "", "low");
    b = await board();
    check("new tasks land in Assigned, sorted by priority", JSON.stringify(texts(b)) === JSON.stringify([["Write report", "Call vendor", "Fix login"], [], []]), texts(b));
    check("each card shows its assignee", b[0].cards.map((c) => c.who).join(",") === "Asha,Unassigned,Ravi", b[0].cards.map((c) => c.who));
    check("and its priority", b[0].cards.map((c) => c.prio).join(",") === "high,low,", b[0].cards.map((c) => c.prio));
    check("column counts", b.map((c) => c.count).join(",") === "3,0,0", b.map((c) => c.count));

    /* Move with the buttons. */
    await evaluate(`(${cardSel("Fix login")}).querySelector('[title="Move to Completed"]').click();`);
    await sleep(100);
    b = await board();
    check("→ moves a card to the next column", texts(b)[1].includes("Fix login") && !texts(b)[0].includes("Fix login"), texts(b));
    check("Assigned has no ← button", !(await evaluate(`return !!(${cardSel("Call vendor")}).querySelector('[title^="Move to"][title$="Assigned"]');`)));

    /* Move with a real mouse drag, straight to Submitted. */
    await mouseDrag(cardSel("Write report"), `document.querySelectorAll(".board .col")[2]`);
    b = await board();
    check("dragging a card onto a column moves it there", JSON.stringify(texts(b)) === JSON.stringify([["Call vendor"], ["Fix login"], ["Write report"]]), texts(b));
    check("the drop highlight clears after the drop", !(await evaluate(`return !!document.querySelector(".col.over");`)));
    check("a card in Submitted has ← but no →", await evaluate(`const c = ${cardSel("Write report")};
      return !!c.querySelector('[title="Move to Completed"]') && !c.querySelector('[title^="Move to"][title$="Submitted"]');`));

    /* Dropping a card on its own column changes nothing and saves nothing. */
    await sleep(1900);
    const writesBefore = await evaluate(`return window.__writes.length;`);
    await mouseDrag(cardSel("Fix login"), `document.querySelectorAll(".board .col")[1]`);
    await sleep(1900);
    check("dropping a card back on its own column does not save", (await evaluate(`return window.__writes.length;`)) === writesBefore);

    /* Assign someone to an unassigned card, in different case. */
    await evaluate(`(${cardSel("Call vendor")}).querySelector(".atag").click();`);
    await waitFor(`document.querySelector(".task .aedit")`, "the assignee box");
    await type("asha");
    await enter();
    await sleep(100);
    b = await board();
    check("clicking the chip assigns the card", b[0].cards[0].who === "asha", b[0].cards[0].who);

    /* Escape discards an assignee edit. */
    await evaluate(`(${cardSel("Fix login")}).querySelector(".atag").click();`);
    await waitFor(`document.querySelector(".task .aedit")`, "the assignee box");
    await type("Zed");
    await escape();
    await sleep(100);
    b = await board();
    check("Escape leaves the assignee as it was", b[1].cards[0].who === "Ravi", b[1].cards[0].who);

    /* Person filter. */
    const chips = await evaluate(`return [...document.querySelectorAll(".ftab:not(.del)")].map((t) => t.textContent);`);
    check("one filter chip per person, ignoring case", chips.join(",") === "Everyone,Asha,Ravi", chips);
    await evaluate(`[...document.querySelectorAll(".ftab")].find((t) => t.textContent === "Asha").click();`);
    await sleep(100);
    b = await board();
    check("filtering by a person shows only their cards", JSON.stringify(texts(b)) === JSON.stringify([["Call vendor"], [], ["Write report"]]), texts(b));
    check("an emptied column says why", b[1].empty === "No matching tasks", b[1].empty);
    await evaluate(`[...document.querySelectorAll(".ftab")].find((t) => t.textContent === "Everyone").click();`);

    /* Search covers text and assignee. */
    await evaluate(`document.querySelector(".hsinput").focus();`);
    await type("ravi");
    await sleep(100);
    b = await board();
    check("search matches the assignee", JSON.stringify(texts(b)) === JSON.stringify([[], ["Fix login"], []]), texts(b));
    await evaluate(`document.querySelector(".hsclear").click();`);
    await sleep(100);

    /* Progress is submitted over total. */
    const stat = await evaluate(`return document.querySelector(".statsbar .stat").textContent;`);
    check("progress counts submitted tasks", stat === "1/3 submitted", stat);

    /* What reached Drive matches the board. */
    await sleep(1900);
    const saved = await evaluate(`const w = window.__writes[window.__writes.length - 1].body;
      const { key } = await Crypt.derive(${JSON.stringify(PIN)}, w.salt);
      const d = await Crypt.dec({ iv: w.iv, ct: w.ct }, key);
      return d.tasks.map((t) => [t.text, t.status, t.assignee, t.priority].join("|")).sort();`);
    check("the saved, encrypted tasks match the board", JSON.stringify(saved) === JSON.stringify([
      "Call vendor|assigned|asha|low",
      "Fix login|completed|Ravi|",
      "Write report|submitted|Asha|high",
    ]), saved);
    check("the saved tasks carry no done flag", !(await evaluate(`const w = window.__writes[window.__writes.length - 1].body;
      const { key } = await Crypt.derive(${JSON.stringify(PIN)}, w.salt);
      const d = await Crypt.dec({ iv: w.iv, ct: w.ct }, key);
      return d.tasks.some((t) => "done" in t) || "todos" in d;`)));

    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOTS, "desktop.png"), Buffer.from(shot.data, "base64"));
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
      await sleep(300);
      const light = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOTS, "desktop-light.png"), Buffer.from(light.data, "base64"));
      await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    }

    /* Phone width: one column under another, no sideways scroll, and the
       move buttons visible, because a touch screen has no hover to show them. */
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await sleep(300);
    const layout = await evaluate(`const cols = [...document.querySelectorAll(".board .col")].map((c) => c.getBoundingClientRect());
      return {
        stacked: cols[1].top >= cols[0].bottom && cols[2].top >= cols[1].bottom,
        sameLeft: cols.every((r) => Math.abs(r.left - cols[0].left) < 1),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        buttonsShown: getComputedStyle(document.querySelector(".tactions")).opacity,
      };`);
    check("on a phone the columns stack", layout.stacked && layout.sameLeft, layout);
    check("on a phone nothing scrolls sideways", layout.overflow <= 0, layout.overflow);
    check("on a touch screen the move buttons are always shown", layout.buttonsShown === "1", layout.buttonsShown);
    if (SHOTS) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOTS, "phone.png"), Buffer.from(shot.data, "base64"));
    }
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    /* Clearing submitted asks first. */
    await evaluate(`[...document.querySelectorAll(".ftab.del")].find((t) => t.textContent === "Clear submitted").click();`);
    await sleep(150);
    const dialog = await evaluate(`return document.body.textContent.includes("This permanently removes 1 submitted task.");`);
    check("Clear submitted asks for confirmation", dialog);
    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Clear").click();`);
    await sleep(150);
    b = await board();
    check("and then removes only the submitted cards", JSON.stringify(texts(b)) === JSON.stringify([["Call vendor"], ["Fix login"], []]), texts(b));

    check("no uncaught errors on the page", errors.length === 0, errors);
  } catch (e) {
    check("the run completed", false, e.message);
  } finally {
    cdp.close();
    chrome.proc.kill();
    server.close();
    await sleep(300);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Chrome may still hold a file for a moment; the OS temp dir clears it */
    }
  }

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    const detail = r.ok || r.detail === undefined ? "" : `  -> ${JSON.stringify(r.detail)}`;
    console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${detail}`);
  }
  console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
