// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal EIP-712 domain and signature recovery.
/// @dev Embedded wallets (Privy, and every other social-login wallet) sign
///      secp256k1 typed data, not WebAuthn assertions. Typed data is used
///      rather than a raw hash so the wallet can show the user what they are
///      actually authorising instead of an opaque blob.
library EIP712 {
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @dev Half the secp256k1 order; signatures above it are malleable.
    uint256 internal constant HALF_N =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function domainSeparator(string memory name, string memory version)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }

    function digest(bytes32 separator, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", separator, structHash));
    }

    /// @return signer Zero when the signature is malformed or malleable, so
    ///                callers must compare against an expected address rather
    ///                than assuming success.
    function recover(bytes32 hash, bytes memory signature) internal pure returns (address signer) {
        if (signature.length != 65) return address(0);

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }

        // Some wallets still emit the legacy 0/1 form.
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > HALF_N) return address(0);

        return ecrecover(hash, v, r, s);
    }
}
