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
        // createTask is FirstCome with quorum 1; the shared tests answer each
        // item once, which is exactly that.
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

        assertEq(usd.balanceOf(cashOut), REWARD * 10, "one ledger, one payout");

        // Wallet workers collect their receipt when they finish a task, so
        // cashing out does not mint a second one.
        assertEq(receiptId, 0, "no duplicate receipt on cash-out");
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
    // Requester side: post a task, read the dataset back out
    // ---------------------------------------------------------------------

    string internal constant SPEC =
        '{"title":"Sentiment","question":"Positive?","answers":{"0":"No","1":"Yes"},"items":[{"id":0,"text":"great"},{"id":1,"text":"awful"}]}';

    function _postTask(uint128 amount, uint32 items) internal returns (uint256) {
        return _postTask(amount, items, TaskPool.Mode.FirstCome, 1);
    }

    function _postTask(uint128 amount, uint32 items, TaskPool.Mode mode, uint8 quorum)
        internal
        returns (uint256)
    {
        address poster = vm.addr(WALLET_PK);
        bytes32 d = pool.postDigest(SPEC, REWARD, amount, items, uint8(mode), quorum);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WALLET_PK, d);
        return pool.postTaskSponsored(
            SPEC, REWARD, amount, items, uint8(mode), quorum, poster, abi.encodePacked(r, s, v)
        );
    }

    function test_PostTask_IsVisibleOnChain() public {
        uint256 id = _postTask(1_000_000, 2);

        // A worker anywhere can read the whole task off the chain -- no server
        // in the middle, nothing to keep running.
        assertEq(pool.taskSpec(id), SPEC, "spec is readable on-chain");
        assertEq(pool.itemCount(id), 2);
        assertEq(pool.tasks(id).requester, vm.addr(WALLET_PK));
        assertEq(pool.remaining(id), 1_000_000, "pool funded on creation");
    }

    function test_PostTask_RevertWhen_SignatureIsFromSomeoneElse() public {
        bytes32 d = pool.postDigest(SPEC, REWARD, 1_000_000, 2, 0, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, d);

        vm.expectRevert(TaskPool.BadSignature.selector);
        pool.postTaskSponsored(
            SPEC, REWARD, 1_000_000, 2, 0, 1, vm.addr(WALLET_PK), abi.encodePacked(r, s, v)
        );
    }

    function test_Results_AreTheLabelledDataset() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 2);
        address wallet = vm.addr(WALLET_PK);

        // Two workers disagree on item 0 and agree on item 1.
        pool.submitLabelFor(id, 0, 1, wallet, _signEoa(pool.labelDigest(id, 0, 1)));
        pool.submitLabelFor(id, 1, 0, wallet, _signEoa(pool.labelDigest(id, 1, 0)));

        WebAuthn.Signature memory sig = _sign(pool.labelChallenge(id, 0, 0));
        pool.submitLabel(id, 0, 0, workerId, sig);

        (uint32[] memory zeros, uint32[] memory ones) = pool.results(id);
        assertEq(zeros[0], 1, "one worker said no on item 0");
        assertEq(ones[0], 1, "one worker said yes on item 0");
        assertEq(zeros[1], 1, "item 1 answered once");
        assertEq(ones[1], 0);
    }

    // ---------------------------------------------------------------------
    // Task modes: the three kinds of work pay differently on purpose
    // ---------------------------------------------------------------------

    uint256 internal constant PK_A = 0xA;
    uint256 internal constant PK_B = 0xB;
    uint256 internal constant PK_C = 0xC;

    function _answerAs(uint256 pk, uint256 task, uint256 item, uint8 ans) internal {
        address who = vm.addr(pk);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, pool.labelDigest(task, item, ans));
        pool.submitLabelFor(task, item, ans, who, abi.encodePacked(r, s, v));
    }

    function _earnedBy(uint256 pk) internal view returns (uint256) {
        return pool.earned(pool.idOfAddress(vm.addr(pk)));
    }

    // --- Majority ---------------------------------------------------------

    function test_Majority_PaysNobodyUntilQuorum() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.Majority, 3);

        _answerAs(PK_A, id, 0, 1);
        _answerAs(PK_B, id, 0, 1);

        // Two of three in: the item is unresolved, so nothing is owed yet.
        assertFalse(pool.resolved(id, 0));
        assertEq(_earnedBy(PK_A), 0, "held until the crowd has spoken");
        assertEq(_earnedBy(PK_B), 0);
        assertEq(pool.totalPaid(), 0);
    }

    function test_Majority_PaysOnlyTheMajority() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.Majority, 3);

        _answerAs(PK_A, id, 0, 1); // with the crowd
        _answerAs(PK_B, id, 0, 1); // with the crowd
        _answerAs(PK_C, id, 0, 0); // against it

        assertTrue(pool.resolved(id, 0), "quorum reached, item settles");
        assertEq(_earnedBy(PK_A), REWARD, "agreed with the majority");
        assertEq(_earnedBy(PK_B), REWARD, "agreed with the majority");
        assertEq(_earnedBy(PK_C), 0, "disagreed, so earned nothing");
        assertEq(pool.totalPaid(), REWARD * 2, "the odd one out is not paid for");
    }

    function test_Majority_MinorityStillCannotReanswer() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.Majority, 3);
        _answerAs(PK_A, id, 0, 1);
        _answerAs(PK_B, id, 0, 1);
        _answerAs(PK_C, id, 0, 0);

        address who = vm.addr(PK_C);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(PK_C, pool.labelDigest(id, 0, 1));

        // Losing the vote must not become a free retry.
        vm.expectRevert(TaskPool.AlreadyLabeled.selector);
        pool.submitLabelFor(id, 0, 1, who, abi.encodePacked(r, sg, v));
    }

    function test_Majority_RevertWhen_ItemIsFull() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.Majority, 2);
        _answerAs(PK_A, id, 0, 1);
        _answerAs(PK_B, id, 0, 1);

        address who = vm.addr(PK_C);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(PK_C, pool.labelDigest(id, 0, 1));

        // The requester asked for two opinions and has two.
        vm.expectRevert(TaskPool.ItemFull.selector);
        pool.submitLabelFor(id, 0, 1, who, abi.encodePacked(r, sg, v));
    }

    // --- FirstCome --------------------------------------------------------

    function test_FirstCome_PaysImmediately() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 2);

        _answerAs(PK_A, id, 0, 1);
        assertEq(_earnedBy(PK_A), REWARD, "objective work pays on the spot");

        // Disagreeing costs nothing here: the task is not a judgement call.
        _answerAs(PK_B, id, 0, 0);
        assertEq(_earnedBy(PK_B), REWARD);
    }

    function test_FirstCome_StopsAtQuorum() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 1);
        _answerAs(PK_A, id, 0, 1);

        address who = vm.addr(PK_B);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(PK_B, pool.labelDigest(id, 0, 1));

        vm.expectRevert(TaskPool.ItemFull.selector);
        pool.submitLabelFor(id, 0, 1, who, abi.encodePacked(r, sg, v));
    }

    // --- Survey -----------------------------------------------------------

    function _answerSurvey(uint256 pk, uint256 task, uint256 item, string memory text) internal {
        address who = vm.addr(pk);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, pool.surveyDigest(task, item, text));
        pool.submitSurveyFor(task, item, text, who, abi.encodePacked(r, s, v));
    }

    function test_Survey_PaysOnlyOnCompletion() public {
        uint256 id = _postTask(1_000_000, 3, TaskPool.Mode.Survey, 1);

        _answerSurvey(PK_A, id, 0, "Mostly the price.");
        assertEq(_earnedBy(PK_A), 0, "a half-finished survey is worth nothing");

        _answerSurvey(PK_A, id, 1, "Twice a week.");
        assertEq(_earnedBy(PK_A), 0, "still not finished");

        _answerSurvey(PK_A, id, 2, "I would recommend it.");
        assertEq(_earnedBy(PK_A), REWARD * 3, "paid for the whole response at once");
    }

    function test_Survey_RespondentsAreEnumerable() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.Survey, 1);
        _answerSurvey(PK_A, id, 0, "first answer");
        assertEq(pool.respondentCount(id), 0, "not listed until finished");

        _answerSurvey(PK_A, id, 1, "second answer");
        assertEq(pool.respondentCount(id), 1, "listed on completion");
        assertEq(pool.respondents(id)[0], pool.idOfAddress(vm.addr(PK_A)));

        // A requester with no way to enumerate responses cannot read what they
        // paid for, so this is the difference between a survey and a void.
        _answerSurvey(PK_B, id, 0, "b first");
        _answerSurvey(PK_B, id, 1, "b second");
        assertEq(pool.respondentCount(id), 2);
    }

    function test_Survey_ResponseIsReadableByTheRequester() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.Survey, 1);
        _answerSurvey(PK_A, id, 0, "Because it was cheaper.");
        _answerSurvey(PK_A, id, 1, "About six months.");

        string[] memory answers = pool.surveyResponse(id, pool.idOfAddress(vm.addr(PK_A)));
        assertEq(answers[0], "Because it was cheaper.");
        assertEq(answers[1], "About six months.");
    }

    function test_Survey_RevertWhen_AnswerIsEmpty() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.Survey, 1);
        address who = vm.addr(PK_A);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(PK_A, pool.surveyDigest(id, 0, ""));

        vm.expectRevert(TaskPool.EmptyAnswer.selector);
        pool.submitSurveyFor(id, 0, "", who, abi.encodePacked(r, sg, v));
    }

    function test_Survey_RevertWhen_TextIsTamperedWith() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.Survey, 1);
        address who = vm.addr(PK_A);

        // Signed one answer, submitted another.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK_A, pool.surveyDigest(id, 0, "yes"));

        vm.expectRevert(TaskPool.BadSignature.selector);
        pool.submitSurveyFor(id, 0, "no", who, abi.encodePacked(r, s, v));
    }

    function test_Survey_RevertWhen_UsedAsALabellingTask() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.Survey, 1);
        address who = vm.addr(PK_A);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(PK_A, pool.labelDigest(id, 0, 1));

        vm.expectRevert(TaskPool.WrongMode.selector);
        pool.submitLabelFor(id, 0, 1, who, abi.encodePacked(r, sg, v));
    }

    function test_Labelling_RevertWhen_UsedAsASurvey() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.Majority, 3);
        address who = vm.addr(PK_A);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(PK_A, pool.surveyDigest(id, 0, "whatever"));

        vm.expectRevert(TaskPool.WrongMode.selector);
        pool.submitSurveyFor(id, 0, "whatever", who, abi.encodePacked(r, sg, v));
    }

    // --- bounding boxes (bounty labelling) --------------------------------

    function _pack(uint16 x, uint16 y, uint16 w, uint16 h) internal pure returns (uint64) {
        return (uint64(x) << 48) | (uint64(y) << 32) | (uint64(w) << 16) | uint64(h);
    }

    function _one(uint64 box) internal pure returns (uint64[] memory a) {
        a = new uint64[](1);
        a[0] = box;
    }

    function _drawBox(uint256 pk, uint256 task, uint256 item, uint64 box) internal {
        _drawBoxes(pk, task, item, _one(box));
    }

    function _drawBoxes(uint256 pk, uint256 task, uint256 item, uint64[] memory bs) internal {
        address who = vm.addr(pk);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(pk, pool.boxDigest(task, item, bs));
        pool.submitBoxesFor(task, item, bs, who, abi.encodePacked(r, sg, v));
    }

    function test_Box_IsStoredAndPaidFirstCome() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 1);
        uint64 box = _pack(1000, 2000, 3000, 4000);

        _drawBox(PK_A, id, 0, box);

        bytes32 wid = pool.idOfAddress(vm.addr(PK_A));
        assertEq(pool.boxesOf(id, 0, wid)[0], box, "the box itself is recorded");
        assertEq(pool.earned(wid), REWARD, "a bounty pays on submission");
    }

    function test_Box_ZeroMeansNothingHereAndStillPays() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 1);
        _drawBox(PK_A, id, 0, 0);

        bytes32 wid = pool.idOfAddress(vm.addr(PK_A));
        assertEq(pool.boxesOf(id, 0, wid).length, 0, "no boxes recorded");
        // "There is no car in this image" is a real answer and worth paying
        // for; not paying it would teach workers to invent boxes.
        assertEq(pool.earned(wid), REWARD, "an honest negative is paid");
        assertEq(pool.tally(id, 0, 0), 1, "counted as 'nothing here'");
    }

    function test_Box_RevertWhen_CoordinatesAreTamperedWith() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 1);
        address who = vm.addr(PK_A);
        (uint8 v, bytes32 r, bytes32 sg) =
            vm.sign(PK_A, pool.boxDigest(id, 0, _one(_pack(10, 10, 100, 100))));

        vm.expectRevert(TaskPool.BadSignature.selector);
        pool.submitBoxesFor(id, 0, _one(_pack(50, 50, 900, 900)), who, abi.encodePacked(r, sg, v));
    }

    function test_Box_ClosesTheItemAtQuorum() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 1);
        _drawBox(PK_A, id, 0, _pack(1, 2, 3, 4));

        address who = vm.addr(PK_B);
        uint64[] memory bs = _one(_pack(5, 6, 7, 8));
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(PK_B, pool.boxDigest(id, 0, bs));

        // First come, first served: the bounty on this image is gone.
        vm.expectRevert(TaskPool.ItemFull.selector);
        pool.submitBoxesFor(id, 0, bs, who, abi.encodePacked(r, sg, v));
    }

    function test_Box_SeveralBoxesOnOneImage() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 1);
        uint64[] memory three = new uint64[](3);
        three[0] = _pack(100, 100, 500, 500);
        three[1] = _pack(2000, 1500, 800, 600);
        three[2] = _pack(6000, 3000, 900, 700);

        _drawBoxes(PK_A, id, 0, three);

        bytes32 wid = pool.idOfAddress(vm.addr(PK_A));
        uint64[] memory stored = pool.boxesOf(id, 0, wid);
        // A street scene holds more than one car; one box per image would
        // force the worker to pick a favourite and short the requester.
        assertEq(stored.length, 3, "every box is kept");
        assertEq(stored[1], three[1]);
        assertEq(pool.earned(wid), REWARD, "still one payment for the image");
    }

    function test_Receipt_RecordsThisTaskNotTheCareer() public {
        WorkReceipt receipts = pool.receipts();
        address who = vm.addr(PK_A);

        uint256 first = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 1);
        _drawBox(PK_A, first, 0, _pack(1, 1, 100, 100));
        _drawBox(PK_A, first, 1, _pack(1, 1, 100, 100));

        uint256 second = _postTask(1_000_000, 1, TaskPool.Mode.FirstCome, 1);
        _drawBox(PK_A, second, 0, _pack(1, 1, 100, 100));

        (uint128 a1, uint64 n1,) = receipts.receiptOf(1);
        (uint128 a2, uint64 n2,) = receipts.receiptOf(2);

        assertEq(a1, REWARD * 2, "first receipt: what the first task paid");
        assertEq(n1, 2);
        // The second must not read as the running total; it is a receipt for
        // one job, not a statement of the account.
        assertEq(a2, REWARD, "second receipt: only the second task");
        assertEq(n2, 1);

        assertEq(receipts.kindOf(1), "Image bounty", "says what the work was");
    }

    function test_Receipt_SaysSurveyForSurveys() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.Survey, 1);
        _answerSurvey(PK_A, id, 0, "one");
        _answerSurvey(PK_A, id, 1, "two");

        assertEq(pool.receipts().kindOf(1), "Survey");
    }

    function test_Box_ParticipantsAreTrackedForExport() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 2);
        _drawBox(PK_A, id, 0, _pack(1, 2, 3, 4));
        _drawBox(PK_B, id, 0, _pack(5, 6, 7, 8));
        _drawBox(PK_A, id, 1, _pack(9, 9, 9, 9));

        // A bounty worker never "completes" a task, so the survey respondent
        // list would leave their boxes unreadable.
        assertEq(pool.participants(id).length, 2, "each worker listed once");
        assertEq(pool.respondents(id).length, 0, "not a survey");
    }

    function test_Box_ExportsForEveryWorker() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 2);
        _drawBox(PK_A, id, 0, _pack(100, 200, 300, 400));
        _drawBox(PK_B, id, 0, _pack(110, 210, 310, 410));
        _drawBox(PK_A, id, 1, _pack(500, 500, 500, 500));

        bytes32[] memory ids = new bytes32[](2);
        ids[0] = pool.idOfAddress(vm.addr(PK_A));
        ids[1] = pool.idOfAddress(vm.addr(PK_B));

        uint32[] memory out = pool.boxCounts(id, ids);
        assertEq(out.length, 4, "two workers x two items");
        assertEq(out[0], 1);
        assertEq(out[1], 1);
        assertEq(out[2], 1);
        assertEq(out[3], 0, "worker B never answered item 1");
    }

    // --- completion receipts ----------------------------------------------

    function test_Receipt_MintsWhenTheWorkerFinishesATask() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 1);
        address who = vm.addr(PK_A);
        WorkReceipt receipts = pool.receipts();

        _answerAs(PK_A, id, 0, 1);
        assertEq(receipts.balanceOf(who), 0, "half a task earns no receipt");

        _answerAs(PK_A, id, 1, 0);
        assertEq(receipts.balanceOf(who), 1, "finishing the task mints one");
    }

    function test_Receipt_MintsOncePerTask() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 1);
        address who = vm.addr(PK_A);

        _answerAs(PK_A, id, 0, 1);
        _answerAs(PK_A, id, 1, 0);

        uint256 second = _postTask(1_000_000, 2, TaskPool.Mode.FirstCome, 1);
        _answerAs(PK_A, second, 0, 1);
        _answerAs(PK_A, second, 1, 1);

        assertEq(
            pool.receipts().balanceOf(who), 2, "one receipt per finished task"
        );
    }

    function test_Receipt_MintsOnSurveyCompletion() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.Survey, 1);
        address who = vm.addr(PK_A);

        _answerSurvey(PK_A, id, 0, "first");
        assertEq(pool.receipts().balanceOf(who), 0);

        _answerSurvey(PK_A, id, 1, "second");
        assertEq(pool.receipts().balanceOf(who), 1, "completed survey mints");
    }

    function test_Receipt_CashOutDoesNotMintAgainForWalletWorkers() public {
        uint256 id = _postTask(20_000_000, 12, TaskPool.Mode.FirstCome, 1);
        address who = vm.addr(PK_A);
        for (uint256 i = 0; i < 12; i++) _answerAs(PK_A, id, i, 1);

        uint256 afterTask = pool.receipts().balanceOf(who);
        assertEq(afterTask, 1);

        address cashOut = address(0xCA5);
        (uint8 v, bytes32 r, bytes32 sg) =
            vm.sign(PK_A, pool.withdrawDigest(who, cashOut));
        pool.withdrawFor(who, cashOut, abi.encodePacked(r, sg, v));

        assertEq(
            pool.receipts().balanceOf(who), afterTask, "no duplicate on cash-out"
        );
    }

    // --- escrow -----------------------------------------------------------

    function test_UnspentEscrowGoesBackToTheRequester() public {
        uint256 id = _postTask(1_000_000, 2, TaskPool.Mode.Majority, 3);
        _answerAs(PK_A, id, 0, 1);
        _answerAs(PK_B, id, 0, 1);
        _answerAs(PK_C, id, 0, 0);

        uint256 spent = REWARD * 2; // the minority was never paid for
        address poster = vm.addr(WALLET_PK);

        vm.prank(poster);
        pool.closeTask(id);

        assertEq(usd.balanceOf(poster), 1_000_000 - spent, "requester keeps what wasn't earned");
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
        // Grew from ~230k when task participants started being recorded: one
        // extra array push on a worker's first answer. That is the price of
        // being able to export who did the work, and worth paying.
        assertLt(used, 320_000, "a single label must stay cheap");
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
