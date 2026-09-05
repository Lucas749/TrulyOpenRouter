// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HostRegistry — permissionless registry of inference hosts.
/// @notice Hosts stake to register an endpoint serving an open model. Everything needed to
/// reassess a host (model/image digests, price table, stake, heartbeats) lives onchain.
/// Slashing is intentionally a stub: challenges queue for review, nothing auto-slashes.
contract HostRegistry {
    struct Host {
        string endpoint;
        string modelId;
        bytes32 modelDigest;
        bytes32 imageDigest;
        uint256 pricePerReq;
        uint256 pricePer1kTokens;
        bytes teePubkey; // empty until the TEE path ships
        uint256 stake;
        bool active;
        uint64 registeredAt;
        uint64 lastHeartbeat;
        uint64 releaseAfter; // deregister timelock; 0 = none pending
        bool challenged;
    }

    uint256 public immutable MIN_STAKE;
    uint64 public immutable UNSTAKE_DELAY;

    mapping(address => Host) private _hosts;
    address[] private _hostList;

    event HostRegistered(address indexed host, string modelId, bytes32 modelDigest, uint256 stake);
    event HostUpdated(address indexed host);
    event HostHeartbeat(address indexed host, uint64 timestamp);
    event HostChallenged(address indexed host, address indexed challenger, bytes32 receiptId);
    event HostDeregistered(address indexed host, uint64 releaseAfter);
    event StakeReleased(address indexed host, uint256 amount);

    error InsufficientStake(uint256 sent, uint256 required);
    error AlreadyRegistered();
    error NotRegistered();
    error NotActive();
    error TimelockActive(uint64 releaseAfter);
    error NothingToRelease();
    error ReleaseNotReady(uint64 releaseAfter);

    constructor(uint256 minStake, uint64 unstakeDelay) {
        MIN_STAKE = minStake;
        UNSTAKE_DELAY = unstakeDelay;
    }

    /// @notice Register (or re-register after a full release) as a serving host.
    function register(
        string calldata endpoint,
        string calldata modelId,
        bytes32 modelDigest,
        bytes32 imageDigest,
        uint256 pricePerReq,
        uint256 pricePer1kTokens,
        bytes calldata teePubkey
    ) external payable {
        Host storage h = _hosts[msg.sender];
        if (h.active) revert AlreadyRegistered();
        if (h.releaseAfter != 0) revert TimelockActive(h.releaseAfter);
        if (msg.value < MIN_STAKE) revert InsufficientStake(msg.value, MIN_STAKE);

        bool fresh = h.registeredAt == 0 && h.stake == 0;
        h.endpoint = endpoint;
        h.modelId = modelId;
        h.modelDigest = modelDigest;
        h.imageDigest = imageDigest;
        h.pricePerReq = pricePerReq;
        h.pricePer1kTokens = pricePer1kTokens;
        h.teePubkey = teePubkey;
        h.stake += msg.value;
        h.active = true;
        h.challenged = false;
        h.registeredAt = uint64(block.timestamp);
        h.lastHeartbeat = uint64(block.timestamp);
        h.releaseAfter = 0;

        if (fresh) _hostList.push(msg.sender);
        emit HostRegistered(msg.sender, modelId, modelDigest, msg.value);
    }

    function updatePricing(uint256 pricePerReq, uint256 pricePer1kTokens) external {
        Host storage h = _hosts[msg.sender];
        if (!h.active) revert NotActive();
        h.pricePerReq = pricePerReq;
        h.pricePer1kTokens = pricePer1kTokens;
        emit HostUpdated(msg.sender);
    }

    function heartbeat() external {
        Host storage h = _hosts[msg.sender];
        if (!h.active) revert NotActive();
        h.lastHeartbeat = uint64(block.timestamp);
        emit HostHeartbeat(msg.sender, uint64(block.timestamp));
    }

    /// @notice Stop serving. Stake unlocks after UNSTAKE_DELAY (release is a separate call so a
    /// Ledger tap can gate it offchain).
    function deregister() external {
        Host storage h = _hosts[msg.sender];
        if (!h.active) revert NotActive();
        h.active = false;
        h.releaseAfter = uint64(block.timestamp) + UNSTAKE_DELAY;
        emit HostDeregistered(msg.sender, h.releaseAfter);
    }

    function release() external {
        Host storage h = _hosts[msg.sender];
        if (h.active) revert NotActive();
        if (h.stake == 0) revert NothingToRelease();
        if (block.timestamp < h.releaseAfter) revert ReleaseNotReady(h.releaseAfter);
        uint256 amount = h.stake;
        h.stake = 0;
        h.releaseAfter = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "stake transfer failed");
        emit StakeReleased(msg.sender, amount);
    }

    /// @notice Flag a host with a failed receipt. Queued for review only — no auto-slash (v1 stub).
    function challenge(address host, bytes32 receiptId) external {
        Host storage h = _hosts[host];
        if (h.registeredAt == 0 && h.stake == 0) revert NotRegistered();
        h.challenged = true;
        emit HostChallenged(host, msg.sender, receiptId);
    }

    /// @notice Active hosts for a model. The gateway scores these offchain.
    function eligibleHosts(string calldata modelId) external view returns (address[] memory) {
        bytes32 want = keccak256(bytes(modelId));
        uint256 n = 0;
        uint256 len = _hostList.length;
        for (uint256 i = 0; i < len; i++) {
            Host storage h = _hosts[_hostList[i]];
            if (h.active && keccak256(bytes(h.modelId)) == want) n++;
        }
        address[] memory out = new address[](n);
        uint256 j = 0;
        for (uint256 i = 0; i < len; i++) {
            Host storage h = _hosts[_hostList[i]];
            if (h.active && keccak256(bytes(h.modelId)) == want) out[j++] = _hostList[i];
        }
        return out;
    }

    function getHost(address host) external view returns (Host memory) {
        return _hosts[host];
    }

    function hostCount() external view returns (uint256) {
        return _hostList.length;
    }
}
