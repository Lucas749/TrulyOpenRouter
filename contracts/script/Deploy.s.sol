// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/HostRegistry.sol";
import "../src/SubscriptionVault.sol";

/// @notice Deploy to Hedera testnet EVM (chain 296, RPC https://testnet.hashio.io/api).
/// @dev forge script script/Deploy.s.sol --rpc-url https://testnet.hashio.io/api --broadcast
/// Blocky402 testnet confirmed: exact/hedera:testnet supported (feePayer 0.0.7162784), native-only.
contract Deploy is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_KEY");
        // Explicit gateway role — NEVER msg.sender (scripts run as the default sender locally).
        address gateway = vm.envAddress("GATEWAY_ADDR");
        vm.startBroadcast(key);

        HostRegistry registry = new HostRegistry(400_000_000, 1 days);
        // gateway set at construction; daily quota 2000 credits; 1 credit = 1e15 wei
        SubscriptionVault vault = new SubscriptionVault(gateway, 2_000, 1e15);
        vault.setPlan(0, 10_000 * 1e15, 10_000); // $10-style plan: 10k credits

        vm.stopBroadcast();

        console2.log("HostRegistry:", address(registry));
        console2.log("SubscriptionVault:", address(vault));
    }
}
