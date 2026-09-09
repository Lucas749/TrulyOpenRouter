// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SubscriptionVault — flat fee in, metered debits out.
/// @notice Users subscribe (1 credit = $0.001 of inference). Only the gateway can debit, subject
/// to a per-user daily fair-share quota. Hosts pull earnings; 10% protocol fee accrues to owner.
/// v1 settles in native currency; HTS USDC is the testnet integration step (SPEC §8a).
contract SubscriptionVault {
    struct Plan {
        uint256 priceWei;
        uint256 credits;
        bool exists;
    }

    /// @notice Wei refunded per unused credit. Set from plan 0 at construction.
    uint256 public immutable REFUND_RATE_WEI_PER_CREDIT;
    uint256 public constant PROTOCOL_FEE_BPS = 1000; // 10%

    address public owner;
    address public gateway;
    uint256 public dailyQuota; // credits per user per rolling UTC day

    mapping(uint256 => Plan) public plans;
    mapping(address => uint256) public credits;
    mapping(address => uint256) public hostEarnings;
    mapping(address => uint256) public spentToday;
    mapping(address => uint64) public quotaDay;
    uint256 public accruedFees;

    /// @notice Per-account max spend, synced from team allowances by the gateway.
    /// Zero struct (periodDays == 0) = uncapped: every pre-existing subscriber
    /// keeps working. cap == 0 with periodDays > 0 = deny-all (removed members).
    /// A fresh cap starts a fresh period now (mirrors the gateway allowance UX).
    struct SpendCap {
        uint256 cap;
        uint64 periodStart;
        uint32 periodDays;
        uint256 spent;
    }
    mapping(address => SpendCap) public spendCaps;

    /// @notice Organization money: the pool (org wallet) holds the credits,
    /// members draw from it within their own cap. Deny-by-default — a member
    /// with NO entry cannot touch pool funds at all (unknown/removed members
    /// drain nothing). An "unlimited" org allowance is mirrored as
    /// type(uint256).max by the gateway, never as an empty slot.
    mapping(address => mapping(address => SpendCap)) public poolSpendCaps; // pool => member => cap

    event GatewaySet(address indexed gateway);
    event PlanSet(uint256 indexed planId, uint256 priceWei, uint256 credits);
    event QuotaSet(uint256 dailyQuota);
    event SpendCapSet(address indexed user, uint256 cap, uint32 periodDays);
    event PoolSpendCapSet(address indexed pool, address indexed member, uint256 cap, uint32 periodDays);
    event PoolDebited(address indexed pool, address indexed member, address indexed host, uint256 amount, bytes32 receiptHash);
    event Subscribed(address indexed user, uint256 indexed planId, uint256 credits);
    event Debited(address indexed user, address indexed host, uint256 amount, bytes32 receiptHash);
    event HostPaid(address indexed host, uint256 amount, bytes32 receiptHash);
    event Withdrawn(address indexed host, uint256 amount);
    event FeesWithdrawn(uint256 amount);
    event Refunded(address indexed user, uint256 credits, uint256 amount);

    error NotOwner();
    error NotGateway();
    error UnknownPlan();
    error WrongPayment(uint256 sent, uint256 required);
    error InsufficientCredits(uint256 have, uint256 need);
    error QuotaExceeded(uint256 wouldSpend, uint256 quota);
    error SpendCapExceeded(uint256 wouldSpend, uint256 cap);
    error NoPoolSpendCap(address pool, address member);
    error PoolSpendCapExceeded(address pool, address member, uint256 wouldSpend, uint256 cap);
    error NothingToWithdraw();
    error NothingToRefund();
    error InconsistentPlan(uint256 priceWei, uint256 expected);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyGateway() {
        if (msg.sender != gateway) revert NotGateway();
        _;
    }

    constructor(address gateway_, uint256 dailyQuota_, uint256 refundRateWeiPerCredit) {
        owner = msg.sender;
        gateway = gateway_;
        dailyQuota = dailyQuota_;
        REFUND_RATE_WEI_PER_CREDIT = refundRateWeiPerCredit;
        emit GatewaySet(gateway_);
    }

    function setGateway(address gateway_) external onlyOwner {
        gateway = gateway_;
        emit GatewaySet(gateway_);
    }

    function setPlan(uint256 planId, uint256 priceWei, uint256 credits_) external onlyOwner {
        if (priceWei != credits_ * REFUND_RATE_WEI_PER_CREDIT) {
            revert InconsistentPlan(priceWei, credits_ * REFUND_RATE_WEI_PER_CREDIT);
        }
        plans[planId] = Plan(priceWei, credits_, true);
        emit PlanSet(planId, priceWei, credits_);
    }

    function setDailyQuota(uint256 dailyQuota_) external onlyOwner {
        dailyQuota = dailyQuota_;
        emit QuotaSet(dailyQuota_);
    }

    /// @notice Sync one account's max spend from a team allowance. onlyGateway
    /// on purpose: team-owner authorization happens offchain (signed messages
    /// in the web app) and the gateway propagates, exactly like debit itself —
    /// the chain cannot see team roles. periodDays == 0 clears back to uncapped.
    function setSpendCap(address user, uint256 cap, uint32 periodDays) external onlyGateway {
        if (periodDays == 0) {
            delete spendCaps[user];
        } else {
            spendCaps[user] = SpendCap(cap, uint64(block.timestamp), periodDays, 0);
        }
        emit SpendCapSet(user, cap, periodDays);
    }

    /// @notice Sync one member's cap against one org pool. onlyGateway, same
    /// rationale as setSpendCap (org roles live offchain). periodDays == 0
    /// deletes back to deny-by-default.
    function setPoolSpendCap(address pool, address member, uint256 cap, uint32 periodDays) external onlyGateway {
        if (periodDays == 0) {
            delete poolSpendCaps[pool][member];
        } else {
            poolSpendCaps[pool][member] = SpendCap(cap, uint64(block.timestamp), periodDays, 0);
        }
        emit PoolSpendCapSet(pool, member, cap, periodDays);
    }

    /// @notice Charge one routed call against ORGANIZATION funds. Callable only
    /// by the gateway, which resolves (member, org) -> pool offchain from team
    /// membership. The pool pays; the member's pool-cap bounds them; the pool's
    /// own balance and the global daily quota bound the org as a whole.
    function debitFrom(address pool, address member, address host, uint256 amount, bytes32 receiptHash)
        external
        onlyGateway
    {
        uint64 day = uint64(block.timestamp / 1 days);
        if (quotaDay[pool] != day) {
            quotaDay[pool] = day;
            spentToday[pool] = 0;
        }
        if (spentToday[pool] + amount > dailyQuota) {
            revert QuotaExceeded(spentToday[pool] + amount, dailyQuota);
        }
        if (credits[pool] < amount) revert InsufficientCredits(credits[pool], amount);

        SpendCap storage sc = poolSpendCaps[pool][member];
        if (sc.periodDays == 0) revert NoPoolSpendCap(pool, member);
        if (block.timestamp >= sc.periodStart + uint64(sc.periodDays) * 1 days) {
            sc.periodStart = uint64(block.timestamp);
            sc.spent = 0;
        }
        if (sc.spent + amount > sc.cap) revert PoolSpendCapExceeded(pool, member, sc.spent + amount, sc.cap);
        sc.spent += amount;

        credits[pool] -= amount;
        spentToday[pool] += amount;

        uint256 fee = (amount * PROTOCOL_FEE_BPS) / 10_000;
        uint256 hostShare = amount - fee;
        hostEarnings[host] += hostShare;
        accruedFees += fee;

        emit PoolDebited(pool, member, host, amount, receiptHash);
        emit HostPaid(host, hostShare, receiptHash);
    }

    /// @notice Buy credits at exact plan price.
    function subscribe(uint256 planId) external payable {
        Plan storage p = plans[planId];
        if (!p.exists) revert UnknownPlan();
        if (msg.value != p.priceWei) revert WrongPayment(msg.value, p.priceWei);
        credits[msg.sender] += p.credits;
        emit Subscribed(msg.sender, planId, p.credits);
    }

    /// @notice Charge one routed call. Callable only by the gateway.
    function debit(address user, address host, uint256 amount, bytes32 receiptHash)
        external
        onlyGateway
    {
        uint64 day = uint64(block.timestamp / 1 days);
        if (quotaDay[user] != day) {
            quotaDay[user] = day;
            spentToday[user] = 0;
        }
        if (spentToday[user] + amount > dailyQuota) {
            revert QuotaExceeded(spentToday[user] + amount, dailyQuota);
        }
        if (credits[user] < amount) revert InsufficientCredits(credits[user], amount);

        SpendCap storage sc = spendCaps[user];
        if (sc.periodDays > 0) {
            if (block.timestamp >= sc.periodStart + uint64(sc.periodDays) * 1 days) {
                sc.periodStart = uint64(block.timestamp);
                sc.spent = 0;
            }
            if (sc.spent + amount > sc.cap) revert SpendCapExceeded(sc.spent + amount, sc.cap);
            sc.spent += amount;
        }

        credits[user] -= amount;
        spentToday[user] += amount;

        uint256 fee = (amount * PROTOCOL_FEE_BPS) / 10_000;
        uint256 hostShare = amount - fee;
        // Invariant: 1 credit ≡ REFUND_RATE_WEI_PER_CREDIT wei (enforced in setPlan), so all
        // internal balances convert 1:1 at payout time (see withdraw/withdrawFees/refund).
        hostEarnings[host] += hostShare;
        accruedFees += fee;

        emit Debited(user, host, amount, receiptHash);
        emit HostPaid(host, hostShare, receiptHash);
    }

    /// @notice Hosts pull earnings. Under-threshold = instant; over-threshold is Ledger-tapped
    /// offchain before this call is ever made (see LEDGER.md).
    function withdraw() external {
        uint256 earned = hostEarnings[msg.sender];
        if (earned == 0) revert NothingToWithdraw();
        hostEarnings[msg.sender] = 0;
        uint256 amount = earned * REFUND_RATE_WEI_PER_CREDIT;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    function withdrawFees() external onlyOwner {
        uint256 fees = accruedFees;
        if (fees == 0) revert NothingToWithdraw();
        accruedFees = 0;
        uint256 amount = fees * REFUND_RATE_WEI_PER_CREDIT;
        (bool ok,) = owner.call{value: amount}("");
        require(ok, "fee transfer failed");
        emit FeesWithdrawn(amount);
    }

    /// @notice Cash out unused credits at the fixed refund rate.
    function refund() external {
        uint256 bal = credits[msg.sender];
        if (bal == 0) revert NothingToRefund();
        uint256 amount = bal * REFUND_RATE_WEI_PER_CREDIT;
        credits[msg.sender] = 0;
        // Quota spend stays spent: refunds cover unused credits only.
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "refund transfer failed");
        emit Refunded(msg.sender, bal, amount);
    }
}
