// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SubscriptionVault.sol";

contract SubscriptionVaultTest is Test {
    SubscriptionVault vault;
    address gateway = address(0x6A73);
    address user = address(0xBEEF);
    address host = address(0xCAFE);

    uint256 constant RATE = 1e15; // wei per credit
    uint256 constant PLAN_CREDITS = 10_000;
    uint256 constant PLAN_PRICE = PLAN_CREDITS * RATE;
    uint256 constant QUOTA = 2_000;

    function setUp() public {
        vault = new SubscriptionVault(gateway, QUOTA, RATE);
        vault.setPlan(0, PLAN_PRICE, PLAN_CREDITS);
        deal(user, 100 ether);
    }

    function _subscribed() internal {
        vm.prank(user);
        vault.subscribe{value: PLAN_PRICE}(0);
    }

    function test_Subscribe() public {
        vm.prank(user);
        vault.subscribe{value: PLAN_PRICE}(0);
        assertEq(vault.credits(user), PLAN_CREDITS);
    }

    function test_SubscribeWrongAmountReverts() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionVault.WrongPayment.selector, PLAN_PRICE - 1, PLAN_PRICE)
        );
        vault.subscribe{value: PLAN_PRICE - 1}(0);
    }

    function test_SubscribeUnknownPlanReverts() public {
        vm.prank(user);
        vm.expectRevert(SubscriptionVault.UnknownPlan.selector);
        vault.subscribe{value: PLAN_PRICE}(99);
    }

    function test_SetPlanInconsistentReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionVault.InconsistentPlan.selector, 123, PLAN_PRICE)
        );
        vault.setPlan(1, 123, PLAN_CREDITS);
    }

    function test_DebitSplitsHostAndFee() public {
        _subscribed();
        vm.prank(gateway);
        vault.debit(user, host, 1_000, bytes32("r1"));
        assertEq(vault.credits(user), PLAN_CREDITS - 1_000);
        assertEq(vault.hostEarnings(host), 900); // 90%
        assertEq(vault.accruedFees(), 100); // 10%
        assertEq(vault.spentToday(user), 1_000);
    }

    function test_DebitOnlyGateway() public {
        _subscribed();
        vm.prank(user);
        vm.expectRevert(SubscriptionVault.NotGateway.selector);
        vault.debit(user, host, 10, bytes32("r"));
    }

    function test_DebitEnforcesQuotaAndResetsDaily() public {
        _subscribed();
        vm.prank(gateway);
        vault.debit(user, host, QUOTA, bytes32("r1"));
        vm.prank(gateway);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionVault.QuotaExceeded.selector, QUOTA + 1, QUOTA)
        );
        vault.debit(user, host, 1, bytes32("r2"));

        vm.warp(block.timestamp + 1 days);
        vm.prank(gateway);
        vault.debit(user, host, 1, bytes32("r3")); // fresh day works
        assertEq(vault.spentToday(user), 1);
    }

    function test_DebitInsufficientCreditsReverts() public {
        vm.prank(gateway);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionVault.InsufficientCredits.selector, 0, 10)
        );
        vault.debit(user, host, 10, bytes32("r"));
    }

    function test_WithdrawPaysHost() public {
        _subscribed();
        vm.prank(gateway);
        vault.debit(user, host, 1_000, bytes32("r1"));
        uint256 before = host.balance;
        vm.prank(host);
        vault.withdraw();
        assertEq(host.balance - before, 900 * RATE);
        assertEq(vault.hostEarnings(host), 0);
    }

    function test_WithdrawEmptyReverts() public {
        vm.prank(host);
        vm.expectRevert(SubscriptionVault.NothingToWithdraw.selector);
        vault.withdraw();
    }

    function test_WithdrawFeesToOwner() public {
        _subscribed();
        vm.prank(gateway);
        vault.debit(user, host, 1_000, bytes32("r1"));
        uint256 before = address(this).balance;
        vault.withdrawFees();
        assertEq(address(this).balance - before, 100 * RATE);
    }

    function test_RefundCashesOutUnused() public {
        _subscribed();
        vm.prank(gateway);
        vault.debit(user, host, 1_000, bytes32("r1"));
        uint256 before = user.balance;
        vm.prank(user);
        vault.refund();
        assertEq(vault.credits(user), 0);
        assertEq(user.balance - before, (PLAN_CREDITS - 1_000) * RATE);
    }

    function test_NonOwnerCannotSetPlan() public {
        vm.prank(user);
        vm.expectRevert(SubscriptionVault.NotOwner.selector);
        vault.setPlan(1, RATE, 1);
    }

    receive() external payable {} // accept fee withdrawals in tests
}
