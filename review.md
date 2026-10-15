# Code Review — Translucent Kanban

**2026-10-03: renamed from Translucent Todo**, at the author's request. They
use it alone, as a team lead, to track who did what. The title, headings,
manifest, README and this file now say Translucent Kanban, and the project
directory is `Web/React/Translucent Kanban`.

**Later the same day it became a board.** The rename commit alone left a list
with a new name. The author pointed out that a kanban board needs columns, and
chose how the board should work:

- Three columns: Assigned → Completed → Submitted.
- A free-text assignee on every card, with suggestions and a filter by person.
- Moving cards by dragging, plus ← and → buttons.
- Columns that stack on a phone.

This is a deliberate interface change, made at the author's request. It is not
an exception to the "business logic only" rule. The rules live in
`src/board.js`, a pure module with 23 tests. The page draws its result.

What changed, and what to know about it:

- **The stored format changed.** The payload is
  `{ tasks, settings }`, where it was `{ todos, settings }`. Each task has
  `status` and `assignee` and no `done` flag. Nothing reads the old shape,
  because the data file is new as well (below). `Board.normalize` still maps
  a `done` task to Completed and an unknown status to Assigned, so a bad
  record shows up somewhere instead of being saved and never drawn.
- **Clear submitted asks first.** The list's "Clear done" did not. Submitted
  cards are the record of who did what, so losing them by accident costs more.
- **Moving a card back onto its own column saves nothing.** `Board.move` and
  `Board.assign` return the same list when nothing changed, and `commit` skips
  the save in that case. A mutation run showed the browser check catching it.
- **On touch screens the card buttons are always visible** (`hover: none`).
  On desktop they appear on hover, as the delete button always did.
- **The person filter falls back to Everyone** when the chosen person's last
  task is deleted. Otherwise the board would be empty, with no button left to
  explain why.
- **`tests/browser/run.js`** drives the real page in headless Chrome with Drive
  stubbed: 29 checks, including a real mouse drag and decrypting what would be
  saved. Three deliberate mutations each failed the check aimed at them. Its
  first draft used `setEmulatedMedia` for `hover: none`, which Chrome ignores,
  so the check could not fail. It now uses touch emulation. It is not in CI,
  because it needs Chrome and the network, and no CI change was committed
  without being run on the CI platform.

Left alone: on a phone the header's avatar button is clipped at the right edge.
The header is unchanged, and so is the layout width at phone size, so it was
the same in the list version.

**The data file is new.** The encrypted Drive file is now
`translucent-kanban-v1.enc` instead of `translucent-todos-v1.enc`, and the
author chose to start fresh, not to carry the old tasks across. The
`localStorage` key that caches the file's id and salt was renamed from
`crys_meta` to `translucent-kanban-meta` at the same time. The app reads the
file by that cached id, never by name, so renaming only the file would have
left every existing browser reading and writing the old one. The first open
after the update therefore asks for a new PIN and creates the new file.

The old file is still in the account's hidden `appDataFolder`, and nothing in
the app can reach it now. Google Drive → Settings → Manage apps → this app →
Delete hidden app data removes it, but it removes the new file too, because
both live in the same folder. Do it before setting the new PIN, or not at all.
A stale `crys_meta` entry stays in the browser's `localStorage`. It is harmless,
and "Forgot PIN" clears it.

The GitHub remote is still `nishantmajhi/Translucent-Todo.git`. Renaming the
repository is the author's call.

First reviewed 2026-09-04. Remediated 2026-09-05 on branch `cleanup/2026-09-05`.

## Correction to the first review

**The first review's critical finding was wrong.** It said a live Google OAuth
client secret was committed to this repository. It is not:

```
$ git show HEAD:client_config.json
    "client_id": "",
    "client_secret": "",
```

The tracked file has always held empty strings, and no blob anywhere in the
history contains the `GOCSPX-` prefix. There is one commit and it is clean.
Nothing needs purging.

The secret is in the **working copy on this machine**, inside a backup archive.
That is a real but much smaller exposure, and it calls for different action:
`SECRETS-TODO.md` sets out what to do and why. The short version is that the
file is now untracked and gitignored — which is the change that mattered, since
the path was already in the index and a single `git add -A` would have
committed the filled-in local copy without anything flagging it — and that the
`client_secret` line should be deleted from the local file, because the browser
fetches that file and deploying it publishes whatever is in it.

I am flagging this at the top because a review that overstates a finding is
worse than one that misses it: it spends the reader's alarm in the wrong place.

## What the first review got right

The cryptography. AES-GCM 256, PBKDF2 at 120,000 iterations of SHA-256, a
random 16-byte salt, a fresh 12-byte IV per encryption, all through Web Crypto,
key marked non-extractable, and the narrowest Drive scope that does the job.
Those are the decisions that matter and every one of them is right. Nothing in
that engine's design was changed.

## Fixed

**A large todo list could not be saved.** `btoa(String.fromCharCode(...bytes))`
spreads a `Uint8Array` into one argument per byte, and V8 refuses somewhere
around 125,000 arguments with `RangeError: Maximum call stack size exceeded`.
That is roughly 125 KB of ciphertext — a few hundred notes. The throw happened
inside `enc()`, on save, so the symptom was that syncing simply stopped working
once the list grew, with "Maximum call stack size exceeded" in a toast. Base64
is chunked now, and produces byte-for-byte the same output, so existing
encrypted files still decrypt.

**A failed save lost the edit.** `persist()` caught the error, showed a toast,
and did nothing else. The change existed only in React state — never written to
Drive, never written to `localStorage` — and was gone when the tab closed.
Going offline for a moment while typing was enough. The failed save is now held
and retried when the connection returns or the tab is looked at again, and
closing with an unwritten change prompts a confirmation.

**No subresource integrity on the CDN scripts.** For an application whose
premise is that notes are encrypted before they leave the browser, a
substituted script could read the passphrase before encryption happens. React,
React DOM and Babel are pinned to exact versions with `sha384` hashes. The
versions are the ones the floating `@18` and `@latest` URLs resolved to on
2026-09-05, so nothing about what runs has changed. Google's sign-in client is
deliberately left unpinned — Google ships it unversioned and expects to update
it, so a hash would break sign-in at a time of their choosing.

**The crypto engine was untestable,** buried at line 1523 of a 3,090-line HTML
file. It is `src/crypto.js` now, loaded as a plain script, with the same
behaviour and the same wire format. `tests/crypto.test.js` covers round trips,
wrong passphrases, altered and truncated ciphertext, unicode, payloads past the
size that used to fail, and — the one most worth having, because it would be
invisible in use — that no IV is ever reused across 200 encryptions.

`tests/page.test.js` covers the structural invariants that would otherwise fail
silently in front of a user: the engine is loaded and loaded first, it is not
also defined inline, the service worker precaches it, the cache name was bumped
so existing installations pick up the new shell, every unpkg script is pinned
and hashed, and the config file carries no secret.

`node --test "tests/*.test.js"` — 31 tests, nothing to install.

**A `LICENSE`.** The README and its badge both claimed MIT and there was no
file. There is one now, in the name Manish Majhi — taken from the author
section of `C/LexiGone`'s README rather than guessed from the GitHub handle.

## Still open

**Offline is not what the README claimed.** The service worker precaches the
shell but treats unpkg as network-only, so whether the app opens offline
depends on the browser's own HTTP cache still holding React and Babel. Pinning
the URLs helps — unpkg serves a pinned path with a one-year `max-age` where a
floating path gets a short one — so in practice it usually works. Making it a
guarantee means vendoring about 2.5 MB into the repository and giving up the
"no local dependencies" property. That trade is yours; the README now describes
the actual behaviour rather than the intended one.

**Babel Standalone still compiles 1,590 lines of JSX in the browser on every
load.** It is 2.4 MB of compiler and by far the largest cost on the page. The
fix that keeps the no-build spirit is to precompile once with `npx babel` and
commit the output alongside the source, or to move to `htm` tagged templates,
which need no compilation at all. Not done here because it changes what ships
and deserves to be a deliberate decision.

**`localStorage` holds the OAuth access token** in `crys_auth`, alongside the
salt and Drive file id in `translucent-kanban-meta`. The salt and file id are not sensitive —
useless without the PIN. The token is: any script on the origin can read it and
use it against `drive.appdata` until it expires. There is no better place for
it in a static app with no backend, so this is a limitation to know rather than
a bug to fix; the integrity hashes above are the mitigation that was available.

**`index.html` is still 3,100 lines.** Extracting the crypto engine was the
piece with the clearest payoff — it is pure, it is testable, and it is the part
most worth reading alone. The Drive layer is the obvious next one.

**There is no conflict handling on Drive sync.** Two devices editing the same
list overwrite each other; last write wins, silently. Worth knowing before
using this on a phone and a laptop at once.

## Notes for a future session

Serve over the port your OAuth client's authorised origin names — the sign-in
flow rejects any other origin, and a service worker will not register from
`file://`.

Do not change the key derivation parameters. `tests/crypto.test.js` asserts
them for that reason: existing notes are encrypted with those values and there
is no server-side plaintext to re-encrypt from, so changing them locks every
existing user out of their own data with no way back.

## Licence, 2026-10-02

The author chose one licence for all of their projects: free for personal,
non-commercial use, modifiable for the user's own use, and not to be
distributed, original or modified. No standard licence says that, so `LICENSE`
is a short custom text, the same in every project apart from the year and what
it excludes. The README's licence section says the same. Anything above that
calls the licence an open question, or calls the project MIT, is superseded.

## CI, 2026-10-02

`.github/workflows/ci.yml` runs the node checks on `ubuntu-latest`. Nothing
has been pushed, so it has not run on GitHub yet. Every job was run before
committing, from a fresh clone of this branch, the way a runner would run it:
Linux jobs in a throwaway Ubuntu 24.04 (the image `ubuntu-latest` uses) with
the same tool versions. 31. It needs no secret: `client_config.json` is
gitignored and the tests do not read it.
