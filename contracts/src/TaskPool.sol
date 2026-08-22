// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WebAuthn} from "./WebAuthn.sol";

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
    event Withdrawn(bytes32 indexed workerId, address indexed to, uint256 amount);

    error BadSignature();
    error TaskNotOpen();
    error NotRegistered();
    error AlreadyLabeled();
    error PoolExhausted();
    error NothingToWithdraw();
    error NotRequester();
    error ZeroReward();
    error TransferFailed();

    constructor(IERC20 _token) {
        token = _token;
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
    /// @dev The assertion proves possession of the matching private key, so
    ///      nobody can register a public key they do not control. The
    ///      credential hash is bound into the challenge, so it cannot be
    ///      swapped to hijack somebody else's sign-in lookup.
    function registerWorker(
        WebAuthn.PubKey calldata pk,
        bytes32 credentialHash,
        WebAuthn.Signature calldata sig
    ) external returns (bytes32 workerId) {
        workerId = idOf(pk);
        if (!isRegistered[workerId]) {
            if (!WebAuthn.verify(registerChallenge(pk, credentialHash), sig, pk)) {
                revert BadSignature();
            }
            _pubkeys[workerId] = pk;
            isRegistered[workerId] = true;
            workerOf[credentialHash] = workerId;
            unchecked {
                workerCount++;
            }
            emit WorkerRegistered(workerId, pk.x, pk.y);
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
        Task storage t = _tasks[taskId];
        if (!t.open) revert TaskNotOpen();
        if (!isRegistered[workerId]) revert NotRegistered();
        if (hasLabeled[taskId][workerId][itemId]) revert AlreadyLabeled();

        if (!WebAuthn.verify(labelChallenge(taskId, itemId, answer), sig, _pubkeys[workerId])) {
            revert BadSignature();
        }

        uint256 reward = t.rewardPerLabel;
        if (t.funded - t.paidOut < reward) revert PoolExhausted();

        hasLabeled[taskId][workerId][itemId] = true;
        t.paidOut += uint128(reward);
        t.labelCount++;
        earned[workerId] += reward;

        unchecked {
            totalLabels++;
            totalPaid += reward;
        }

        emit LabelSubmitted(taskId, workerId, itemId, answer, reward, totalLabels);
    }

    /// @notice Sweep everything earned to any address the worker names.
    /// @dev The passkey is the authority; the destination is chosen at cash-out
    ///      time, which is why a worker never needed a wallet to start earning.
    function withdraw(bytes32 workerId, address to, WebAuthn.Signature calldata sig) external {
        if (!isRegistered[workerId]) revert NotRegistered();

        uint256 amount = earned[workerId] - withdrawn[workerId];
        if (amount == 0) revert NothingToWithdraw();

        if (!WebAuthn.verify(withdrawChallenge(workerId, to), sig, _pubkeys[workerId])) {
            revert BadSignature();
        }

        unchecked {
            nonces[workerId]++;
        }
        withdrawn[workerId] += amount;
        _push(to, amount);
        emit Withdrawn(workerId, to, amount);
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
