/**
 * Passkey (WebAuthn) client.
 *
 * The private key is generated inside the phone's secure enclave and never
 * leaves it. Face ID does not create the key -- it unlocks permission to use
 * it. What we get back is a P256 public key, which becomes the worker's
 * identity, and per-action signatures that the contract verifies on-chain via
 * Monad's precompile at 0x0100.
 *
 * Everything here has to mirror WebAuthn.sol byte for byte.
 */

import { encodeAbiParameters, keccak256, toBytes, type Hex } from "viem";
import { TASK_POOL, chain } from "./contracts";

const P256_N = BigInt(
  "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
);

export type PubKey = { x: bigint; y: bigint };

export type WebAuthnSignature = {
  authenticatorData: Hex;
  clientDataJSON: Hex;
  challengeIndex: bigint;
  r: bigint;
  s: bigint;
};

export type Identity = {
  credentialId: string; // base64url
  workerId: Hex;
  /**
   * Only present for an identity created on this device. A worker who signs
   * in on a fresh device recovers their workerId from the chain instead --
   * WebAuthn assertions never return the public key.
   */
  pubkey?: PubKey;
};

const STORAGE_KEY = "swarm.identity";

// --- action tags, mirroring TaskPool's bytes32 constants -------------------

const ACTION_REGISTER = keccak256(toBytes("swarm.register"));
const ACTION_LABEL = keccak256(toBytes("swarm.label"));
const ACTION_WITHDRAW = keccak256(toBytes("swarm.withdraw"));

export function registerChallenge(pk: PubKey, credentialHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [BigInt(chain.id), TASK_POOL, ACTION_REGISTER, pk.x, pk.y, credentialHash]
    )
  );
}

/** Stable on-chain handle for a passkey, derived from its credential id. */
export function credentialHashOf(credentialId: string): Hex {
  return keccak256(fromB64url(credentialId));
}

export function labelChallenge(
  taskId: bigint,
  itemId: bigint,
  answer: number
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint8" },
      ],
      [BigInt(chain.id), TASK_POOL, ACTION_LABEL, taskId, itemId, answer]
    )
  );
}

export function withdrawChallenge(to: Hex, nonce: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
      ],
      [BigInt(chain.id), TASK_POOL, ACTION_WITHDRAW, to, nonce]
    )
  );
}

export function workerIdOf(pk: PubKey): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [pk.x, pk.y])
  );
}

// --- registration ----------------------------------------------------------

export function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.PublicKeyCredential &&
    !!navigator.credentials
  );
}

export function loadIdentity(): Identity | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return {
      credentialId: p.credentialId,
      workerId: p.workerId,
      pubkey: p.x && p.y ? { x: BigInt(p.x), y: BigInt(p.y) } : undefined,
    };
  } catch {
    return null;
  }
}

export function saveIdentity(id: Identity) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      credentialId: id.credentialId,
      x: id.pubkey?.x.toString(),
      y: id.pubkey?.y.toString(),
      workerId: id.workerId,
    })
  );
}

export function clearIdentity() {
  localStorage.removeItem(STORAGE_KEY);
}

/** Creates a passkey and derives the worker identity from its public key. */
export async function createIdentity(label = "Swarm worker"): Promise<Identity> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Swarm" },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: label,
        displayName: label,
      },
      // -7 is ES256: ECDSA over P256 with SHA-256. This is the only algorithm
      // the on-chain verifier understands, so we do not offer alternatives.
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        // Discoverable, so the passkey can be found later without us having
        // to remember its id. This is what makes sign-in work on a device
        // that has never seen this site before.
        residentKey: "required",
        userVerification: "required",
      },
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!cred) throw new Error("Passkey creation was cancelled");

  const response = cred.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey();
  if (!spki) throw new Error("Authenticator did not return a public key");

  const pubkey = pubkeyFromSpki(new Uint8Array(spki));
  const identity: Identity = {
    credentialId: b64url(new Uint8Array(cred.rawId)),
    pubkey,
    workerId: workerIdOf(pubkey),
  };

  saveIdentity(identity);
  return identity;
}

/**
 * Signs in with an existing passkey.
 *
 * Assertions return the credential id but never the public key, so the
 * workerId cannot be derived locally. The caller looks it up on-chain via
 * `workerOf(credentialHash)` -- which is why registration records that
 * mapping. Without this, clearing browser storage would orphan a worker from
 * money they had already earned.
 */
export async function signInWithPasskey(): Promise<{
  credentialId: string;
  credentialHash: Hex;
}> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)) as BufferSource,
      userVerification: "required",
      timeout: 60_000,
      // No allowCredentials: let the authenticator offer whatever Swarm
      // passkeys it holds.
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error("Sign-in was cancelled");

  const credentialId = b64url(new Uint8Array(assertion.rawId));
  return { credentialId, credentialHash: credentialHashOf(credentialId) };
}

/**
 * Extracts the raw (x, y) point from a SubjectPublicKeyInfo DER blob.
 * For P256 the uncompressed point is always the trailing 65 bytes, prefixed
 * with 0x04.
 */
function pubkeyFromSpki(spki: Uint8Array): PubKey {
  const point = spki.subarray(spki.length - 65);
  if (point[0] !== 0x04) {
    throw new Error("Unexpected public key encoding (not an uncompressed point)");
  }
  return {
    x: bytesToBigInt(point.subarray(1, 33)),
    y: bytesToBigInt(point.subarray(33, 65)),
  };
}

// --- signing ---------------------------------------------------------------

/** Prompts Face ID and returns an assertion the contract can verify. */
export async function sign(
  challenge: Hex,
  credentialId?: string
): Promise<WebAuthnSignature> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: hexToBytes(challenge) as BufferSource,
      userVerification: "required",
      timeout: 60_000,
      ...(credentialId
        ? {
            allowCredentials: [
              {
                type: "public-key" as const,
                id: fromB64url(credentialId) as BufferSource,
              },
            ],
          }
        : {}),
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error("Signature was cancelled");

  const res = assertion.response as AuthenticatorAssertionResponse;
  const authenticatorData = new Uint8Array(res.authenticatorData);
  const clientDataJSON = new Uint8Array(res.clientDataJSON);
  const { r, s } = parseDerSignature(new Uint8Array(res.signature));

  return {
    authenticatorData: toHex(authenticatorData),
    clientDataJSON: toHex(clientDataJSON),
    challengeIndex: BigInt(findChallengeIndex(clientDataJSON)),
    r,
    // Canonicalise to low-s. (r, s) and (r, n-s) are both valid ECDSA
    // signatures; the contract rejects the high variant so one authorisation
    // cannot be presented twice wearing a different hat.
    s: s > P256_N / 2n ? P256_N - s : s,
  };
}

/**
 * WebAuthn returns ECDSA signatures DER-encoded:
 *   30 <len> 02 <rlen> <r> 02 <slen> <s>
 * with each integer minimally encoded, so a leading 0x00 appears whenever the
 * high bit would otherwise make the value look negative.
 */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30) throw new Error("Malformed DER signature");

  let offset = 2;
  if (der[offset] !== 0x02) throw new Error("Malformed DER signature (r)");
  const rLen = der[offset + 1];
  const r = bytesToBigInt(der.subarray(offset + 2, offset + 2 + rLen));

  offset = offset + 2 + rLen;
  if (der[offset] !== 0x02) throw new Error("Malformed DER signature (s)");
  const sLen = der[offset + 1];
  const s = bytesToBigInt(der.subarray(offset + 2, offset + 2 + sLen));

  return { r, s };
}

/**
 * Byte offset of the base64url challenge value inside clientDataJSON.
 * Searched over raw bytes rather than a decoded string, because the contract
 * indexes bytes and a multi-byte character in `origin` would desynchronise a
 * string index.
 */
export function findChallengeIndex(clientDataJSON: Uint8Array): number {
  const needle = new TextEncoder().encode('"challenge":"');
  outer: for (let i = 0; i + needle.length <= clientDataJSON.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (clientDataJSON[i + j] !== needle[j]) continue outer;
    }
    return i + needle.length;
  }
  throw new Error("No challenge field in clientDataJSON");
}

// --- byte helpers ----------------------------------------------------------

function bytesToBigInt(b: Uint8Array): bigint {
  let out = 0n;
  for (const byte of b) out = (out << 8n) | BigInt(byte);
  return out;
}

function toHex(b: Uint8Array): Hex {
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function b64url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Serialises a signature for JSON transport to the relayer. */
export function serializeSignature(sig: WebAuthnSignature) {
  return {
    authenticatorData: sig.authenticatorData,
    clientDataJSON: sig.clientDataJSON,
    challengeIndex: sig.challengeIndex.toString(),
    r: sig.r.toString(),
    s: sig.s.toString(),
  };
}
