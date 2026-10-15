/* Tests for the crypto engine.
 *
 * node --test tests/
 *
 * Node's built-in test runner and Node's built-in Web Crypto, so there is
 * nothing to install — which matters for a project that deliberately has no
 * build step and no package manager.
 *
 * The engine is the part of this application that everything else rests on: if
 * it is wrong, the notes are not private, and nothing in the interface would
 * show it. These check the properties that would be invisible in use.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const Crypt = require("../src/crypto.js");

/* ── Base64 ─────────────────────────────────────────────────── */

test("base64 round-trips arbitrary bytes", () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;

  assert.deepEqual(Crypt.fromBase64(Crypt.toBase64(bytes)), bytes);
});

test("base64 matches what the previous implementation produced", () => {
  // The stored format must not change: notes encrypted by the inline version
  // of this engine have to keep decrypting.
  const cases = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([1, 2, 3, 250, 255]),
    new Uint8Array(1000).map((_, i) => (i * 37) % 256),
  ];

  for (const bytes of cases) {
    assert.equal(
      Crypt.toBase64(bytes),
      btoa(String.fromCharCode(...bytes)),
      `${bytes.length} bytes`,
    );
  }
});

test("base64 handles a payload larger than the argument limit", () => {
  /* The bug this replaced: btoa(String.fromCharCode(...bytes)) passes one
     argument per byte, and V8 refuses somewhere around 125,000 of them with
     "Maximum call stack size exceeded". That is about 125 KB of ciphertext —
     a todo list with a few hundred notes in it. The throw happened inside
     enc(), on save, so syncing simply stopped working once the list grew. */
  const big = new Uint8Array(500_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 256;

  assert.throws(
    () => btoa(String.fromCharCode(...big)),
    RangeError,
    "the old approach still fails at this size, so this test is testing something",
  );

  const encoded = Crypt.toBase64(big);

  assert.equal(encoded.length, Math.ceil(big.length / 3) * 4, "the expected length");
  assert.deepEqual(Crypt.fromBase64(encoded), big, "and it round-trips");
});

/* ── Key derivation ─────────────────────────────────────────── */

test("deriving without a salt produces a fresh random one", async () => {
  const a = await Crypt.derive("correct horse");
  const b = await Crypt.derive("correct horse");

  assert.notEqual(a.salt, b.salt, "two derivations do not share a salt");
  assert.equal(Crypt.fromBase64(a.salt).length, Crypt.SALT_BYTES, "16 bytes");
});

test("the same passphrase and salt produce the same key", async () => {
  // This is what lets a user unlock on a second device: the salt is stored
  // alongside the ciphertext, the passphrase is not stored anywhere.
  const first = await Crypt.derive("correct horse");
  const second = await Crypt.derive("correct horse", first.salt);

  const sealed = await Crypt.enc({ note: "hello" }, first.key);

  assert.deepEqual(await Crypt.dec(sealed, second.key), { note: "hello" });
});

test("a different passphrase with the same salt produces a different key", async () => {
  const first = await Crypt.derive("correct horse");
  const second = await Crypt.derive("correct horsf", first.salt);

  const sealed = await Crypt.enc({ note: "hello" }, first.key);

  await assert.rejects(() => Crypt.dec(sealed, second.key));
});

test("the derivation parameters are the ones existing notes were encrypted with", () => {
  // Changing any of these silently locks every existing user out of their own
  // notes, and there is no server-side plaintext to re-encrypt from.
  assert.equal(Crypt.ITERATIONS, 120000);
  assert.equal(Crypt.HASH, "SHA-256");
  assert.equal(Crypt.KEY_LENGTH, 256);
  assert.equal(Crypt.SALT_BYTES, 16);
});

/* ── Encryption ─────────────────────────────────────────────── */

test("encrypt then decrypt returns the original value", async () => {
  const { key } = await Crypt.derive("passphrase");

  const original = {
    todos: [
      { id: "a1", text: "buy milk", done: false },
      { id: "b2", text: "ring the bank", done: true, note: "before 4pm" },
    ],
    settings: { theme: "glass", lockOnHideDelay: 30 },
  };

  assert.deepEqual(await Crypt.dec(await Crypt.enc(original, key), key), original);
});

test("the IV is different on every encryption", async () => {
  /* The single most damaging mistake available in AES-GCM. Reusing an IV with
     the same key leaks the XOR of the two plaintexts and destroys the
     authentication guarantee. It would be completely invisible in use, which
     is exactly why it is worth a test. */
  const { key } = await Crypt.derive("passphrase");

  const seen = new Set();

  for (let i = 0; i < 200; i++) {
    const { iv } = await Crypt.enc({ i }, key);

    assert.equal(Crypt.fromBase64(iv).length, Crypt.IV_BYTES, "12 bytes");
    assert.ok(!seen.has(iv), `IV repeated on encryption ${i}`);

    seen.add(iv);
  }
});

test("encrypting the same value twice gives different ciphertext", async () => {
  const { key } = await Crypt.derive("passphrase");

  const a = await Crypt.enc({ note: "the same thing" }, key);
  const b = await Crypt.enc({ note: "the same thing" }, key);

  assert.notEqual(a.ct, b.ct, "identical input does not produce identical output");
  assert.deepEqual(await Crypt.dec(a, key), await Crypt.dec(b, key), "both still decrypt");
});

test("the ciphertext does not contain the plaintext", async () => {
  const { key } = await Crypt.derive("passphrase");

  const sealed = await Crypt.enc({ note: "the bank account number is 12345" }, key);
  const decoded = Buffer.from(Crypt.fromBase64(sealed.ct)).toString("latin1");

  assert.ok(!decoded.includes("bank"), "no plaintext in the ciphertext");
  assert.ok(!decoded.includes("12345"), "including the part that matters");
});

/* ── Decryption failure ─────────────────────────────────────── */

test("a wrong passphrase is rejected rather than returning rubbish", async () => {
  // AES-GCM authenticates, so this fails cleanly. The application relies on
  // the throw: it is how "wrong PIN" is detected.
  const first = await Crypt.derive("right passphrase");
  const sealed = await Crypt.enc({ note: "secret" }, first.key);

  const wrong = await Crypt.derive("wrong passphrase", first.salt);

  await assert.rejects(() => Crypt.dec(sealed, wrong.key));
});

test("altered ciphertext is rejected", async () => {
  const { key } = await Crypt.derive("passphrase");
  const sealed = await Crypt.enc({ note: "transfer £10" }, key);

  const bytes = Crypt.fromBase64(sealed.ct);
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;

  await assert.rejects(
    () => Crypt.dec({ iv: sealed.iv, ct: Crypt.toBase64(bytes) }, key),
    "a single flipped bit is detected",
  );
});

test("a substituted IV is rejected", async () => {
  const { key } = await Crypt.derive("passphrase");

  const a = await Crypt.enc({ note: "one" }, key);
  const b = await Crypt.enc({ note: "two" }, key);

  await assert.rejects(() => Crypt.dec({ iv: b.iv, ct: a.ct }, key));
});

test("truncated ciphertext is rejected", async () => {
  // Half a file from an interrupted Drive read must not decrypt to half a
  // todo list.
  const { key } = await Crypt.derive("passphrase");
  const sealed = await Crypt.enc({ todos: [1, 2, 3, 4, 5] }, key);

  const bytes = Crypt.fromBase64(sealed.ct);

  await assert.rejects(() =>
    Crypt.dec({ iv: sealed.iv, ct: Crypt.toBase64(bytes.subarray(0, bytes.length - 4)) }, key),
  );
});

/* ── Sizes the application actually reaches ─────────────────── */

test("a large todo list encrypts and decrypts", async () => {
  /* The regression guard for the base64 bug, at the layer where it bit. Two
     thousand notes is a plausible few years of use and comes to well over the
     125 KB that used to throw. */
  const { key } = await Crypt.derive("passphrase");

  const todos = Array.from({ length: 2000 }, (_, i) => ({
    id: `id-${i}`,
    text: `Something that needs doing, number ${i}`,
    note: "With a longer note attached to it so the payload is realistic.",
    done: i % 3 === 0,
  }));

  const sealed = await Crypt.enc({ todos }, key);

  assert.ok(
    Crypt.fromBase64(sealed.ct).length > 125_000,
    "the payload is past the size that used to fail",
  );

  const returned = await Crypt.dec(sealed, key);

  assert.equal(returned.todos.length, 2000);
  assert.deepEqual(returned.todos[1999], todos[1999], "the last one survives intact");
});

test("unicode survives the round trip", async () => {
  const { key } = await Crypt.derive("passphrase");

  const original = { todos: [{ text: "काठमाडौँ जानु छ — 🗓️ भोलि" }] };

  assert.deepEqual(await Crypt.dec(await Crypt.enc(original, key), key), original);
});

test("an empty list encrypts and decrypts", async () => {
  const { key } = await Crypt.derive("passphrase");

  assert.deepEqual(
    await Crypt.dec(await Crypt.enc({ todos: [], settings: {} }, key), key),
    { todos: [], settings: {} },
  );
});
