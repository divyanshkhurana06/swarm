// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal standard base64 encoder, used to inline token metadata as a
///         data URI so the NFT renders with no server, no IPFS and nothing to
///         keep alive after the hackathon.
library Base64 {
    bytes internal constant TABLE =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function encode(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";

        // 4 output characters per 3 input bytes, rounded up.
        uint256 encodedLen = 4 * ((data.length + 2) / 3);
        bytes memory result = new bytes(encodedLen);
        bytes memory table = TABLE;

        uint256 i;
        uint256 j;
        for (; i + 3 <= data.length; i += 3) {
            uint8 b0 = uint8(data[i]);
            uint8 b1 = uint8(data[i + 1]);
            uint8 b2 = uint8(data[i + 2]);
            result[j++] = table[b0 >> 2];
            result[j++] = table[((b0 & 0x03) << 4) | (b1 >> 4)];
            result[j++] = table[((b1 & 0x0f) << 2) | (b2 >> 6)];
            result[j++] = table[b2 & 0x3f];
        }

        uint256 remaining = data.length - i;
        if (remaining == 1) {
            uint8 b0 = uint8(data[i]);
            result[j++] = table[b0 >> 2];
            result[j++] = table[(b0 & 0x03) << 4];
            result[j++] = "=";
            result[j] = "=";
        } else if (remaining == 2) {
            uint8 b0 = uint8(data[i]);
            uint8 b1 = uint8(data[i + 1]);
            result[j++] = table[b0 >> 2];
            result[j++] = table[((b0 & 0x03) << 4) | (b1 >> 4)];
            result[j++] = table[(b1 & 0x0f) << 2];
            result[j] = "=";
        }

        return string(result);
    }
}
