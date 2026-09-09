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

    function test_SpendCapEnforcedPerMember() public {
        _subscribed();
        vm.prank(gateway);
        vault.setSpendCap(user, 500, 30);
        vm.prank(gateway);
        vault.debit(user, host, 400, bytes32("r1"));
        vm.prank(gateway);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionVault.SpendCapExceeded.selector, 501, 500)
        );
        vault.debit(user, host, 101, bytes32("r2")); // 400 + 101 > 500
        // exact-cap spend works
        vm.prank(gateway);
        vault.debit(user, host, 100, bytes32("r3"));
        (uint256 cap, uint64 ps, uint32 pdays, uint256 spent) = vault.spendCaps(user);
        assertEq(cap, 500);
        assertEq(pdays, 30);
        assertEq(spent, 500);
    }

    function test_SpendCapZeroDeniesAll() public {
        _subscribed();
        vm.prank(gateway);
        vault.setSpendCap(user, 0, 30); // removed member
        vm.prank(gateway);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionVault.SpendCapExceeded.selector, 1, 0)
        );
        vault.debit(user, host, 1, bytes32("r"));
    }

    function test_SpendCapUnsetIsUncapped() public {
        _subscribed(); // no setSpendCap call: pre-existing subscribers unaffected
        vm.prank(gateway);
        vault.debit(user, host, QUOTA, bytes32("r1")); // only the daily quota binds
        (uint256 c0, uint64 p0, uint32 pdays, uint256 s0) = vault.spendCaps(user);
        assertEq(pdays, 0);
    }

    function test_SpendCapClearedIsUncapped() public {
        _subscribed();
        vm.prank(gateway);
        vault.setSpendCap(user, 500, 30);
        vm.prank(gateway);
        vault.setSpendCap(user, 0, 0); // null allowance -> clear
        vm.prank(gateway);
        vault.debit(user, host, QUOTA, bytes32("r1"));
        (uint256 c0, uint64 p0, uint32 pdays, uint256 s0) = vault.spendCaps(user);
        assertEq(pdays, 0);
    }

    function test_SpendCapResetsAfterPeriod() public {
        _subscribed();
        vm.prank(gateway);
        vault.setSpendCap(user, 500, 30);
        vm.prank(gateway);
        vault.debit(user, host, 500, bytes32("r1"));
        vm.warp(block.timestamp + 31 days);
        vm.prank(gateway);
        vault.debit(user, host, 500, bytes32("r2")); // fresh window works
        (uint256 c1, uint64 p1, uint32 d1, uint256 spent) = vault.spendCaps(user);
        assertEq(spent, 500);
    }

    function test_SpendCapFreshCapFreshPeriod() public {
        _subscribed();
        vm.prank(gateway);
        vault.setSpendCap(user, 500, 30);
        vm.prank(gateway);
        vault.debit(user, host, 500, bytes32("r1"));
        vm.prank(gateway);
        vault.setSpendCap(user, 700, 30); // raise = fresh period, mirrors gateway UX
        vm.prank(gateway);
        vault.debit(user, host, 700, bytes32("r2"));
        (uint256 c1, uint64 p1, uint32 d1, uint256 spent) = vault.spendCaps(user);
        assertEq(spent, 700);
    }

    function test_SpendCapOnlyGateway() public {
        vm.prank(user);
        vm.expectRevert(SubscriptionVault.NotGateway.selector);
        vault.setSpendCap(user, 500, 30);
    }

    address pool = address(0x0BAD);
    address alice = address(0xA11CE);

    function _fundedPool() internal {
        deal(pool, 100 ether);
        vm.prank(pool);
        vault.subscribe{value: PLAN_PRICE}(0);
    }

    function test_PoolDebitDrawsOrgFundsWithinMemberCap() public {
        _fundedPool();
        vm.prank(gateway);
        vault.setPoolSpendCap(pool, alice, 500, 30);
        vm.prank(gateway);
        vault.debitFrom(pool, alice, host, 400, bytes32("p1"));
        assertEq(vault.credits(pool), PLAN_CREDITS - 400);
        assertEq(vault.credits(alice), 0); // member never needed her own balance
        assertEq(vault.hostEarnings(host), 360);
        (, , , uint256 spent) = vault.poolSpendCaps(pool, alice);
        assertEq(spent, 400);
    }

    function test_PoolDebitDenyByDefault() public {
        _fundedPool();
        vm.prank(gateway);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionVault.NoPoolSpendCap.selector, pool, alice)
        );
        vault.debitFrom(pool, alice, host, 10, bytes32("p1")); // no entry, no spend
    }

    function test_PoolCapEnforcedAndZeroDenies() public {
        _fundedPool();
        vm.prank(gateway);
        vault.setPoolSpendCap(pool, alice, 500, 30);
        vm.prank(gateway);
        vault.debitFrom(pool, alice, host, 500, bytes32("p1"));
        vm.prank(gateway);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionVault.PoolSpendCapExceeded.selector, pool, alice, 501, 500)
        );
        vault.debitFrom(pool, alice, host, 1, bytes32("p2"));
        // removal -> cap 0 denies everything
        vm.prank(gateway);
        vault.setPoolSpendCap(pool, alice, 0, 30);
        vm.prank(gateway);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionVault.PoolSpendCapExceeded.selector, pool, alice, 1, 0)
        );
        vault.debitFrom(pool, alice, host, 1, bytes32("p3"));
    }

    function test_PoolCapResetsAfterPeriod() public {
        _fundedPool();
        vm.prank(gateway);
        vault.setPoolSpendCap(pool, alice, 500, 30);
        vm.prank(gateway);
        vault.debitFrom(pool, alice, host, 500, bytes32("p1"));
        vm.warp(block.timestamp + 31 days);
        vm.prank(gateway);
        vault.debitFrom(pool, alice, host, 500, bytes32("p2"));
        (, , , uint256 spent) = vault.poolSpendCaps(pool, alice);
        assertEq(spent, 500);
    }

    function test_PoolDebitBoundedByPoolBalanceAndDailyQuota() public {
        deal(pool, 100 ether);
        vm.prank(pool);
        vault.subscribe{value: PLAN_PRICE}(0); // 10k credits
        vm.prank(gateway);
        vault.setPoolSpendCap(pool, alice, type(uint256).max, 30); // "unlimited" member
        // pool balance still binds: daily quota is 2000, so drain day by day
        vm.prank(gateway);
        vault.debitFrom(pool, alice, host, QUOTA, bytes32("p1"));
        vm.prank(gateway);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionVault.QuotaExceeded.selector, QUOTA + 1, QUOTA)
        );
        vault.debitFrom(pool, alice, host, 1, bytes32("p2")); // pool daily quota binds the org too
    }

    function test_PoolFnsOnlyGateway() public {
        vm.prank(alice);
        vm.expectRevert(SubscriptionVault.NotGateway.selector);
        vault.setPoolSpendCap(pool, alice, 500, 30);
        vm.prank(alice);
        vm.expectRevert(SubscriptionVault.NotGateway.selector);
        vault.debitFrom(pool, alice, host, 1, bytes32("p"));
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
