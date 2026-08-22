// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TaskPool, IERC20} from "../src/TaskPool.sol";
import {DemoUSD} from "../src/DemoUSD.sol";

/// @notice Deploys the payment rail and seeds one funded task so the demo is
///         live the moment the transaction confirms.
///
///   forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast --verify
contract Deploy is Script {
    /// 0.005 DUSD == half a cent, at 6 decimals.
    uint96 constant REWARD_PER_LABEL = 5_000;

    /// Enough for 20,000 labels. A room of 60 people cannot drain this.
    uint128 constant POOL = 100_000_000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        DemoUSD usd = new DemoUSD();
        TaskPool pool = new TaskPool(IERC20(address(usd)));

        usd.mint(deployer, POOL);
        usd.approve(address(pool), type(uint256).max);
        uint256 taskId = pool.createTask("/manifest/moderation.json", REWARD_PER_LABEL, POOL);

        vm.stopBroadcast();

        console.log("chain id        ", block.chainid);
        console.log("DemoUSD         ", address(usd));
        console.log("TaskPool        ", address(pool));
        console.log("seeded task id  ", taskId);
        console.log("reward per label", REWARD_PER_LABEL);
    }
}
