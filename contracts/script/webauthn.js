#!/usr/bin/env node
// Test helper: produces real WebAuthn assertions for the Foundry test suite.
//
// This deliberately does NOT mock anything. It builds authenticatorData and
// clientDataJSON exactly as a browser authenticator would, signs the same
// sha256(authData || sha256(clientDataJSON)) preimage a passkey signs, and
// emits abi-encoded output for `vm.ffi`. If these tests pass, a real Face ID
// signature from a real phone verifies too.
//
//   node webauthn.js pubkey                  -> abi.encode(uint256 x, uint256 y)
//   node webauthn.js sign <challengeHex>     -> abi.encode(bytes,bytes,uint256,uint256,uint256)
//   node webauthn.js sign-wrong <challengeHex> -> assertion over a DIFFERENT challenge

const { createPrivateKey, createPublicKey, sign, createHash } = require("crypto");

// Fixed key so tests are deterministic.
const PKCS8_B64 =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgY5D9sNpFjfPy/GylbaF2+fiPe7XiZBpvbLGUlDv+5IWhRANCAARnU+udyDU+lwaiJAC/lWND7Jc7AZtggJz8dBpSqV3m83FFttTEWALcYHjSTvPNFug8Kd60qoEdQmL9dCVCYLnq";

const P256_N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");

const privateKey = createPrivateKey({
  key: Buffer.from(PKCS8_B64, "base64"),
  format: "der",
  type: "pkcs8",
});

function pubkeyXY() {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return [
    BigInt("0x" + Buffer.from(jwk.x, "base64url").toString("hex")),
    BigInt("0x" + Buffer.from(jwk.y, "base64url").toString("hex")),
  ];
}

const sha256 = (b) => createHash("sha256").update(b).digest();

// rpIdHash(32) | flags(1) | signCount(4). 0x05 = user present + user verified.
function authenticatorData(rpId = "localhost", counter = 1) {
  const out = Buffer.alloc(37);
  sha256(Buffer.from(rpId)).copy(out, 0);
  out[32] = 0x05;
  out.writeUInt32BE(counter, 33);
  return out;
}

function clientDataJSON(challengeHex) {
  const challenge = Buffer.from(challengeHex.replace(/^0x/, ""), "hex");
  // Field order matters only in that we must report the byte offset of the
  // challenge value; the contract locates it by the index we pass in.
  return Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: challenge.toString("base64url"),
      origin: "http://localhost:3000",
      crossOrigin: false,
    })
  );
}

function assertion(challengeHex) {
  const authData = authenticatorData();
  const clientData = clientDataJSON(challengeHex);

  // A passkey signs ECDSA-SHA256 over this concatenation.
  const preimage = Buffer.concat([authData, sha256(clientData)]);
  const raw = sign("sha256", preimage, { key: privateKey, dsaEncoding: "ieee-p1363" });

  const r = BigInt("0x" + raw.subarray(0, 32).toString("hex"));
  let s = BigInt("0x" + raw.subarray(32, 64).toString("hex"));
  // Canonicalise to low-s: (r, s) and (r, n-s) are both valid, and the
  // contract rejects the high variant to prevent signature malleability.
  if (s > P256_N / 2n) s = P256_N - s;

  // Byte offset of the first base64url challenge character.
  const challengeIndex = clientData.indexOf('"challenge":"') + '"challenge":"'.length;

  return { authData, clientData, challengeIndex, r, s };
}

// --- minimal abi encoder for the shapes we return -------------------------

const word = (v) => BigInt(v).toString(16).padStart(64, "0");

function encodeBytes(buf) {
  const len = word(buf.length);
  const padded = Buffer.concat([buf, Buffer.alloc((32 - (buf.length % 32)) % 32)]);
  return len + padded.toString("hex");
}

function encodeAssertion(a) {
  // (bytes authData, bytes clientData, uint256 challengeIndex, uint256 r, uint256 s)
  // Two dynamic head slots, then three static.
  const authHex = encodeBytes(a.authData);
  const clientHex = encodeBytes(a.clientData);
  const headSize = 5 * 32;
  const offAuth = headSize;
  const offClient = headSize + authHex.length / 2;

  return (
    "0x" +
    word(offAuth) +
    word(offClient) +
    word(a.challengeIndex) +
    word(a.r) +
    word(a.s) +
    authHex +
    clientHex
  );
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "pubkey") {
  const [x, y] = pubkeyXY();
  process.stdout.write("0x" + word(x) + word(y));
} else if (cmd === "sign") {
  process.stdout.write(encodeAssertion(assertion(arg)));
} else if (cmd === "sign-wrong") {
  // Same key, valid signature, but over a challenge nobody asked for.
  const bogus = "0x" + "de".repeat(32);
  process.stdout.write(encodeAssertion(assertion(bogus)));
} else {
  console.error("usage: webauthn.js pubkey | sign <hex> | sign-wrong <hex>");
  process.exit(1);
}
