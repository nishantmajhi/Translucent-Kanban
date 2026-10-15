# ✦ Translucent Kanban

A kanban board for keeping track of who on your team did what, which keeps its
contents from everyone, including the place that stores them.

It is for one person: the team lead. Teammates never open it. You assign each
task to someone by name and move it across three columns as the work comes in.

Your tasks are encrypted in the browser with a key derived from a PIN you never
transmit, and only the ciphertext is written to Google Drive. Google holds the
file and cannot read it. There is no server of ours to hold anything.

![License](https://img.shields.io/badge/license-personal%20use%20only-lightgrey) ![PWA](https://img.shields.io/badge/PWA-ready-5a80f5) ![Zero Backend](https://img.shields.io/badge/backend-none-green)

---

## How it works

Everything follows from one decision: **the key never leaves the device, and
nothing that could reconstruct it is ever stored.**

Your PIN goes through PBKDF2 — 120,000 iterations of SHA-256, against a random
16-byte salt — to produce an AES-GCM 256 key. The salt is stored; the PIN and
the key are not. The key lives in memory as a non-extractable `CryptoKey` and
is gone on refresh, which is why you re-enter the PIN after a lock.

The board is serialised, encrypted with a fresh random 12-byte IV, and
written to Drive as a single file in `appDataFolder` — a private area this
application can see and no other application can. Drive receives base64
ciphertext and an IV. It never receives anything else.

Two consequences worth being clear about:

- **Forgetting the PIN loses the tasks.** There is no recovery, because
  recovery would require somebody to hold something that could decrypt them.
  The "Forgot PIN" button signs you out and starts over; it does not recover
  anything.
- **The browser is the trust boundary.** Any script running on the page could
  read the PIN as it is typed. That is why the third-party scripts this page
  loads are pinned to an exact version with a subresource integrity hash — the
  browser refuses a file whose hash does not match rather than running it. The
  one exception is Google's sign-in client, which Google ships unversioned and
  expects to update, so pinning it would break sign-in at a time of their
  choosing rather than ours.

`src/crypto.js` holds all of this and nothing else, and `tests/crypto.test.js`
checks it — including the property most worth checking, which is that an IV is
never reused.

---

## Features

- **End-to-end encryption** — AES-GCM 256 with PBKDF2 (120,000 iterations).
- **Google Drive sync** — one encrypted file in your Drive's private
  `appDataFolder`, invisible to other applications.
- **PIN lock** — 4–6 digits, required to decrypt.
- **Auto-lock** — after a configurable idle timeout, and optionally when you
  switch away from the tab.
- **A three-column board**: Assigned, Completed, Submitted.
- **An assignee on every task**, filtering by person, and live search over task
  text and names.
- **Task priorities**, inline editing, and clearing submitted tasks once you
  no longer need the record.
- **Glass-morphism interface** — light and dark, animated blobs, mouse-tracking
  glow on cards.
- **Installable PWA** — add to the home screen on any device.
- **Nothing to install to run it** — no build step, no package manager.

---

## Using the board

A task moves left to right:

| Column        | Means                                              |
| ------------- | -------------------------------------------------- |
| **Assigned**  | You have given it to someone, and it is not done.  |
| **Completed** | They have done the work.                           |
| **Submitted** | They have handed it in to you.                     |

- **Add a task** in the box at the bottom. Once you start typing, an
  **Assign to…** box and the priority buttons appear. New tasks start in
  Assigned.
- **Move a task** by dragging its card onto another column, or with its ← and →
  buttons. On a computer the buttons appear when you hover over a card. On a
  phone they are always shown, because dragging is awkward there.
- **Change who a task is assigned to** by clicking the name on its card. Names
  you have used before are suggested as you type. Matching ignores case, so
  "asha" and "Asha" count as the same person.
- **Edit a task's text** by double-clicking it.
- **See one person's work** with the name buttons above the board. Unassigned
  shows tasks with nobody on them.
- **Clear submitted** removes every task in Submitted, after asking. Those
  cards are your record of who did what, so clear them only when you no longer
  need it.

Within a column, tasks are sorted by priority. Tasks with the same priority
show the most recently added or moved first. On a phone the three columns stack
one above the other.

---

## Project structure

```
translucent-kanban/
├── index.html                  Interface, Drive sync, auth, state — the application
├── src/crypto.js               Key derivation, encryption, decryption
├── src/board.js                Columns, moves, assignees, filters
├── tests/                      node --test "tests/*.test.js"
│   └── browser/run.js          The real page in headless Chrome
├── sw.js                       Service worker
├── manifest.json               PWA manifest
├── icon-192.png, icon-512.png
├── client_config.example.json  Template
└── client_config.json          ← you create this; gitignored (see Setup)
```

The crypto engine used to live inside `index.html` with everything else. It has
its own file so it can be tested without a browser, and because it is the part
of this application most worth being able to read on its own. The board rules
are in their own file for the same reason: which column a task is in, where it
goes when it moves, and what a filter shows. `index.html` only draws the
result.

Each stored task is
`{ id, text, priority, status, assignee, createdAt }`, where `status` is
`assigned`, `completed` or `submitted`.

---

## Development

```sh
node --test "tests/*.test.js"
```

Node 18 or later. Nothing to install: Node's own test runner and Node's own Web
Crypto, which is the same API the browser uses, so the tests exercise the same
code the application runs.

```sh
node tests/browser/run.js                 # add --shots DIR to save screenshots
```

This loads the real page in headless Chrome, sets a PIN, and uses the board:
adding, dragging, assigning, filtering and clearing. It then decrypts what
would have been saved to Drive and checks it against the screen. It also checks
the layout at phone width. Google is stubbed out, so nothing is sent to Google
and your `client_config.json` is never read. React and Babel still come from
unpkg, so it needs the network. It finds Chrome in the usual places, or set
`CHROME` to its path. It is not part of CI.

There is no build step and no package manager, deliberately. Adding a
dependency changes that, so it should be a decision rather than a convenience.

---

## Setup

### 1. Create a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project.
2. Navigate to **APIs & Services → Library** and enable the **Google Drive API**.
3. Go to **APIs & Services → OAuth consent screen**:
   - Choose **External** (or Internal if on Workspace).
   - Fill in the app name (e.g. `Translucent Kanban`) and your email.
   - Add the scope: `https://www.googleapis.com/auth/drive.appdata`
   - Add your own Google account as a test user.
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Add your origin to **Authorised JavaScript origins** (e.g. `http://localhost:5500` for local dev, or your hosted URL for production).
5. Click **Download JSON** and save it as `client_config.json` in the project root.

**Then open it and delete the `client_secret` line.** The browser fetches this
file over HTTP, so on a deployed instance anyone can request
`/client_config.json` and read whatever is in it. Nothing here uses the secret
— a "web" OAuth client running in JavaScript cannot keep one, which is why this
app uses the implicit token flow — so the only thing it can do is leak.
`client_config.example.json` shows the minimum the app actually reads:

```json
{
  "web": {
    "client_id": "",
    "javascript_origins": ["http://localhost:8080"]
  }
}
```

`client_config.json` is gitignored. Keep it that way; see `SECRETS-TODO.md`.

The app reads the `client_id` from that file at startup — nothing is hard-coded.

### 2. Add allowed Google accounts

While your OAuth app is in **Testing** mode (the default for External apps), only accounts explicitly listed as test users can sign in. Any other Google account will see an "Access blocked" error from Google.

To add allowed accounts:

1. Go to **APIs & Services → OAuth consent screen** in the Cloud Console.
2. Scroll down to the **Test users** section.
3. Click **+ Add Users**.
4. Enter the Gmail addresses you want to allow, one per line (e.g. `yourname@gmail.com`).
5. Click **Save**.

Changes take effect within a few minutes. You can add up to 100 test users while in Testing mode. If you want anyone with a Google account to sign in without being pre-approved, you would need to go through Google's full OAuth app verification — for a personal or small-team tool, staying in Testing mode with specific allowed accounts is the recommended approach.

> **Tip:** If you are the only user, just add your own Gmail address. If you are sharing with friends or teammates, add each of their Gmail addresses here before sending them the link.

### 3. Serve the files

The app must be served over HTTP/HTTPS (not opened as a `file://` URL) for Google Sign-In and the Service Worker to work.

**Option A — VS Code Live Server**
Install the [Live Server extension](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) and click **Go Live**.

**Option B — Python**

```bash
python -m http.server 5500
```

**Option C — Node**

```bash
npx serve .
```

Then open `http://localhost:5500` in your browser.

### 4. First run

1. Click **Continue with Google** and sign in.
2. Set a 4–6 digit PIN. This PIN is the encryption key — it is never transmitted or stored anywhere.
3. Re-enter the PIN to confirm.
4. Start adding tasks. Everything is auto-saved to Drive within ~1.6 seconds of any change.

---

## Security Model

| What           | How                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| Encryption     | AES-GCM 256-bit                                                                                            |
| Key derivation | PBKDF2-SHA256, 120,000 iterations, random 16-byte salt                                                     |
| Salt storage   | Stored in `localStorage` alongside the Drive file ID (not sensitive — useless without the PIN)             |
| Data at rest   | Single encrypted blob (`translucent-kanban-v1.enc`) in `drive.appdata` — not visible in the user's Drive UI |
| PIN            | Never stored, never sent. Derived into a `CryptoKey` in memory only. Lost on lock/refresh.                 |
| OAuth token    | Cached in `localStorage` with expiry check. Revoked on sign-out.                                           |

Changing your PIN re-encrypts the entire dataset with the new key and overwrites the Drive file.

---

## Settings

Accessible via the avatar menu → **Settings**.

| Setting              | Options                                               |
| -------------------- | ----------------------------------------------------- |
| Auto-lock after idle | Never, Immediately, 1 / 2 / 5 / 10 / 30 min           |
| Lock when tab hides  | Never, Immediately, 30 s, 1 / 3 / 5 / 10 min          |
| Change PIN           | Re-encrypts all data with a new PIN                   |
| Delete all data      | Permanently removes the Drive file and resets the app |

### Default locking behaviour

**Auto-lock after idle — default 5 minutes**
The app watches for mouse movement, keyboard input, and touch events. If none of these occur for 5 minutes, the app locks automatically and requires your PIN to unlock. The timer resets whenever you interact with the page. You can tighten this to 1 or 2 minutes for shared devices, or disable it entirely if you are the sole user of your machine.

**Lock when tab hides — default 1 minute**
When you switch to another tab or application, a 1-minute countdown begins. If you return to the tab within that minute, the countdown cancels and the app stays unlocked. If you stay away for longer than 1 minute, the app locks and you will need your PIN when you come back. Set this to **Immediately** for maximum security on shared screens, or **Never** if you frequently switch tabs and find re-entering your PIN disruptive.

---

## Hosting

The app must be served over HTTPS for the Web Crypto API, Service Worker, and Google Sign-In to function correctly. Three zero-cost options are described below — all work out of the box with no build step required.

### Option A — GitHub Pages

1. Push the repo to GitHub.
2. Go to **Settings → Pages** and set the source to the `main` branch, root folder.
3. Your app will be live at `https://<your-username>.github.io/<repo-name>/`.
4. Add that URL to your Google Cloud OAuth client's **Authorised JavaScript origins**.

> **Note:** GitHub Pages serves over HTTPS, which is required for the Web Crypto API and Service Worker.

### Option B — Vercel

Vercel deploys static files instantly and gives you a clean custom URL with automatic HTTPS.

1. Push the repo to GitHub (or GitLab / Bitbucket).
2. Go to [vercel.com](https://vercel.com/) and sign in, then click **Add New → Project**.
3. Import your repository. Vercel will auto-detect that there is no build step needed.
4. On the configuration screen:
   - **Framework Preset** — select **Other**.
   - **Build Command** — leave blank.
   - **Output Directory** — leave as `.` (the repo root).
5. Click **Deploy**. Your app will be live at `https://<your-project>.vercel.app` within seconds.
6. Add that URL to your Google Cloud OAuth client's **Authorised JavaScript origins**.
7. _(Optional)_ Go to **Project → Settings → Domains** to attach a custom domain — Vercel provisions an SSL certificate automatically.

> **Tip:** Every push to your main branch triggers a new deployment automatically. Pull request branches get their own preview URLs, which is useful for testing changes without affecting the live app.

### Option C — Cloudflare Pages (recommended if your domain is on Cloudflare)

If you already have a domain managed through Cloudflare — which is a common setup among developers in Nepal who register `.com.np` or international domains via Cloudflare — this is the most natural choice. You get free hosting, automatic HTTPS, and your custom domain wired up in minutes without touching any external DNS settings.

1. Push the repo to GitHub (or GitLab).
2. Go to the [Cloudflare Dashboard](https://dash.cloudflare.com/) and select your account.
3. In the left sidebar, navigate to **Workers & Pages → Create → Pages → Connect to Git**.
4. Authorise Cloudflare to access your GitHub account and select your repository.
5. On the build configuration screen:
   - **Framework Preset** — select **None**.
   - **Build Command** — leave blank.
   - **Build Output Directory** — leave as `/` (the repo root).
6. Click **Save and Deploy**. Cloudflare will give you a URL like `https://<your-project>.pages.dev`.
7. Add that URL to your Google Cloud OAuth client's **Authorised JavaScript origins**.

**Attaching your custom domain:**

8. Once the first deployment succeeds, go to your Pages project → **Custom Domains → Set up a custom domain**.
9. Enter your domain or subdomain (e.g. `kanban.yourdomain.com`).
10. Because your domain is already on Cloudflare, the required DNS record (`CNAME`) is added automatically — no manual changes needed.
11. SSL is provisioned instantly via Cloudflare's Universal SSL certificate.
12. Update your Google Cloud OAuth client's **Authorised JavaScript origins** to include the custom domain URL as well.

> **Tip:** Cloudflare Pages also creates preview deployments for every push to non-production branches, accessible at `https://<branch-name>.<your-project>.pages.dev`.

---

## Offline Support

The service worker pre-caches `index.html`, `manifest.json`, `src/crypto.js` and
`src/board.js`
on install, and uses stale-while-revalidate for local assets.

It does **not** manage the CDN scripts. React and Babel are fetched from the
network like any other cross-origin request, so whether the app opens offline
comes down to whether the browser's own HTTP cache still holds them. Pinning
those URLs to exact versions helps here as well as with integrity: unpkg serves
a pinned path with a one-year `max-age`, where a floating `@18` path gets a
short one.

So: the app usually opens offline, and reliably does so shortly after a visit,
but it is the HTTP cache doing that work rather than the service worker.
Vendoring React and Babel into the repository would make it a guarantee, at the
cost of about 2.5 MB and the "no local dependencies" property. That trade has
not been made.

Drive sync always requires a connection. A save that fails is retried when the
connection returns or when you look at the tab again, and closing the tab with
an unwritten change prompts a confirmation. Before, a failed save was a toast
and nothing else: the edit existed only in memory and was gone when the tab
closed.

---

## Tech Stack

| Layer   | Technology                                      |
| ------- | ----------------------------------------------- |
| UI      | React 18 (UMD, no build step)                   |
| Styling | Pure CSS with custom properties, glassmorphism  |
| Crypto  | Web Crypto API (native browser)                 |
| Storage | Google Drive `appDataFolder`                    |
| Auth    | Google Identity Services (OAuth 2.0 token flow) |
| Offline | Service Worker + Cache API                      |
| Fonts   | Josefin Sans (Google Fonts)                     |

---

## License

Free for personal, non-commercial use. You may use, study and modify this
software for yourself, but you may not use it commercially, and you may not
share or publish it, in its original form or modified. See [LICENSE](LICENSE)
for the full terms.
