// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {TaskPool, IERC20} from "../src/TaskPool.sol";
import {DemoUSD} from "../src/DemoUSD.sol";
import {WebAuthn} from "../src/WebAuthn.sol";

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
        _label(taskId, 0, 1);
        _label(taskId, 1, 0);

        address cashOut = address(0xCA5);
        uint256 owed = pool.balanceOf(workerId);

        WebAuthn.Signature memory sig = _sign(pool.withdrawChallenge(workerId, cashOut));
        pool.withdraw(workerId, cashOut, sig);

        assertEq(usd.balanceOf(cashOut), owed, "funds landed at chosen address");
        assertEq(pool.balanceOf(workerId), 0);
        assertEq(pool.earned(workerId), owed, "lifetime earnings preserved");
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
        _label(taskId, 0, 1);

        address cashOut = address(0xCA5);
        WebAuthn.Signature memory sig = _sign(pool.withdrawChallenge(workerId, cashOut));
        pool.withdraw(workerId, cashOut, sig);

        _label(taskId, 1, 1);

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
        WebAuthn.Signature memory sig = _sign(pool.registerChallenge(pk, CRED));
        return pool.registerWorker(pk, CRED, sig);
    }

    function _label(uint256 task, uint256 itemId, uint8 answer) internal {
        WebAuthn.Signature memory sig = _sign(pool.labelChallenge(task, itemId, answer));
        pool.submitLabel(task, itemId, answer, workerId, sig);
    }
}
