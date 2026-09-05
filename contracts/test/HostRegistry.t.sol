// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/HostRegistry.sol";

contract HostRegistryTest is Test {
    HostRegistry registry;
    address host1 = address(0xA11CE);
    address host2 = address(0xB0B);
    uint256 constant MIN_STAKE = 0.1 ether;
    uint64 constant UNSTAKE_DELAY = 1 days;

    function setUp() public {
        registry = new HostRegistry(MIN_STAKE, UNSTAKE_DELAY);
        deal(host1, 10 ether);
        deal(host2, 10 ether);
    }

    function _register(address h, string memory model) internal {
        vm.prank(h);
        registry.register{value: MIN_STAKE}(
            "http://host:11434", model, keccak256(bytes(model)), bytes32("img"), 0.001 ether, 0.0001 ether, ""
        );
    }

    function test_Register() public {
        vm.prank(host1);
        registry.register{value: MIN_STAKE}(
            "http://h1:11434", "llama-3.1-8b", bytes32("model"), bytes32("img"), 1, 2, ""
        );
        HostRegistry.Host memory h = registry.getHost(host1);
        assertTrue(h.active);
        assertEq(h.stake, MIN_STAKE);
        assertEq(h.modelId, "llama-3.1-8b");
        assertEq(registry.hostCount(), 1);

        address[] memory eligible = registry.eligibleHosts("llama-3.1-8b");
        assertEq(eligible.length, 1);
        assertEq(eligible[0], host1);
    }

    function test_RegisterRevertsBelowMinStake() public {
        vm.prank(host1);
        vm.expectRevert(abi.encodeWithSelector(HostRegistry.InsufficientStake.selector, 0.01 ether, MIN_STAKE));
        registry.register{value: 0.01 ether}("http://h1", "m", bytes32(0), bytes32(0), 0, 0, "");
    }

    function test_DoubleRegisterReverts() public {
        _register(host1, "m");
        vm.prank(host1);
        vm.expectRevert(HostRegistry.AlreadyRegistered.selector);
        registry.register{value: MIN_STAKE}("http://h1", "m", bytes32(0), bytes32(0), 0, 0, "");
    }

    function test_UpdatePricingAndHeartbeat() public {
        _register(host1, "m");
        uint64 t0 = uint64(block.timestamp);
        vm.warp(t0 + 100);
        vm.prank(host1);
        registry.updatePricing(5, 6);
        vm.prank(host1);
        registry.heartbeat();
        HostRegistry.Host memory h = registry.getHost(host1);
        assertEq(h.pricePerReq, 5);
        assertEq(h.pricePer1kTokens, 6);
        assertEq(h.lastHeartbeat, t0 + 100);
    }

    function test_EligibleFiltersModelAndActive() public {
        _register(host1, "llama-3.1-8b");
        _register(host2, "qwen-2.5-7b");
        assertEq(registry.eligibleHosts("llama-3.1-8b").length, 1);
        assertEq(registry.eligibleHosts("qwen-2.5-7b").length, 1);
        assertEq(registry.eligibleHosts("nope").length, 0);

        vm.prank(host2);
        registry.deregister();
        assertEq(registry.eligibleHosts("qwen-2.5-7b").length, 0);
    }

    function test_DeregisterThenReleaseAfterDelay() public {
        _register(host1, "m");
        vm.prank(host1);
        registry.deregister();
        assertFalse(registry.getHost(host1).active);

        vm.prank(host1);
        vm.expectRevert(
            abi.encodeWithSelector(
                HostRegistry.ReleaseNotReady.selector, uint64(block.timestamp) + UNSTAKE_DELAY
            )
        );
        registry.release();

        vm.warp(block.timestamp + UNSTAKE_DELAY + 1);
        uint256 before = host1.balance;
        vm.prank(host1);
        registry.release();
        assertEq(host1.balance - before, MIN_STAKE);
        assertEq(registry.getHost(host1).stake, 0);
    }

    function test_ReleaseWhileActiveReverts() public {
        _register(host1, "m");
        vm.prank(host1);
        vm.expectRevert(HostRegistry.NotActive.selector);
        registry.release();
    }

    function test_ChallengeMarksHost() public {
        _register(host1, "m");
        registry.challenge(host1, bytes32("receipt"));
        assertTrue(registry.getHost(host1).challenged);
    }

    function test_ChallengeUnknownHostReverts() public {
        vm.expectRevert(HostRegistry.NotRegistered.selector);
        registry.challenge(address(0xDEAD), bytes32("receipt"));
    }
}
