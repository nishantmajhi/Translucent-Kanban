# Credentials

Written 2026-09-05. Delete this file once the items below are settled.

## What is actually true

The earlier review in `review.md` said a live Google OAuth client secret was
committed to this repository. **That was wrong, and the correction matters
because the two situations call for different urgency.** The tracked copy of
`client_config.json` has always held empty strings:

```
$ git show HEAD:client_config.json
    "client_id": "",
    "client_secret": "",
```

Every blob in this repository was searched for the `GOCSPX-` prefix and none
contains it. There is one commit and it is clean. Nothing needs purging from
history.

The real secret is in the **working copy on this machine**, which is inside a
backup archive. That is a much smaller exposure — but it is not nothing, and
there are two things worth doing.

## 1. Untracked, so it cannot be committed by accident

`client_config.json` is now removed from tracking and listed in `.gitignore`,
with `client_config.example.json` as the template. The file on disk is
untouched, so the app keeps working.

This is the change that matters most. The file was tracked with blank values,
so a single `git add -A` at any point would have committed the filled-in local
copy — quietly, because the path was already in the index and nothing would
have flagged it.

## 2. Delete the `client_secret` line from your local file

`index.html` fetches `./client_config.json` from the web server and reads
exactly one field from it:

```js
const r = await fetch("./client_config.json");
cid = cfg?.web?.client_id || null;
```

Nothing in this application uses `client_secret`, and nothing in a browser can:
Google's own guidance is that a "web" client running in JavaScript cannot keep
one, which is why the implicit flow this app uses does not involve it.

But the file is served by the web server. On `localhost:8080` that means only
you. **The moment this is deployed anywhere, `GET /client_config.json` hands
the secret to anyone who asks for it.** Open your local copy and delete the
`client_secret`, `token_uri` and `auth_provider_x509_cert_url` lines; the app
needs none of them. `client_config.example.json` shows the minimum.

## 3. Rotate, if this archive has ever left the machine

Rotating in the Google Cloud Console costs nothing and removes the question. Do
it if this backup has been on a shared drive, a cloud sync, or another
computer. If it has only ever been on this laptop, it is a judgement call.

While you are in the console, check the OAuth client's **authorised JavaScript
origins**. They are currently `http://localhost:8080` only, which is the
correct, narrow setting — confirm nothing has widened them.

## Worth knowing for scanning this archive

`GOCSPX-` is not in the usual secret-scanning regex sets, which lean towards
AWS keys and GitHub tokens. It was found by reading the file, not by a scan.
Add that prefix to whatever you scan with.
