// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TaskPool, IERC20} from "../src/TaskPool.sol";
import {DemoUSD} from "../src/DemoUSD.sol";

/// @notice Deploys the rail and seeds one task, spec and all, on-chain.
///
///   forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
contract Deploy is Script {
    /// 5 cents a box, at 6 decimals. A box takes longer than a tap and can
    /// only be claimed once, so it is priced as a bounty.
    uint96 constant REWARD_PER_LABEL = 50_000;

    /// Enough that a room of sixty cannot drain it mid-demo.
    uint128 constant POOL = 100_000_000;

    uint32 constant ITEMS = 6;

    /// The task lives on-chain so a worker needs nothing but the contract.
    /// An image bounty: box the target, first to answer takes it.
    string constant SPEC =
        '{"title":"Dashcam frames",'
        '"question":"Draw a box around any car",'
        '"kind":"bbox",'
        '"answers":{"0":"Nothing here","1":"Found it"},'
        '"items":['
        '{"id":0,"text":"https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=700"},'
        '{"id":1,"text":"https://images.unsplash.com/photo-1502877338535-766e1452684a?w=700"},'
        '{"id":2,"text":"https://images.unsplash.com/photo-1493238792000-8113da705763?w=700"},'
        '{"id":3,"text":"https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=700"},'
        '{"id":4,"text":"https://images.unsplash.com/photo-1541899481282-d53bffe3c35d?w=700"},'
        '{"id":5,"text":"https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=700"}'
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
    ///      A bounty: first worker to box an image takes it, and the image
    ///      closes, so quorum is one.
    function _seed(TaskPool pool, uint256 pk, address deployer) private returns (uint256) {
        uint8 mode = uint8(TaskPool.Mode.FirstCome);
        uint8 quorum = 1;

        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, pool.postDigest(SPEC, REWARD_PER_LABEL, POOL, ITEMS, mode, quorum));

        return pool.postTaskSponsored(
            SPEC, REWARD_PER_LABEL, POOL, ITEMS, mode, quorum, deployer, abi.encodePacked(r, s, v)
        );
    }
}
