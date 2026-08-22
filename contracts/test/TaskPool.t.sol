// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {TaskPool, IERC20} from "../src/TaskPool.sol";
import {DemoUSD} from "../src/DemoUSD.sol";
import {WebAuthn} from "../src/WebAuthn.sol";
import {WorkReceipt} from "../src/WorkReceipt.sol";

/// @dev Run with the P256 precompile enabled:
///        forge test --odyssey
///      Signatures come from a real P256 key via FFI (script/webauthn.js), so
///      these tests exercise the same bytes a phone would produce.
contract TaskPoolTest is Test {
    DemoUSD internal usd;
    TaskPool internal pool;

    address internal requester = address(0xBEEF);

    uint96 internal constant REWARD = 5_000; // 0.005 DUSD == half a cent
    uint128 internal constant FUNDING = 10_000_000; // 10 DUSD

    uint256 internal taskId;
    bytes32 internal workerId;

    function setUp() public {
        usd = new DemoUSD();
        pool = new TaskPool(IERC20(address(usd)));

        vm.startPrank(requester);
        usd.mint(requester, FUNDING);
        usd.approve(address(pool), type(uint256).max);
        taskId = pool.createTask("ipfs://manifest", REWARD, FUNDING);
        vm.stopPrank();

        workerId = _register();
    }

    // ---------------------------------------------------------------------
    // Happy path
    // ---------------------------------------------------------------------

    function test_RegisterWorker() public {
        assertTrue(pool.isRegistered(workerId), "worker should be registered");
        assertEq(pool.workerCount(), 1);

        WebAuthn.PubKey memory pk = _pubkey();
        assertEq(pool.pubkeyOf(workerId).x, pk.x);
        assertEq(pool.pubkeyOf(workerId).y, pk.y);

        // The identity must be recoverable from the passkey alone, so a
        // worker on a new device (or with cleared storage) is not orphaned
        // from money they already earned.
        assertEq(pool.workerOf(CRED), workerId, "credential must map to worker");
    }

    function test_SubmitLabel_PaysWorker() public {
        _label(taskId, 0, 1);

        assertEq(pool.earned(workerId), REWARD, "worker earned one reward");
        assertEq(pool.balanceOf(workerId), REWARD);
        assertEq(pool.totalLabels(), 1);
        assertEq(pool.totalPaid(), REWARD);
        assertEq(pool.remaining(taskId), FUNDING - REWARD);
    }

    function test_SubmitLabel_ManyItems() public {
        for (uint256 i = 0; i < 12; i++) {
            _label(taskId, i, uint8(i % 2));
        }

        assertEq(pool.earned(workerId), REWARD * 12);
        assertEq(pool.totalLabels(), 12);
    }

    function test_Withdraw_SweepsToChosenAddress() public {
        // Clear MIN_WITHDRAWAL (0.05) at 0.005 per answer.
        for (uint256 i = 0; i < 10; i++) _label(taskId, i, uint8(i % 2));

        address cashOut = address(0xCA5);
        uint256 owed = pool.balanceOf(workerId);

        WebAuthn.Signature memory sig = _sign(pool.withdrawChallenge(workerId, cashOut));
        pool.withdraw(workerId, cashOut, sig);

        assertEq(usd.balanceOf(cashOut), owed, "funds landed at chosen address");
        assertEq(pool.balanceOf(workerId), 0);
        assertEq(pool.earned(workerId), owed, "lifetime earnings preserved");
    }

    function test_RevertWhen_WithdrawalBelowMinimum() public {
        // One answer is 0.005; the minimum is 0.05.
        _label(taskId, 0, 1);

        address cashOut = address(0xCA5);
        WebAuthn.Signature memory sig = _sign(pool.withdrawChallenge(workerId, cashOut));

        vm.expectRevert(TaskPool.BelowMinimum.selector);
        pool.withdraw(workerId, cashOut, sig);
    }

    function test_Withdraw_MintsReceiptNft() public {
        for (uint256 i = 0; i < 10; i++) _label(taskId, i, uint8(i % 2));

        address cashOut = address(0xCA5);
        uint256 owed = pool.balanceOf(workerId);

        WebAuthn.Signature memory sig = _sign(pool.withdrawChallenge(workerId, cashOut));
        uint256 receiptId = pool.withdraw(workerId, cashOut, sig);

        WorkReceipt receipts = pool.receipts();
        assertEq(receipts.ownerOf(receiptId), cashOut, "receipt goes to the cash-out address");
        assertEq(receipts.balanceOf(cashOut), 1);

        (uint128 amount, uint64 answers,) = receipts.receiptOf(receiptId);
        assertEq(amount, owed, "receipt records what was paid");
        assertEq(answers, 10, "receipt records answers given");

        // Metadata is generated on-chain, so it keeps rendering with no server.
        string memory uri = receipts.tokenURI(receiptId);
        assertGt(bytes(uri).length, 100);
        assertEq(
            keccak256(bytes(_slice(uri, 0, 29))),
            keccak256("data:application/json;base64,"),
            "tokenURI must be a self-contained data URI"
        );
    }

    function _slice(string memory s, uint256 start, uint256 len)
        private
        pure
        returns (string memory)
    {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = b[start + i];
        return string(out);
    }

    // ---------------------------------------------------------------------
    // Embedded wallets (Google sign-in). Same ledger, different proof.
    // ---------------------------------------------------------------------

    uint256 internal constant WALLET_PK = 0xA11CE;

    function _signEoa(bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WALLET_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_EmbeddedWallet_EarnsWithoutRegistering() public {
        address wallet = vm.addr(WALLET_PK);

        // No registration ceremony: a social login has nothing to hang one off,
        // so the address is the identity from the first answer.
        pool.submitLabelFor(taskId, 0, 1, wallet, _signEoa(pool.labelDigest(taskId, 0, 1)));

        bytes32 id = pool.idOfAddress(wallet);
        assertTrue(pool.isRegistered(id), "first answer registers the worker");
        assertEq(pool.earned(id), REWARD);
        assertEq(pool.workerCount(), 2, "passkey worker from setUp, plus this one");
    }

    function test_EmbeddedWallet_SharesLedgerWithPasskeyWorkers() public {
        address wallet = vm.addr(WALLET_PK);
        for (uint256 i = 0; i < 10; i++) {
            pool.submitLabelFor(taskId, i, 1, wallet, _signEoa(pool.labelDigest(taskId, i, 1)));
        }
        _label(taskId, 20, 1); // passkey worker

        assertEq(pool.totalLabels(), 11, "one pool, one set of totals");

        address cashOut = address(0xCA5);
        uint256 receiptId = pool.withdrawFor(wallet, cashOut, _signEoa(pool.withdrawDigest(wallet, cashOut)));

        assertEq(usd.balanceOf(cashOut), REWARD * 10);
        assertEq(pool.receipts().ownerOf(receiptId), cashOut, "same receipt NFT either way");
    }

    function test_RevertWhen_EmbeddedWalletSignatureIsForAnotherAnswer() public {
        address wallet = vm.addr(WALLET_PK);
        // Signed "flag item 0", submitted as "fine on item 0".
        bytes memory sig = _signEoa(pool.labelDigest(taskId, 0, 1));

        vm.expectRevert(TaskPool.BadSignature.selector);
        pool.submitLabelFor(taskId, 0, 0, wallet, sig);
    }

    function test_RevertWhen_EmbeddedWalletSignatureIsFromSomeoneElse() public {
        address wallet = vm.addr(WALLET_PK);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, pool.labelDigest(taskId, 0, 1));

        vm.expectRevert(TaskPool.BadSignature.selector);
        pool.submitLabelFor(taskId, 0, 1, wallet, abi.encodePacked(r, s, v));
    }

    function test_RevertWhen_EmbeddedWalletWithdrawalIsReplayed() public {
        address wallet = vm.addr(WALLET_PK);
        for (uint256 i = 0; i < 10; i++) {
            pool.submitLabelFor(taskId, i, 1, wallet, _signEoa(pool.labelDigest(taskId, i, 1)));
        }

        address cashOut = address(0xCA5);
        bytes memory sig = _signEoa(pool.withdrawDigest(wallet, cashOut));
        pool.withdrawFor(wallet, cashOut, sig);

        for (uint256 i = 10; i < 20; i++) {
            pool.submitLabelFor(taskId, i, 1, wallet, _signEoa(pool.labelDigest(taskId, i, 1)));
        }

        vm.expectRevert(TaskPool.BadSignature.selector);
        pool.withdrawFor(wallet, cashOut, sig);
    }

    function test_WorkerIdsCannotCollideAcrossAuthMethods() public view {
        // Passkey ids are keccak256 of a public key; wallet ids are a padded
        // address. They share one ledger, so they must not overlap.
        bytes32 walletId = pool.idOfAddress(vm.addr(WALLET_PK));
        assertEq(uint256(walletId) >> 160, 0, "wallet ids occupy the low 160 bits");
        assertTrue(workerId != walletId);
    }

    // ---------------------------------------------------------------------
    // The security properties that actually matter
    // ---------------------------------------------------------------------

    function test_RevertWhen_SignatureIsOverDifferentChallenge() public {
        // A perfectly valid passkey signature -- just not for this action.
        WebAuthn.Signature memory sig = _signWrong();

        vm.expectRevert(TaskPool.BadSignature.selector);
        pool.submitLabel(taskId, 0, 1, workerId, sig);
    }

    function test_RevertWhen_AnswerIsTamperedWith() public {
        // Sign "yes" for item 0, then try to submit it as "no".
        WebAuthn.Signature memory sig = _sign(pool.labelChallenge(taskId, 0, 1));

        vm.expectRevert(TaskPool.BadSignature.selector);
        pool.submitLabel(taskId, 0, 0, workerId, sig);
    }

    function test_RevertWhen_LabelIsReplayed() public {
        WebAuthn.Signature memory sig = _sign(pool.labelChallenge(taskId, 0, 1));
        pool.submitLabel(taskId, 0, 1, workerId, sig);

        vm.expectRevert(TaskPool.AlreadyLabeled.selector);
        pool.submitLabel(taskId, 0, 1, workerId, sig);
    }

    function test_RevertWhen_WithdrawalIsReplayed() public {
        for (uint256 i = 0; i < 10; i++) _label(taskId, i, uint8(i % 2));

        address cashOut = address(0xCA5);
        WebAuthn.Signature memory sig = _sign(pool.withdrawChallenge(workerId, cashOut));
        pool.withdraw(workerId, cashOut, sig);

        for (uint256 i = 10; i < 20; i++) _label(taskId, i, uint8(i % 2));

        // The nonce moved, so the old assertion is dead.
        vm.expectRevert(TaskPool.BadSignature.selector);
        pool.withdraw(workerId, cashOut, sig);
    }

    function test_RevertWhen_HighSSignature() public {
        WebAuthn.Signature memory sig = _sign(pool.labelChallenge(taskId, 0, 1));
        // Flip s to its high-s twin. Cryptographically still a valid ECDSA
        // signature, but we reject it to keep authorisations canonical.
        sig.s = WebAuthn.P256_N - sig.s;

        vm.expectRevert(TaskPool.BadSignature.selector);
        pool.submitLabel(taskId, 0, 1, workerId, sig);
    }

    function test_RevertWhen_WorkerNotRegistered() public {
        bytes32 ghost = keccak256("nobody");
        WebAuthn.Signature memory sig = _sign(pool.labelChallenge(taskId, 0, 1));

        vm.expectRevert(TaskPool.NotRegistered.selector);
        pool.submitLabel(taskId, 0, 1, ghost, sig);
    }

    function test_RevertWhen_PoolExhausted() public {
        vm.startPrank(requester);
        usd.mint(requester, 2 * REWARD);
        uint256 small = pool.createTask("ipfs://small", REWARD, REWARD);
        vm.stopPrank();

        _label(small, 0, 1);

        WebAuthn.Signature memory sig = _sign(pool.labelChallenge(small, 1, 1));
        vm.expectRevert(TaskPool.PoolExhausted.selector);
        pool.submitLabel(small, 1, 1, workerId, sig);
    }

    function test_CloseTask_RefundsRemainder() public {
        _label(taskId, 0, 1);

        vm.prank(requester);
        pool.closeTask(taskId);

        assertEq(usd.balanceOf(requester), FUNDING - REWARD, "unearned funds returned");
    }

    // ---------------------------------------------------------------------
    // Cost -- the whole thesis is that this is cheap enough to do per action
    // ---------------------------------------------------------------------

    function test_GasCostOfOneLabel() public {
        WebAuthn.Signature memory sig = _sign(pool.labelChallenge(taskId, 0, 1));

        uint256 before = gasleft();
        pool.submitLabel(taskId, 0, 1, workerId, sig);
        uint256 used = before - gasleft();

        console.log("gas per passkey-authorised label:", used);
        assertLt(used, 250_000, "a single label must stay cheap");
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _pubkey() internal returns (WebAuthn.PubKey memory pk) {
        string[] memory cmd = new string[](3);
        cmd[0] = "node";
        cmd[1] = "script/webauthn.js";
        cmd[2] = "pubkey";
        (uint256 x, uint256 y) = abi.decode(vm.ffi(cmd), (uint256, uint256));
        pk = WebAuthn.PubKey(x, y);
    }

    function _sign(bytes32 challenge) internal returns (WebAuthn.Signature memory) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "script/webauthn.js";
        cmd[2] = "sign";
        cmd[3] = vm.toString(challenge);
        return _decode(vm.ffi(cmd));
    }

    function _signWrong() internal returns (WebAuthn.Signature memory) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "script/webauthn.js";
        cmd[2] = "sign-wrong";
        cmd[3] = vm.toString(bytes32(0));
        return _decode(vm.ffi(cmd));
    }

    function _decode(bytes memory raw) internal pure returns (WebAuthn.Signature memory sig) {
        (bytes memory authData, bytes memory clientData, uint256 idx, uint256 r, uint256 s) =
            abi.decode(raw, (bytes, bytes, uint256, uint256, uint256));
        sig = WebAuthn.Signature(authData, clientData, idx, r, s);
    }

    bytes32 internal constant CRED = keccak256("test-credential-id");

    function _register() internal returns (bytes32) {
        WebAuthn.PubKey memory pk = _pubkey();
        return pool.registerWorker(pk, CRED);
    }

    function _label(uint256 task, uint256 itemId, uint8 answer) internal {
        WebAuthn.Signature memory sig = _sign(pool.labelChallenge(task, itemId, answer));
        pool.submitLabel(task, itemId, answer, workerId, sig);
    }
}
