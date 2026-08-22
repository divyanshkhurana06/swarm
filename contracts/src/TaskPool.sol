// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WebAuthn} from "./WebAuthn.sol";
import {EIP712} from "./EIP712.sol";
import {WorkReceipt} from "./WorkReceipt.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title TaskPool -- a human work market settled per task, on-chain
/// @notice A requester funds a pool of micro-tasks. Any human with a phone can
///         authenticate with a passkey (Face ID) and complete them, earning a
///         fraction of a cent per task, credited immediately.
///
///         The point of this contract is the *payment rail*, not the task type.
///         Every action is authorised by a P256 passkey signature verified
///         on-chain -- no wallet, no seed phrase, no signup. That is only
///         affordable because Monad verifies P256 in a precompile at 6900 gas.
///
/// @dev Earnings accrue to an internal ledger keyed by passkey public key, and
///      settle in a single `withdraw`. Transferring on every task would mean
///      paying ERC20 transfer gas hundreds of times to move a couple of dollars.
contract TaskPool {
    using WebAuthn for WebAuthn.Signature;

    /// @notice The asset workers are paid in. A stablecoin by design -- someone
    ///         earning half a cent per task cannot absorb price volatility
    ///         between earning and cashing out.
    IERC20 public immutable token;

    struct Task {
        address requester;
        uint96 rewardPerLabel;
        uint128 funded;
        uint128 paidOut;
        uint64 labelCount;
        bool open;
    }

    Task[] private _tasks;

    /// @notice Off-chain manifest of the items to be labelled, per task.
    mapping(uint256 taskId => string uri) public taskURI;

    /// @notice The task itself -- question, answer labels and every item --
    ///         stored as JSON on-chain.
    /// @dev A requester posts a task and a worker on the other side of the
    ///      world can see it with no server, no database and nothing to keep
    ///      running. Expensive per byte, and the right trade for a market that
    ///      would otherwise need a backend everyone has to trust.
    mapping(uint256 taskId => string) public taskSpec;

    /// @notice How many items a task contains, so results can be read back
    ///         without parsing the spec on-chain.
    mapping(uint256 taskId => uint32) public itemCount;

    /// @notice answers[taskId][itemId][answer] -- the labelled dataset itself.
    /// @dev Kept as a tally rather than reconstructed from events because the
    ///      public RPC caps eth_getLogs at a 100-block range, which makes
    ///      event-scraping a dataset unreliable the moment it matters.
    mapping(uint256 taskId => mapping(uint256 itemId => mapping(uint8 answer => uint32)))
        public tally;

    /// @notice Registered passkeys. `workerId` is keccak256(pubkey.x, pubkey.y).
    mapping(bytes32 workerId => WebAuthn.PubKey) private _pubkeys;
    mapping(bytes32 workerId => bool) public isRegistered;

    /// @notice keccak256(credentialId) => workerId.
    /// @dev A WebAuthn assertion returns the credential id but NOT the public
    ///      key, so a returning worker on a fresh device cannot derive their
    ///      own workerId from a signature alone. Recording the mapping here
    ///      makes the identity recoverable from the passkey itself, instead of
    ///      from browser storage that a cleared cache would destroy.
    mapping(bytes32 credentialHash => bytes32 workerId) public workerOf;

    /// @notice Lifetime earnings and lifetime withdrawals per worker. The
    ///         difference is the claimable balance; keeping both makes the
    ///         cumulative figure available to the dashboard.
    mapping(bytes32 workerId => uint256) public earned;
    mapping(bytes32 workerId => uint256) public withdrawn;

    /// @notice Replay protection for withdrawals, which have no natural dedup key.
    mapping(bytes32 workerId => uint256) public nonces;

    /// @notice One answer per worker per item. This is also what makes label
    ///         signatures non-replayable: a resubmitted signature hits this.
    mapping(uint256 taskId => mapping(bytes32 workerId => mapping(uint256 itemId => bool)))
        public hasLabeled;

    uint256 public totalLabels;
    uint256 public totalPaid;
    uint256 public workerCount;

    event TaskCreated(
        uint256 indexed taskId, address indexed requester, string uri, uint256 rewardPerLabel, uint256 funded
    );
    event TaskFunded(uint256 indexed taskId, uint256 amount);
    event TaskClosed(uint256 indexed taskId, uint256 refunded);
    event WorkerRegistered(bytes32 indexed workerId, uint256 x, uint256 y);
    event LabelSubmitted(
        uint256 indexed taskId,
        bytes32 indexed workerId,
        uint256 itemId,
        uint8 answer,
        uint256 reward,
        uint256 totalLabels
    );
    event Withdrawn(
        bytes32 indexed workerId, address indexed to, uint256 amount, uint256 receiptId
    );

    error BadSignature();
    error TaskNotOpen();
    error NotRegistered();
    error AlreadyLabeled();
    error PoolExhausted();
    error NothingToWithdraw();
    error NotRequester();
    error ZeroReward();
    error TransferFailed();
    error BelowMinimum();

    /// @notice Smallest cash-out, in the payout token's decimals (0.05 DUSD).
    /// @dev Sweeping a few cents costs more in gas than it moves, and a
    ///      dust-sized receipt NFT is not worth minting.
    uint256 public constant MIN_WITHDRAWAL = 50_000;

    /// @notice Receipts minted on cash-out.
    WorkReceipt public immutable receipts;

    /// @notice Lifetime answers per worker, stamped into the receipt.
    mapping(bytes32 workerId => uint64) public answersBy;

    constructor(IERC20 _token) {
        token = _token;
        receipts = new WorkReceipt(address(this));
    }

    // ---------------------------------------------------------------------
    // Requester side
    // ---------------------------------------------------------------------

    /// @notice Create a task and fund its reward pool up front.
    /// @param uri            Pointer to the manifest of items to label.
    /// @param rewardPerLabel Paid to the worker for each accepted answer.
    /// @param amount         Total deposited, pulled from msg.sender.
    function createTask(string calldata uri, uint96 rewardPerLabel, uint128 amount)
        external
        returns (uint256 taskId)
    {
        if (rewardPerLabel == 0) revert ZeroReward();

        taskId = _tasks.length;
        _tasks.push(
            Task({
                requester: msg.sender,
                rewardPerLabel: rewardPerLabel,
                funded: amount,
                paidOut: 0,
                labelCount: 0,
                open: true
            })
        );
        taskURI[taskId] = uri;

        _pull(msg.sender, amount);
        emit TaskCreated(taskId, msg.sender, uri, rewardPerLabel, amount);
    }

    bytes32 private constant POST_TYPEHASH =
        keccak256("PostTask(string spec,uint96 rewardPerLabel,uint128 amount,uint32 items)");

    function postDigest(
        string calldata spec,
        uint96 rewardPerLabel,
        uint128 amount,
        uint32 items
    ) public view returns (bytes32) {
        return EIP712.digest(
            domainSeparator(),
            keccak256(
                abi.encode(POST_TYPEHASH, keccak256(bytes(spec)), rewardPerLabel, amount, items)
            )
        );
    }

    /// @notice Post a task without holding gas or tokens.
    ///
    /// @dev A requester signs the task and a relayer submits it, so somebody
    ///      posting their first job never has to acquire MON first -- the same
    ///      argument that applies to workers.
    ///
    ///      TESTNET ONLY: the reward pool is minted rather than pulled from the
    ///      requester, because making them fund and approve a stablecoin
    ///      defeats the point of the demo. On mainnet this is `createTask`,
    ///      which pulls real USDC via transferFrom and is otherwise identical.
    function postTaskSponsored(
        string calldata spec,
        uint96 rewardPerLabel,
        uint128 amount,
        uint32 items,
        address requester,
        bytes calldata signature
    ) external returns (uint256 taskId) {
        if (rewardPerLabel == 0) revert ZeroReward();
        if (EIP712.recover(postDigest(spec, rewardPerLabel, amount, items), signature) != requester)
        {
            revert BadSignature();
        }

        taskId = _tasks.length;
        _tasks.push(
            Task({
                requester: requester,
                rewardPerLabel: rewardPerLabel,
                funded: amount,
                paidOut: 0,
                labelCount: 0,
                open: true
            })
        );
        taskSpec[taskId] = spec;
        itemCount[taskId] = items;

        IMintable(address(token)).mint(address(this), amount);
        emit TaskCreated(taskId, requester, "", rewardPerLabel, amount);
    }

    /// @notice The labelled dataset: how many workers chose each answer.
    /// @dev Returned as parallel arrays so a client can export the whole set
    ///      in one call rather than scraping logs.
    function results(uint256 taskId)
        external
        view
        returns (uint32[] memory zeros, uint32[] memory ones)
    {
        uint256 n = itemCount[taskId];
        zeros = new uint32[](n);
        ones = new uint32[](n);
        for (uint256 i = 0; i < n; i++) {
            zeros[i] = tally[taskId][i][0];
            ones[i] = tally[taskId][i][1];
        }
    }

    /// @notice Top up a task that is running dry mid-demo.
    function fundTask(uint256 taskId, uint128 amount) external {
        Task storage t = _tasks[taskId];
        if (!t.open) revert TaskNotOpen();
        t.funded += amount;
        _pull(msg.sender, amount);
        emit TaskFunded(taskId, amount);
    }

    /// @notice Close a task and refund whatever the crowd did not earn.
    function closeTask(uint256 taskId) external {
        Task storage t = _tasks[taskId];
        if (msg.sender != t.requester) revert NotRequester();
        if (!t.open) revert TaskNotOpen();

        t.open = false;
        uint256 refund = t.funded - t.paidOut;
        if (refund > 0) _push(t.requester, refund);
        emit TaskClosed(taskId, refund);
    }

    // ---------------------------------------------------------------------
    // Worker side
    // ---------------------------------------------------------------------

    /// @notice Register a passkey as a worker identity.
    ///
    /// @dev Registration deliberately does NOT require a signature.
    ///
    ///      iOS consumes the user gesture on a WebAuthn ceremony, so calling
    ///      `credentials.create()` and then `credentials.get()` to prove
    ///      possession fails with NotAllowedError on real phones. Registration
    ///      is therefore a single ceremony, and the public key is taken as
    ///      given.
    ///
    ///      This is safe for funds: registering a public key you do not
    ///      control grants nothing, because every subsequent action still
    ///      requires a signature from the matching private key. The residual
    ///      risk is griefing -- somebody could register a victim's public key
    ///      against their own credential hash, pointing that victim's sign-in
    ///      lookup at the wrong place. The victim keeps full control of their
    ///      funds and can still work and withdraw; only recovery-by-credential
    ///      is disrupted. Worth revisiting with a two-step flow that asks for
    ///      a second, separately-gestured tap.
    function registerWorker(WebAuthn.PubKey calldata pk, bytes32 credentialHash)
        external
        returns (bytes32 workerId)
    {
        workerId = idOf(pk);
        if (!isRegistered[workerId]) {
            _pubkeys[workerId] = pk;
            isRegistered[workerId] = true;
            unchecked {
                workerCount++;
            }
            emit WorkerRegistered(workerId, pk.x, pk.y);
        }
        // Always (re)point the credential lookup, so the same person signing in
        // from a second device resolves to the identity they already own.
        if (workerOf[credentialHash] == bytes32(0)) {
            workerOf[credentialHash] = workerId;
        }
    }

    /// @notice Submit one answer and get paid for it in the same transaction.
    /// @dev This is the hot path: one Face ID tap, one on-chain payment.
    function submitLabel(
        uint256 taskId,
        uint256 itemId,
        uint8 answer,
        bytes32 workerId,
        WebAuthn.Signature calldata sig
    ) external {
        if (!isRegistered[workerId]) revert NotRegistered();

        if (!WebAuthn.verify(labelChallenge(taskId, itemId, answer), sig, _pubkeys[workerId])) {
            revert BadSignature();
        }

        _credit(taskId, itemId, answer, workerId);
    }

    /// @dev Accounting shared by both authentication paths. Whether a worker
    ///      proved themselves with a passkey or an embedded wallet changes
    ///      nothing about what they are owed.
    function _credit(uint256 taskId, uint256 itemId, uint8 answer, bytes32 workerId) private {
        Task storage t = _tasks[taskId];
        if (!t.open) revert TaskNotOpen();
        if (hasLabeled[taskId][workerId][itemId]) revert AlreadyLabeled();

        uint256 reward = t.rewardPerLabel;
        if (t.funded - t.paidOut < reward) revert PoolExhausted();

        hasLabeled[taskId][workerId][itemId] = true;
        tally[taskId][itemId][answer]++;
        t.paidOut += uint128(reward);
        t.labelCount++;
        earned[workerId] += reward;
        answersBy[workerId]++;

        unchecked {
            totalLabels++;
            totalPaid += reward;
        }

        emit LabelSubmitted(taskId, workerId, itemId, answer, reward, totalLabels);
    }

    /// @notice Sweep everything earned to any address the worker names.
    /// @dev The passkey is the authority; the destination is chosen at cash-out
    ///      time, which is why a worker never needed a wallet to start earning.
    ///
    ///      A receipt NFT is minted to the same address. A stablecoin payout is
    ///      invisible in a wallet until the token is manually imported, which
    ///      makes a real payment feel like nothing happened; the NFT shows up
    ///      on its own.
    function withdraw(bytes32 workerId, address to, WebAuthn.Signature calldata sig)
        external
        returns (uint256 receiptId)
    {
        if (!isRegistered[workerId]) revert NotRegistered();

        if (!WebAuthn.verify(withdrawChallenge(workerId, to), sig, _pubkeys[workerId])) {
            revert BadSignature();
        }

        return _settle(workerId, to);
    }

    /// @dev Payout shared by both authentication paths.
    function _settle(bytes32 workerId, address to) private returns (uint256 receiptId) {
        uint256 amount = earned[workerId] - withdrawn[workerId];
        if (amount == 0) revert NothingToWithdraw();
        if (amount < MIN_WITHDRAWAL) revert BelowMinimum();

        unchecked {
            nonces[workerId]++;
        }
        withdrawn[workerId] += amount;
        _push(to, amount);

        receiptId = receipts.mint(to, amount, answersBy[workerId]);
        emit Withdrawn(workerId, to, amount, receiptId);
    }

    // ---------------------------------------------------------------------
    // Embedded-wallet workers (Google sign-in via Privy)
    //
    // A passkey is not the only way to be a person here. A social login backed
    // by an embedded wallet signs ordinary secp256k1 typed data, which needs no
    // registration ceremony at all: the address *is* the identity, so there is
    // nothing to look up and nothing to recover.
    //
    // Both paths share one ledger. `earned`, `withdrawn` and the receipt NFT do
    // not care how a worker proved they were themselves.
    // ---------------------------------------------------------------------

    bytes32 private constant LABEL_TYPEHASH =
        keccak256("Label(uint256 taskId,uint256 itemId,uint8 answer)");
    bytes32 private constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address to,uint256 nonce)");

    /// @notice Worker id for an address-based identity.
    /// @dev Left-padded address, so it can never collide with a passkey id
    ///      (keccak256 of a public key) in the shared ledger.
    function idOfAddress(address worker) public pure returns (bytes32) {
        return bytes32(uint256(uint160(worker)));
    }

    function domainSeparator() public view returns (bytes32) {
        return EIP712.domainSeparator("Swarm", "1");
    }

    function labelDigest(uint256 taskId, uint256 itemId, uint8 answer)
        public
        view
        returns (bytes32)
    {
        return EIP712.digest(
            domainSeparator(), keccak256(abi.encode(LABEL_TYPEHASH, taskId, itemId, answer))
        );
    }

    function withdrawDigest(address worker, address to) public view returns (bytes32) {
        return EIP712.digest(
            domainSeparator(),
            keccak256(abi.encode(WITHDRAW_TYPEHASH, to, nonces[idOfAddress(worker)]))
        );
    }

    /// @notice Submit an answer signed by an embedded wallet.
    /// @dev The worker is registered lazily on their first answer; a social
    ///      login has no separate registration step to hang it off.
    function submitLabelFor(
        uint256 taskId,
        uint256 itemId,
        uint8 answer,
        address worker,
        bytes calldata signature
    ) external {
        if (worker == address(0)) revert NotRegistered();
        if (EIP712.recover(labelDigest(taskId, itemId, answer), signature) != worker) {
            revert BadSignature();
        }

        bytes32 workerId = idOfAddress(worker);
        if (!isRegistered[workerId]) {
            isRegistered[workerId] = true;
            unchecked {
                workerCount++;
            }
            emit WorkerRegistered(workerId, uint256(uint160(worker)), 0);
        }

        _credit(taskId, itemId, answer, workerId);
    }

    /// @notice Cash out to any address, authorised by the embedded wallet.
    function withdrawFor(address worker, address to, bytes calldata signature)
        external
        returns (uint256 receiptId)
    {
        bytes32 workerId = idOfAddress(worker);
        if (!isRegistered[workerId]) revert NotRegistered();
        if (EIP712.recover(withdrawDigest(worker, to), signature) != worker) {
            revert BadSignature();
        }
        return _settle(workerId, to);
    }

    // ---------------------------------------------------------------------
    // Challenges
    //
    // Every challenge is bound to the chain and to this contract, so a
    // signature captured here cannot be replayed against another deployment.
    //
    // Action tags are explicit bytes32 rather than inline string literals: the
    // client has to reproduce this encoding byte for byte in TypeScript, and a
    // dynamically-encoded string is an easy way to get that subtly wrong.
    // ---------------------------------------------------------------------

    bytes32 public constant ACTION_REGISTER = keccak256("swarm.register");
    bytes32 public constant ACTION_LABEL = keccak256("swarm.label");
    bytes32 public constant ACTION_WITHDRAW = keccak256("swarm.withdraw");

    function registerChallenge(WebAuthn.PubKey calldata pk, bytes32 credentialHash)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(block.chainid, address(this), ACTION_REGISTER, pk.x, pk.y, credentialHash)
        );
    }

    /// @dev The answer is part of the challenge, so a signature for "yes" is not
    ///      a signature for "no". Resubmission is blocked by `hasLabeled`.
    function labelChallenge(uint256 taskId, uint256 itemId, uint8 answer) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), ACTION_LABEL, taskId, itemId, answer));
    }

    function withdrawChallenge(bytes32 workerId, address to) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), ACTION_WITHDRAW, to, nonces[workerId]));
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function idOf(WebAuthn.PubKey calldata pk) public pure returns (bytes32) {
        return keccak256(abi.encode(pk.x, pk.y));
    }

    function balanceOf(bytes32 workerId) external view returns (uint256) {
        return earned[workerId] - withdrawn[workerId];
    }

    function pubkeyOf(bytes32 workerId) external view returns (WebAuthn.PubKey memory) {
        return _pubkeys[workerId];
    }

    function taskCount() external view returns (uint256) {
        return _tasks.length;
    }

    function tasks(uint256 taskId) external view returns (Task memory) {
        return _tasks[taskId];
    }

    function remaining(uint256 taskId) external view returns (uint256) {
        Task storage t = _tasks[taskId];
        return t.funded - t.paidOut;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _pull(address from, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = address(token).call(
            abi.encodeCall(IERC20.transferFrom, (from, address(this), amount))
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address to, uint256 amount) private {
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
