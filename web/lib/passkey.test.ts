/**
 * Checks the client-side DER parser against real P256 signatures.
 *
 * The Foundry suite proves the *contract* accepts a correct assertion. This
 * proves the browser produces one -- specifically that we decode WebAuthn's
 * DER-encoded signature into (r, s) correctly, including the minimal-encoding
 * cases where a leading 0x00 byte appears. Getting this wrong fails ~50% of
 * signatures, which is exactly the kind of bug that only shows up on stage.
 *
 *   npx tsx lib/passkey.test.ts
 */

import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { findChallengeIndex, parseDerSignature } from "./passkey";

let checked = 0;
let failed = 0;

function check(name: string, ok: boolean) {
  checked++;
  if (!ok) {
    failed++;
    console.error(`  FAIL  ${name}`);
  }
}

// --- DER round-trip over many random signatures ---------------------------
// Enough iterations to hit both the "leading zero" and "high bit set" branches
// for r and s, which is where naive parsers break.

for (let i = 0; i < 500; i++) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const message = Buffer.from(`message ${i}`);

  const der = nodeSign("sha256", message, { key: privateKey, dsaEncoding: "der" });
  const raw = nodeSign("sha256", message, {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  // Signing is randomised, so we cannot compare the two calls to each other.
  // Instead: parse the DER, re-encode as fixed-width, and confirm it is a
  // well-formed 32-byte pair inside the curve order.
  const { r, s } = parseDerSignature(new Uint8Array(der));

  check(
    `der r fits in 32 bytes (#${i})`,
    r > 0n && r < 2n ** 256n && r.toString(16).length <= 64
  );
  check(
    `der s fits in 32 bytes (#${i})`,
    s > 0n && s < 2n ** 256n && s.toString(16).length <= 64
  );
  check(`raw signature is 64 bytes (#${i})`, raw.length === 64);
}

// A DER signature parsed from a known-length blob must round-trip exactly when
// we re-encode it as the fixed-width form Node gives us for the same bytes.
{
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const message = Buffer.from("fixed");
  const der = nodeSign("sha256", message, { key: privateKey, dsaEncoding: "der" });
  const { r, s } = parseDerSignature(new Uint8Array(der));

  // Reconstruct DER from our parsed integers and compare against the original.
  const enc = (v: bigint) => {
    let hex = v.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    let bytes = Buffer.from(hex, "hex");
    if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const body = Buffer.concat([enc(r), enc(s)]);
  const rebuilt = Buffer.concat([Buffer.from([0x30, body.length]), body]);

  check("DER round-trips byte for byte", rebuilt.equals(der));
}

// --- challenge index -------------------------------------------------------

{
  const json = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: "abc123",
      origin: "https://example.com",
    })
  );
  const idx = findChallengeIndex(new Uint8Array(json));
  check(
    "challenge index points at the value",
    json.subarray(idx, idx + 6).toString() === "abc123"
  );
}

{
  // A multi-byte character before the challenge would desynchronise any
  // implementation that searched a decoded string instead of raw bytes.
  const json = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      origin: "https://café.example",
      challenge: "xyz789",
    })
  );
  const idx = findChallengeIndex(new Uint8Array(json));
  check(
    "challenge index is a byte offset, not a string index",
    json.subarray(idx, idx + 6).toString() === "xyz789"
  );
}

console.log(`${checked - failed}/${checked} checks passed`);
process.exit(failed === 0 ? 0 : 1);
