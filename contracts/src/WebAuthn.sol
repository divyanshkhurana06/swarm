// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title WebAuthn passkey signature verification for Monad
/// @notice Verifies a WebAuthn assertion (Face ID / Touch ID / Android Keystore)
///         entirely on-chain using Monad's native P256 precompile at 0x0100.
///
///         Passkeys sign over the secp256r1 (P256) curve, which the EVM cannot
///         verify natively -- `ecrecover` only understands secp256k1. A Solidity
///         P256 verifier costs ~300k gas, which makes per-action passkey auth
///         economically absurd. Monad exposes P256 verification as a precompile
///         (EIP-7951) at 6900 gas, which is what makes signing *every* user
///         action with a fingerprint viable.
///
/// @dev Precompile 0x0100 input is 160 bytes, big-endian: hash | r | s | qx | qy
///      Returns 32 bytes of `1` when valid, empty bytes when invalid.
library WebAuthn {
    /// @dev Monad's P256 (secp256r1) verification precompile. See
    ///      https://docs.monad.xyz/developer-essentials/precompiles
    address internal constant P256_VERIFY = address(0x0100);

    /// @dev Order of the secp256r1 curve.
    uint256 internal constant P256_N =
        0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    /// @dev n/2, used to reject malleable (high-s) signatures.
    uint256 internal constant P256_HALF_N =
        0x7FFFFFFF800000007FFFFFFFFFFFFFFFDE737D56D38BCF4279DCE5617E3192A8;

    /// @dev Bit 0 of the authenticatorData flags byte: "user present".
    bytes1 internal constant FLAG_USER_PRESENT = 0x01;

    /// @dev Base64url encoding of a 32-byte challenge is always 43 chars, unpadded.
    uint256 internal constant B64_CHALLENGE_LEN = 43;

    /// @dev The JSON key that must immediately precede the challenge value.
    ///      Checking this prevents an attacker from smuggling a matching string
    ///      into some other field of clientDataJSON.
    uint256 internal constant CHALLENGE_KEY_LEN = 13; // '"challenge":"'

    /// @notice A WebAuthn assertion, as returned by `navigator.credentials.get()`.
    /// @param authenticatorData Raw authenticator data from the assertion.
    /// @param clientDataJSON    Raw client data JSON from the assertion.
    /// @param challengeIndex    Byte offset of the first base64url challenge
    ///                          character inside `clientDataJSON`. Passed in so
    ///                          we never have to scan the JSON on-chain.
    /// @param r                 ECDSA signature r, decoded from DER off-chain.
    /// @param s                 ECDSA signature s, normalised to low-s off-chain.
    struct Signature {
        bytes authenticatorData;
        bytes clientDataJSON;
        uint256 challengeIndex;
        uint256 r;
        uint256 s;
    }

    /// @notice An uncompressed P256 public key, extracted from the passkey at
    ///         registration time. This is the worker's identity -- the matching
    ///         private key never leaves the phone's secure enclave.
    struct PubKey {
        uint256 x;
        uint256 y;
    }

    /// @notice Verify that `sig` is a passkey assertion over `challenge` by `pk`.
    /// @param challenge The 32-byte value the caller expects to have been signed.
    ///                  Callers MUST bind this to the specific action being
    ///                  authorised, or a signature can be replayed elsewhere.
    function verify(bytes32 challenge, Signature calldata sig, PubKey memory pk)
        internal
        view
        returns (bool)
    {
        // 1. authenticatorData is rpIdHash (32) | flags (1) | signCount (4).
        if (sig.authenticatorData.length < 37) return false;

        // Require the user to have been physically present. We deliberately do
        // not require the UV (user-verified) bit: some authenticators omit it,
        // and a failed demo is worse than a slightly weaker assertion. The
        // client requests userVerification: "required" regardless.
        if (sig.authenticatorData[32] & FLAG_USER_PRESENT == 0) return false;

        // 2. The signed clientDataJSON must actually contain our challenge.
        //    Without this the signature proves a passkey signed *something*,
        //    not that it authorised *this* action.
        if (!_challengeMatches(challenge, sig.clientDataJSON, sig.challengeIndex)) {
            return false;
        }

        // 3. Reject out-of-range and malleable signatures. (r, s) and (r, n-s)
        //    are both valid for the same message, so we canonicalise on low-s
        //    to stop the same authorisation being presented twice with a
        //    different-looking signature.
        if (sig.r == 0 || sig.r >= P256_N) return false;
        if (sig.s == 0 || sig.s > P256_HALF_N) return false;

        // 4. WebAuthn signs sha256(authenticatorData || sha256(clientDataJSON)).
        bytes32 messageHash =
            sha256(bytes.concat(sig.authenticatorData, sha256(sig.clientDataJSON)));

        // 5. Hand it to the precompile.
        (bool ok, bytes memory ret) =
            P256_VERIFY.staticcall(abi.encodePacked(messageHash, sig.r, sig.s, pk.x, pk.y));

        return ok && ret.length == 32 && bytes32(ret) == bytes32(uint256(1));
    }

    /// @dev Checks clientDataJSON contains `"challenge":"<base64url(challenge)>"`
    ///      starting at `idx`.
    function _challengeMatches(bytes32 challenge, bytes calldata json, uint256 idx)
        private
        pure
        returns (bool)
    {
        // The key must fit before idx, and the value must fit after it.
        if (idx < CHALLENGE_KEY_LEN) return false;
        if (idx + B64_CHALLENGE_LEN > json.length) return false;

        bytes memory key = '"challenge":"';
        for (uint256 i = 0; i < CHALLENGE_KEY_LEN; i++) {
            if (json[idx - CHALLENGE_KEY_LEN + i] != key[i]) return false;
        }

        bytes memory expected = _base64url(challenge);
        for (uint256 i = 0; i < B64_CHALLENGE_LEN; i++) {
            if (json[idx + i] != expected[i]) return false;
        }

        return true;
    }

    /// @dev Unpadded base64url of exactly 32 bytes -> exactly 43 characters.
    ///      Ten full 3-byte groups (30 bytes -> 40 chars), then a 2-byte tail
    ///      (-> 3 chars, padding stripped).
    function _base64url(bytes32 data) private pure returns (bytes memory out) {
        bytes memory t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        out = new bytes(B64_CHALLENGE_LEN);

        uint256 o;
        for (uint256 i = 0; i < 30; i += 3) {
            uint8 b0 = uint8(data[i]);
            uint8 b1 = uint8(data[i + 1]);
            uint8 b2 = uint8(data[i + 2]);
            out[o++] = t[b0 >> 2];
            out[o++] = t[((b0 & 0x03) << 4) | (b1 >> 4)];
            out[o++] = t[((b1 & 0x0f) << 2) | (b2 >> 6)];
            out[o++] = t[b2 & 0x3f];
        }

        uint8 c0 = uint8(data[30]);
        uint8 c1 = uint8(data[31]);
        out[o++] = t[c0 >> 2];
        out[o++] = t[((c0 & 0x03) << 4) | (c1 >> 4)];
        out[o] = t[(c1 & 0x0f) << 2];
    }
}
