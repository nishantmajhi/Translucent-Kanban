/* ═══════════════════════════════════════════════════════════
   Translucent Kanban — crypto engine

   Lifted out of index.html so it can be tested. Everything in this
   file is a pure function of its arguments plus Web Crypto, and the
   on-the-wire format is unchanged: notes encrypted by the previous
   version still decrypt with this one.

   AES-GCM 256, key derived with PBKDF2 at 120,000 iterations of
   SHA-256, a random 16-byte salt, a fresh random 12-byte IV per
   encryption. Do not change the derivation parameters without a
   migration path — existing notes are encrypted with these, and there
   is no server-side plaintext to re-encrypt from.

   Loads as a plain script in the browser (window.Crypt) and as a
   CommonJS module under Node, which is how tests/crypto.test.js
   reaches it.
   ═══════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module !== null && module.exports) {
    module.exports = api;
  } else {
    root.Crypt = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /* Base64 of a byte array.

     This used to be btoa(String.fromCharCode(...bytes)). Spreading a
     Uint8Array passes one argument per byte, and every engine has a limit
     on how many arguments a call may take — around 125,000 in V8. Past
     that it throws RangeError: Maximum call stack size exceeded.

     That is roughly 125 KB of ciphertext, which a todo list with a few
     hundred notes in it reaches easily. The throw happened inside enc(),
     on save, so the symptom was that syncing simply stopped working once
     the list grew — with "Maximum call stack size exceeded" in a toast.

     Chunking keeps every call small, and produces byte-for-byte the same
     base64 as before. */
  const CHUNK = 0x8000;

  function toBase64(bytes) {
    let binary = "";

    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(offset, offset + CHUNK),
      );
    }

    return btoa(binary);
  }

  function fromBase64(text) {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  }

  return {
    /* Changing any of these invalidates every existing encrypted file. */
    ITERATIONS: 120000,
    HASH: "SHA-256",
    KEY_LENGTH: 256,
    SALT_BYTES: 16,
    IV_BYTES: 12,

    toBase64,
    fromBase64,

    /* Derive the AES key from a passphrase.

       Pass the stored salt to reproduce an existing key; omit it to start
       a new one, in which case a fresh random salt is generated and
       returned alongside the key for storing. */
    async derive(pin, saltB64 = null) {
      const salt = saltB64
        ? fromBase64(saltB64)
        : crypto.getRandomValues(new Uint8Array(this.SALT_BYTES));

      const raw = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(pin),
        "PBKDF2",
        false,
        ["deriveKey"],
      );

      const key = await crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt,
          iterations: this.ITERATIONS,
          hash: this.HASH,
        },
        raw,
        { name: "AES-GCM", length: this.KEY_LENGTH },
        false,
        ["encrypt", "decrypt"],
      );

      return { key, salt: toBase64(salt) };
    },

    /* Encrypt a value as JSON. A fresh IV every time: reusing one with
       the same key is the single most damaging mistake available in
       AES-GCM, so it is generated here and nowhere else. */
    async enc(obj, key) {
      const iv = crypto.getRandomValues(new Uint8Array(this.IV_BYTES));

      const buf = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(JSON.stringify(obj)),
      );

      return { iv: toBase64(iv), ct: toBase64(new Uint8Array(buf)) };
    },

    /* Decrypt. Throws if the key is wrong or the ciphertext was altered —
       AES-GCM authenticates, so a wrong passphrase fails rather than
       returning plausible rubbish. Callers treat the throw as "wrong
       PIN". */
    async dec(e, key) {
      const buf = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(e.iv) },
        key,
        fromBase64(e.ct),
      );

      return JSON.parse(new TextDecoder().decode(buf));
    },
  };
});
