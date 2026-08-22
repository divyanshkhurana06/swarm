// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TaskPool, IERC20} from "../src/TaskPool.sol";
import {DemoUSD} from "../src/DemoUSD.sol";

/// @notice Deploys the rail and seeds one task, spec and all, on-chain.
///
///   forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
contract Deploy is Script {
    /// 3 cents an answer, at 6 decimals. Priced so a finished batch is worth
    /// something a person would notice; half a cent reads as a toy.
    uint96 constant REWARD_PER_LABEL = 30_000;

    /// Enough that a room of sixty cannot drain it mid-demo.
    uint128 constant POOL = 100_000_000;

    uint32 constant ITEMS = 12;

    /// The task lives on-chain so a worker needs nothing but the contract.
    string constant SPEC =
        '{"title":"Comment moderation",'
        '"question":"Should this comment be flagged for review?",'
        '"answers":{"0":"Looks fine","1":"Flag it"},'
        '"items":['
        '{"id":0,"text":"Genuinely the best explanation of gradient descent I have read."},'
        '{"id":1,"text":"CONGRATULATIONS!! You have been selected. Claim your reward before it expires!!!"},'
        '{"id":2,"text":"I disagree with the conclusion but the methodology section is solid."},'
        '{"id":3,"text":"Make $5000/week from home. DM me for details. No experience needed."},'
        '{"id":4,"text":"Has anyone benchmarked this against the older version?"},'
        '{"id":5,"text":"you clearly have no idea what you are talking about and should stop posting"},'
        '{"id":6,"text":"Thanks for the writeup, the caching section cleared something up for me."},'
        '{"id":7,"text":"FREE CRYPTO AIRDROP connect your wallet here to claim now limited time"},'
        '{"id":8,"text":"The build fails on Node 18 for me. Anyone else hitting this?"},'
        '{"id":9,"text":"buy followers cheap fast delivery guaranteed check bio link"},'
        '{"id":10,"text":"Small typo in the third paragraph - recieve should be receive."},'
        '{"id":11,"text":"URGENT: your account will be suspended. Verify your password immediately."}'
        "]}";

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        DemoUSD usd = new DemoUSD();
        TaskPool pool = new TaskPool(IERC20(address(usd)));

        // Post the seed task the same way a requester would: sign it, let the
        // pool mint the reward pool. Exercising the real path at deploy time
        // means the demo cannot diverge from what a requester actually does.
        uint256 taskId = _seed(pool, pk, deployer);

        vm.stopBroadcast();

        console.log("chain id        ", block.chainid);
        console.log("DemoUSD         ", address(usd));
        console.log("TaskPool        ", address(pool));
        console.log("WorkReceipt     ", address(pool.receipts()));
        console.log("seeded task id  ", taskId);
    }

    /// @dev Split out so the locals do not overflow the stack.
    ///      Text labelling is majority-scored: three people answer each item
    ///      and only those who agreed with the crowd are paid.
    function _seed(TaskPool pool, uint256 pk, address deployer) private returns (uint256) {
        uint8 mode = uint8(TaskPool.Mode.Majority);
        uint8 quorum = 3;

        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, pool.postDigest(SPEC, REWARD_PER_LABEL, POOL, ITEMS, mode, quorum));

        return pool.postTaskSponsored(
            SPEC, REWARD_PER_LABEL, POOL, ITEMS, mode, quorum, deployer, abi.encodePacked(r, s, v)
        );
    }
}
