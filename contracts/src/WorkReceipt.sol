// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base64} from "./Base64.sol";

/// @title WorkReceipt -- a proof-of-work receipt, minted on cash-out
/// @notice Stablecoin payouts are invisible in a wallet until the token is
///         manually imported, which makes a real payment feel like nothing
///         happened. An NFT lands in the same address and shows up on its own,
///         so a worker has something to see -- and something to share.
///
/// @dev Deliberately minimal ERC-721: mintable only by the TaskPool, and the
///      artwork is generated on-chain, so nothing external has to stay alive
///      for the token to keep rendering.
contract WorkReceipt {
    string public constant name = "Swarm Work Receipt";
    string public constant symbol = "SWARM";

    /// @notice The only address allowed to mint. Set once, at deployment.
    address public immutable pool;

    struct Receipt {
        uint128 amount; // paid out, in the payout token's decimals
        uint64 answers; // lifetime answers at time of cash-out
        uint64 timestamp;
    }

    uint256 public totalSupply;
    mapping(uint256 tokenId => address) private _ownerOf;
    mapping(uint256 tokenId => Receipt) public receiptOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 tokenId => address) private _approved;
    mapping(address => mapping(address => bool)) private _operators;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    error NotPool();
    error NotOwner();
    error NoToken();
    error BadRecipient();

    constructor(address _pool) {
        pool = _pool;
    }

    function mint(address to, uint256 amount, uint256 answers) external returns (uint256 tokenId) {
        if (msg.sender != pool) revert NotPool();
        if (to == address(0)) revert BadRecipient();

        unchecked {
            tokenId = ++totalSupply;
            _balanceOf[to]++;
        }
        _ownerOf[tokenId] = to;
        receiptOf[tokenId] =
            Receipt(uint128(amount), uint64(answers), uint64(block.timestamp));

        emit Transfer(address(0), to, tokenId);
    }

    // ---------------------------------------------------------------------
    // Metadata, generated entirely on-chain
    // ---------------------------------------------------------------------

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_ownerOf[tokenId] == address(0)) revert NoToken();
        Receipt memory r = receiptOf[tokenId];

        string memory paid = _decimal(r.amount);
        string memory answers = _toString(r.answers);

        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">',
            '<rect width="400" height="400" fill="#09090b"/>',
            '<text x="32" y="72" fill="#fafafa" font-family="monospace" font-size="30">Swarm</text>',
            '<text x="32" y="100" fill="#71717a" font-family="monospace" font-size="13">proof of work</text>',
            '<text x="32" y="210" fill="#34d399" font-family="monospace" font-size="52">$',
            paid,
            "</text>",
            '<text x="32" y="248" fill="#a1a1aa" font-family="monospace" font-size="15">',
            answers,
            " answers, paid on Monad</text>",
            '<text x="32" y="356" fill="#52525b" font-family="monospace" font-size="12">receipt #',
            _toString(tokenId),
            "</text>",
            '<text x="32" y="376" fill="#52525b" font-family="monospace" font-size="12">every answer signed by a passkey</text>',
            "</svg>"
        );

        string memory json = string.concat(
            '{"name":"Swarm Receipt #',
            _toString(tokenId),
            '","description":"Earned by answering micro-tasks on Swarm and cashed out on Monad. Every answer was authorised by a passkey and verified on-chain at precompile 0x0100.","attributes":[{"trait_type":"Paid out","value":"',
            paid,
            '"},{"trait_type":"Answers","value":',
            answers,
            '}],"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '"}'
        );

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @dev Renders a 6-decimal amount as a human string, e.g. 50000 -> "0.05".
    function _decimal(uint256 amount) private pure returns (string memory) {
        uint256 whole = amount / 1e6;
        uint256 frac = (amount % 1e6) / 1e4; // two decimal places
        return string.concat(
            _toString(whole), ".", frac < 10 ? "0" : "", _toString(frac)
        );
    }

    // ---------------------------------------------------------------------
    // ERC-721 core
    // ---------------------------------------------------------------------

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _ownerOf[tokenId];
        if (owner == address(0)) revert NoToken();
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balanceOf[owner];
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _approved[tokenId];
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operators[owner][operator];
    }

    function approve(address spender, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && !isApprovedForAll(owner, msg.sender)) revert NotOwner();
        _approved[tokenId] = spender;
        emit Approval(owner, spender, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (from != ownerOf(tokenId)) revert NotOwner();
        if (to == address(0)) revert BadRecipient();
        if (
            msg.sender != from && msg.sender != _approved[tokenId]
                && !isApprovedForAll(from, msg.sender)
        ) revert NotOwner();

        unchecked {
            _balanceOf[from]--;
            _balanceOf[to]++;
        }
        _ownerOf[tokenId] = to;
        delete _approved[tokenId];

        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata) external {
        transferFrom(from, to, tokenId);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 // ERC165
            || id == 0x80ac58cd // ERC721
            || id == 0x5b5e139f; // ERC721Metadata
    }

    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        for (uint256 t = v; t != 0; t /= 10) digits++;
        bytes memory buf = new bytes(digits);
        while (v != 0) {
            buf[--digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }
}
