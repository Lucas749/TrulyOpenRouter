// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/HostRegistry.sol";

/// @notice Registry-only testnet deployment; existing vault and stakes stay intact.
contract DeployHostRegistry is Script {
    uint256 public constant MIN_STAKE_TINYBAR = 400_000_000; // 4 HBAR; reserve another 1 for gas
    uint64 public constant UNSTAKE_DELAY = 1 days;

    function run() external returns (HostRegistry registry) {
        require(block.chainid == 296, "Hedera testnet only");
        vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
        registry = new HostRegistry(MIN_STAKE_TINYBAR, UNSTAKE_DELAY);
        vm.stopBroadcast();
        console2.log("HostRegistry:", address(registry));
    }
}
