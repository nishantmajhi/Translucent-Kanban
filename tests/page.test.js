/* Structural checks on index.html and sw.js.
 *
 * node --test tests/page.test.js
 *
 * The application is one 3,000-line HTML file with no build step, so there is
 * nothing between a mistake here and a blank page in front of a user. These
 * are not tests of behaviour — they are the handful of invariants that, if
 * broken, break the whole thing silently.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");

/* ── The crypto engine is reachable ─────────────────────────── */

test("index.html loads the crypto engine", () => {
  assert.match(html, /<script src="\.\/src\/crypto\.js"><\/script>/);
});

test("the crypto engine is loaded before the code that uses it", () => {
  // It is a plain script and the application is a text/babel block, so order
  // is the only thing making Crypt available. Loading it after would leave
  // Crypt undefined at first render.
  const engine = html.indexOf('src="./src/crypto.js"');
  const app = html.indexOf('<script type="text/babel">');

  assert.ok(engine > 0, "the engine is loaded");
  assert.ok(app > engine, "and it comes first");
});

test("the crypto engine is not also defined inline", () => {
  // Two definitions and the file would be the dead one — the tests would pass
  // and the browser would run something else.
  assert.doesNotMatch(html, /const Crypt = \{/);
});

test("the service worker precaches the crypto engine", () => {
  // Otherwise an offline load gets the cached shell and then cannot find
  // Crypt.
  assert.match(sw, /"\.\/src\/crypto\.js"/);
  assert.match(sw, /"\.\/index\.html"/);
});

test("the cache name was bumped past the version that predates that", () => {
  // The activate handler deletes every cache whose name is not the current
  // one, so a stale name means an existing installation keeps serving a shell
  // that has no crypto.js in it.
  const match = sw.match(/const CACHE = "translucent-v(\d+)"/);

  assert.ok(match, "the cache name has a version number");
  assert.ok(Number(match[1]) >= 2, "and it is past v1");
});

/* ── Third-party scripts ────────────────────────────────────── */

/** Every <script src="https://..."> in the page, with its attributes. */
function externalScripts() {
  const found = [];

  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    const src = tag.match(/src="(https:\/\/[^"]+)"/);
    if (src) found.push({ tag, src: src[1] });
  }

  return found;
}

test("the page loads the third-party scripts it is expected to", () => {
  const hosts = externalScripts().map(({ src }) => new URL(src).host);

  assert.ok(hosts.includes("unpkg.com"), "React and Babel");
  assert.ok(hosts.includes("accounts.google.com"), "Google sign-in");
});

test("every unpkg script is pinned to an exact version", () => {
  /* "react@18" resolves to whatever the latest 18.x is. With an integrity
     hash that means the page breaks on the next patch release; without one it
     means the code running in front of the passphrase can change without
     anybody deciding it should. */
  for (const { src } of externalScripts()) {
    if (!src.includes("unpkg.com")) continue;

    assert.match(
      src,
      /@\d+\.\d+\.\d+[/@]/,
      `${src} names a full major.minor.patch version`,
    );
  }
});

test("every unpkg script has an integrity hash and crossorigin", () => {
  /* This application's premise is that notes are encrypted before they leave
     the browser. A substituted script here would run with full access to the
     page and could read the passphrase before encryption happens. */
  for (const { tag, src } of externalScripts()) {
    if (!src.includes("unpkg.com")) continue;

    assert.match(tag, /integrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/, `${src} has a hash`);
    assert.match(tag, /crossorigin/, `${src} is fetched with CORS, which integrity requires`);
  }
});

test("Google's sign-in client is deliberately left unpinned", () => {
  // Google ships it unversioned and expects to update it. A hash would break
  // sign-in at a time of their choosing. This asserts the exception is still
  // the single one it is documented to be.
  const google = externalScripts().filter(({ src }) => src.includes("accounts.google.com"));

  assert.equal(google.length, 1, "there is exactly one such script");
  assert.doesNotMatch(google[0].tag, /integrity=/, "and it carries no hash");
});

/* ── Configuration ──────────────────────────────────────────── */

test("the app reads only the client id from the config file", () => {
  // client_config.json is served to the browser, so anything else in it is
  // published. See SECRETS-TODO.md.
  assert.match(html, /cfg\?\.web\?\.client_id/);
  assert.doesNotMatch(html, /client_secret/);
});

test("the example config carries no secret", () => {
  const example = JSON.parse(
    fs.readFileSync(path.join(root, "client_config.example.json"), "utf8"),
  );

  assert.deepEqual(Object.keys(example.web).sort(), ["client_id", "javascript_origins"]);
});

test("the real config file is gitignored", () => {
  const ignored = fs.readFileSync(path.join(root, ".gitignore"), "utf8");

  assert.match(ignored, /^client_config\.json$/m);
});

/* ── Failed saves ───────────────────────────────────────────── */

test("a failed save is remembered and retried", () => {
  /* It used to be a toast and nothing else: the edit existed only in React
     state, was never written anywhere, and was gone when the tab closed. */
  assert.match(html, /unsavedRef/, "the failed save is held");
  assert.match(html, /addEventListener\("online", retry\)/, "and retried when the connection returns");
  assert.match(html, /addEventListener\("beforeunload", warn\)/, "and closing the tab warns");
});

/* ── The board rules are reachable ──────────────────────────── */

test("index.html loads the board rules before the code that uses them", () => {
  const board = html.indexOf('<script src="./src/board.js"></script>');
  const app = html.indexOf('<script type="text/babel">');

  assert.ok(board > 0, "board.js is loaded");
  assert.ok(app > board, "and it comes first");
});

test("the service worker precaches the board rules, under a new cache name", () => {
  // Without the bump, an installed copy keeps its old cache, whose shell has
  // no board.js, and an offline load cannot find Board.
  assert.match(sw, /"\.\/src\/board\.js"/);
  const match = sw.match(/const CACHE = "translucent-v(\d+)"/);
  assert.ok(Number(match[1]) >= 3);
});

test("the list's checkbox and done flag are gone from the page", () => {
  // A task's column is its status; a second done flag would disagree with it.
  assert.doesNotMatch(html, /\.done\b/);
  assert.doesNotMatch(html, /TodoItem|AddTodo/);
});

/* ── The Drive file and the id cached for it move together ─── */

test("the cached Drive file id is stored under a key tied to the file name", () => {
  // META_KEY caches a file id, and the app reads that id directly
  // without looking the file up by name. Renaming DATA_FILE while keeping the
  // old key would leave every existing browser reading the old file forever.
  const file = html.match(/const DATA_FILE = "([^"]+)";/);
  const key = html.match(/const META_KEY = "([^"]+)";/);

  assert.ok(file, "DATA_FILE is defined");
  assert.ok(key, "META_KEY is defined");
  assert.equal(file[1], "translucent-kanban-v1.enc");
  assert.equal(key[1], "translucent-kanban-meta");
  assert.doesNotMatch(html, /"crys_meta"/, "no literal key bypasses META_KEY");
});
