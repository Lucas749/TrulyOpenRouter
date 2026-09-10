// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../script/DeployHostRegistry.s.sol";

contract TestnetRegistryTest is Test {
    function test_FiveHbarCoversStakeAndReserve() public {
        DeployHostRegistry deployment = new DeployHostRegistry();
        HostRegistry registry = new HostRegistry(deployment.MIN_STAKE_TINYBAR(), deployment.UNSTAKE_DELAY());
        address host = address(0xA11CE);
        // Model the tinybar values the relay delivers to Hedera contracts.
        vm.deal(host, 500_000_000);
        vm.prank(host);
        registry.register{value: 400_000_000}("https://host.example", "qwen2.5:0.5b", bytes32(0), bytes32(0), 1, 1, "");
        assertTrue(registry.getHost(host).active);
        assertEq(registry.getHost(host).stake, 400_000_000);
        assertEq(host.balance, 100_000_000);
    }
}
