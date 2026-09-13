"use client";

// Mock data, copied EXACTLY from the design slice (landing .dc.html renderVals).
// RULE: mock is only ever shown when useMock() is true (explicit ?mock=1 toggle).
// Real mode renders live backend data, skeletons while loading, and "—" for anything
// unwired. The two sources are NEVER merged.

export interface StatPoint {
  label: string;
  value: string;
  delta: string;
  note: string;
}

export interface MockReceipt {
  amount: string;
  hash: string;
  host: string;
  model: string;
  latency: string;
}

export const MOCK_STATS: StatPoint[] = [
  { label: "Hosts online", value: "12", delta: "+3", note: "3 regions, self-reported" },
  { label: "Models served", value: "5", delta: "+1", note: "digest-pinned" },
  { label: "Requests / 24h", value: "48,912", delta: "+18%", note: "2,314 settled today" },
  { label: "Avg $ / 1k tokens", value: "$0.0009", delta: "−6%", note: "network median" },
  { label: "Pool balance", value: "$12,480", delta: "+$310", note: "vault balance, USDC" },
];

export const MOCK_RECEIPTS: MockReceipt[] = [
  { amount: "$0.0012", hash: "9f2c4b…e10a", host: "h-0f4c…", model: "Llama-3.1-8B", latency: "310ms" },
  { amount: "$0.0009", hash: "4a71d0…b39c", host: "h-7b1e…", model: "Qwen2.5-7B", latency: "288ms" },
  { amount: "$0.0015", hash: "c081ae…5d22", host: "h-2d90…", model: "Mistral-7B", latency: "402ms" },
];

export const MOCK_HERO = {
  hostsServing: 12,
  regions: 3,
  settledToday: "2,314",
};

export const MOCK_HOST_MATH = {
  pricePerReq: 0.0015,
  hostShare: 90,
  defaultReqDay: 4000,
};

export interface MockHost {
  address: string;
  modelId: string;
  pricePerReq: string;
  pricePer1kTokens: string;
  stake: string;
  active: boolean;
  calls24h: number;
  fail24h: number;
  reliability: number | null;
  region: string;
  latencyMs: number | null;
  verification: { lastCheck: number | null; checks: number; avgScore: number | null; failing: boolean } | null;
}

// Mirrors the design globe's 12 nodes (globe.html HOSTS).
export const MOCK_HOSTS: MockHost[] = [
  { address: "0x0f4c", modelId: "Llama-3.1-8B", pricePerReq: "1500", pricePer1kTokens: "900", stake: "10", active: true, calls24h: 8214, fail24h: 12, reliability: 0.998, region: "us-west", latencyMs: 310, verification: { lastCheck: null, checks: 19, avgScore: 1, failing: false } },
  { address: "0x7b1e", modelId: "Qwen2.5-7B", pricePerReq: "1200", pricePer1kTokens: "700", stake: "10", active: true, calls24h: 12044, fail24h: 30, reliability: 0.997, region: "us-east", latencyMs: 288, verification: { lastCheck: null, checks: 27, avgScore: 1, failing: false } },
  { address: "0x2d90", modelId: "Mistral-7B", pricePerReq: "1500", pricePer1kTokens: "1100", stake: "8", active: true, calls24h: 6102, fail24h: 22, reliability: 0.996, region: "ca-central", latencyMs: 402, verification: { lastCheck: null, checks: 15, avgScore: 1, failing: false } },
  { address: "0x51aa", modelId: "Llama-3.1-8B", pricePerReq: "1400", pricePer1kTokens: "800", stake: "6", active: true, calls24h: 4310, fail24h: 9, reliability: 0.998, region: "sa-east", latencyMs: 510, verification: { lastCheck: null, checks: 11, avgScore: 1, failing: false } },
  { address: "0x9c3f", modelId: "Qwen2.5-7B", pricePerReq: "1300", pricePer1kTokens: "750", stake: "12", active: true, calls24h: 5022, fail24h: 11, reliability: 0.998, region: "eu-central", latencyMs: 240, verification: { lastCheck: null, checks: 13, avgScore: 1, failing: false } },
  { address: "0x4e02", modelId: "Llama-3.1-8B", pricePerReq: "1600", pricePer1kTokens: "950", stake: "9", active: true, calls24h: 2874, fail24h: 40, reliability: 0.986, region: "eu-west", latencyMs: 265, verification: { lastCheck: null, checks: 8, avgScore: 1, failing: false } },
  { address: "0x8a55", modelId: "Mistral-7B", pricePerReq: "1100", pricePer1kTokens: "650", stake: "5", active: true, calls24h: 1930, fail24h: 61, reliability: 0.969, region: "eu-north", latencyMs: 390, verification: { lastCheck: null, checks: 6, avgScore: 1, failing: false } },
  { address: "0x6f18", modelId: "Qwen2.5-7B", pricePerReq: "1000", pricePer1kTokens: "600", stake: "4", active: true, calls24h: 2411, fail24h: 8, reliability: 0.997, region: "af-west", latencyMs: 620, verification: { lastCheck: null, checks: 7, avgScore: 1, failing: false } },
  { address: "0xb207", modelId: "Llama-3.1-8B", pricePerReq: "1250", pricePer1kTokens: "800", stake: "7", active: true, calls24h: 3102, fail24h: 15, reliability: 0.995, region: "ap-south", latencyMs: 480, verification: { lastCheck: null, checks: 9, avgScore: 1, failing: false } },
  { address: "0x3d61", modelId: "Qwen2.5-7B", pricePerReq: "1150", pricePer1kTokens: "700", stake: "6", active: true, calls24h: 1988, fail24h: 6, reliability: 0.997, region: "ap-se", latencyMs: 350, verification: { lastCheck: null, checks: 6, avgScore: 1, failing: false } },
  { address: "0xc94d", modelId: "Mistral-7B", pricePerReq: "1500", pricePer1kTokens: "900", stake: "8", active: false, calls24h: 0, fail24h: 210, reliability: 0, region: "ap-ne", latencyMs: null, verification: { lastCheck: null, checks: 3, avgScore: 1, failing: false } },
  { address: "0x1e73", modelId: "Llama-3.1-8B", pricePerReq: "1350", pricePer1kTokens: "850", stake: "5", active: true, calls24h: 915, fail24h: 44, reliability: 0.954, region: "ap-oce", latencyMs: 590, verification: { lastCheck: null, checks: 4, avgScore: 1, failing: false } },
];

// Team spend fixtures: shapes mirror GET members + GET requests responses exactly.
export interface MockTeamMember {
  did: string;
  email: string | null;
  walletAddress: string | null;
  role: "owner" | "manager" | "member";
  status: "active" | "invited";
  keyPrefix: string | null;
  allowanceCredits: number | null;
  effectiveCredits: number | null;
  spentCredits: number | null;
  createdAt: number;
}

export interface MockIncreaseRequest {
  id: string;
  orgId: string;
  memberDid: string;
  amountCredits: number;
  status: "pending" | "approved" | "denied";
  createdAt: number;
  decidedByDid?: string;
  decisionSigner?: string;
}

export const MOCK_TEAM_ORG = { id: "org_mock_intel", name: "Intelligence Technologies", defaultAllowanceCredits: 300 };

export const MOCK_TEAM_MEMBERS: MockTeamMember[] = [
  { did: "did:privy:owner1", email: "founder@inteltech.test", walletAddress: "0xAbC0000000000000000000000000000000000001", role: "owner", status: "active", keyPrefix: "deadbeef01", allowanceCredits: null, effectiveCredits: 300, spentCredits: 41, createdAt: 1756680000000 },
  { did: "did:privy:ana7", email: "ana@inteltech.test", walletAddress: "0xAbC0000000000000000000000000000000000002", role: "member", status: "active", keyPrefix: "deadbeef02", allowanceCredits: null, effectiveCredits: 300, spentCredits: 262, createdAt: 1756683600000 },
  { did: "did:privy:ben3", email: "ben@inteltech.test", walletAddress: "0xAbC0000000000000000000000000000000000003", role: "manager", status: "active", keyPrefix: "deadbeef03", allowanceCredits: 120, effectiveCredits: 120, spentCredits: 120, createdAt: 1756687200000 },
  { did: "did:privy:cat9", email: "cat@inteltech.test", walletAddress: null, role: "member", status: "active", keyPrefix: null, allowanceCredits: null, effectiveCredits: 300, spentCredits: null, createdAt: 1756690800000 },
];

export const MOCK_TEAM_REQUESTS: MockIncreaseRequest[] = [
  { id: "req_mock_1", orgId: "org_mock_intel", memberDid: "did:privy:ana7", amountCredits: 450, status: "pending", createdAt: 1756694400000 },
  { id: "req_mock_0", orgId: "org_mock_intel", memberDid: "did:privy:ben3", amountCredits: 200, status: "approved", createdAt: 1756689000000, decidedByDid: "did:privy:owner1", decisionSigner: "0xAbC0000000000000000000000000000000000001" },
];

// Security tap fixtures: shapes mirror GET /api/security/taps exactly.
export interface MockTap {
  id: string;
  kind: "heartbeat" | "stake-release";
  params: Record<string, string>;
  actionHash: string;
  approveMemo: string;
  approveAmountTinybar: number;
  status: "pending" | "approved" | "executed" | "failed";
  createdAt: number;
  tapTx?: string;
  tapSigner?: string;
  execTx?: string;
  execError?: string;
}

export const MOCK_TAPS_META = { ringBackend: "ring", tapAccount: "0.0.10378181" };

export const MOCK_TAPS: MockTap[] = [
  {
    id: "tap_mock_1",
    kind: "heartbeat",
    params: {},
    actionHash: "0x9f2c4b8e11a0d7c3e10a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6",
    approveMemo: "tor-approve:tap_mock_1:0x9f2c4b8e11a0d7c3e10a",
    approveAmountTinybar: 15177,
    status: "pending",
    createdAt: 1756687200000,
  },
  {
    id: "tap_mock_0",
    kind: "stake-release",
    params: {},
    actionHash: "0x4a71d0b39cc081ae5d220f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f4",
    approveMemo: "tor-approve:tap_mock_0:0x4a71d0b39cc081ae5d22",
    approveAmountTinybar: 18432,
    status: "executed",
    createdAt: 1756676400000,
    tapTx: "0.0.10378181@1756676460.123456789",
    tapSigner: "0.0.10378181",
    execTx: "0x8ad14c02e7bb41d9c03f5a6e82910c4d7b3e5f6a81920b3c4d5e6f708192a3b4",
  },
];

// --- Demo mode fixtures -------------------------------------------------------
// Shown only when demo mode is on (see components/mock.tsx). Shapes mirror the live
// responses exactly so the signed-in surfaces render as they would for a real account.

export interface MockAgentPolicy {
  dailyCredits: number | null;
  monthlyCredits: number | null;
  lifetimeCredits: number | null;
  maxRequestCredits: number | null;
  models: string[] | null;
  regions: string[] | null;
  verifiedOnly: boolean;
  requestsPerMinute: number | null;
  maxConcurrent: number | null;
  credentialTtlDays: number | null;
  exceptions: { credits: boolean };
}

export interface MockAgent {
  id: string;
  name: string;
  description: string;
  orgId: string | null;
  sponsorDid: string | null;
  payerKind: "team" | "personal";
  state: "ready" | "paused" | "revoked";
  policy: MockAgentPolicy;
  policyRevision: number;
  ledgerAddress: string | null;
  budgetAddress: string | null;
  createdAt: number;
}

export const MOCK_AGENTS: MockAgent[] = [
  {
    id: "agt_demo_coder",
    name: "Coding agent",
    description: "Opens and reviews pull requests. Every limit is set; it asks before it spends more.",
    orgId: MOCK_TEAM_ORG.id,
    sponsorDid: "did:privy:owner1",
    payerKind: "team",
    state: "ready",
    policy: {
      dailyCredits: 500,
      monthlyCredits: 8000,
      lifetimeCredits: 50000,
      maxRequestCredits: 40,
      models: ["Llama-3.1-8B"],
      regions: ["eu-central", "eu-west"],
      verifiedOnly: true,
      requestsPerMinute: 30,
      maxConcurrent: 2,
      credentialTtlDays: 90,
      exceptions: { credits: true },
    },
    policyRevision: 4,
    ledgerAddress: "0xAbC0000000000000000000000000000000000001",
    budgetAddress: "0xB0d9e4C1a7F3025b8E6104D2a59Cf7188B30aE41",
    createdAt: 1756680000000,
  },
  {
    id: "agt_demo_researcher",
    name: "Market researcher",
    description: "Reads public filings on request. Asks before it spends more.",
    orgId: MOCK_TEAM_ORG.id,
    sponsorDid: "did:privy:owner1",
    payerKind: "team",
    state: "ready",
    policy: {
      dailyCredits: 250,
      monthlyCredits: 4000,
      lifetimeCredits: null,
      maxRequestCredits: 25,
      models: ["Qwen2.5-7B", "Mistral-7B"],
      regions: null,
      verifiedOnly: false,
      requestsPerMinute: 20,
      maxConcurrent: 1,
      credentialTtlDays: 30,
      exceptions: { credits: true },
    },
    policyRevision: 2,
    ledgerAddress: "0xAbC0000000000000000000000000000000000001",
    budgetAddress: "0x77C1f8B3a5E204d9C6b18e70Ff3a2D5419Ce8b06",
    createdAt: 1756683600000,
  },
  {
    id: "agt_demo_scraper",
    name: "Docs indexer",
    description: "Paused after it hit its ceiling twice in one day.",
    orgId: null,
    sponsorDid: null,
    payerKind: "personal",
    state: "paused",
    policy: {
      dailyCredits: 100,
      monthlyCredits: null,
      lifetimeCredits: 2000,
      maxRequestCredits: 10,
      models: null,
      regions: null,
      verifiedOnly: false,
      requestsPerMinute: 10,
      maxConcurrent: 1,
      credentialTtlDays: null,
      exceptions: { credits: false },
    },
    policyRevision: 1,
    ledgerAddress: null,
    budgetAddress: "0x2Fa6d0917Bb4e3C580d1A2e64C7b93F015De8a72",
    createdAt: 1756690800000,
  },
];

export const MOCK_AGENT_DETAILS: Record<string, {
  agent: MockAgent;
  effective: { monthlyCredits?: number | null; memberAllowance?: number | null; models?: string[] | null; sponsorActive?: boolean };
  usage: { period: string; spent: number; reserved: number; limit: number | null; remaining: number | null }[];
  credentials: { id: string; prefix: string; issuedAt: number; expiresAt: number | null; revokedAt: number | null }[];
  approvals: { id: string; state: string; additionalCredits: number; createdAt: number; limits: { label: string }[] }[];
  receipts: { id: string; ts: number; amountCredits?: string; modelId?: string }[];
}> = {
  agt_demo_coder: {
    agent: MOCK_AGENTS[0],
    effective: { monthlyCredits: 8000, memberAllowance: 300, models: ["Llama-3.1-8B"], sponsorActive: true },
    usage: [
      { period: "d:today", spent: 182, reserved: 0, limit: 500, remaining: 318 },
      { period: "m:this-month", spent: 3940, reserved: 0, limit: 8000, remaining: 4060 },
      { period: "lifetime", spent: 11204, reserved: 0, limit: 50000, remaining: 38796 },
    ],
    credentials: [{ id: "cred_demo_1", prefix: "a41f9c22", issuedAt: 1756680000000, expiresAt: 1764456000000, revokedAt: null }],
    approvals: [
      { id: "apr_demo_1", state: "approved", additionalCredits: 250, createdAt: 1756694400000, limits: [{ label: "daily 500" }] },
    ],
    receipts: [
      { id: "9f2c4b8e11a0d7c3", ts: 1756694400000, amountCredits: "12", modelId: "Llama-3.1-8B" },
      { id: "4a71d0b39cc081ae", ts: 1756690800000, amountCredits: "9", modelId: "Llama-3.1-8B" },
    ],
  },
  agt_demo_researcher: {
    agent: MOCK_AGENTS[1],
    effective: { monthlyCredits: 4000, memberAllowance: 300, models: ["Qwen2.5-7B", "Mistral-7B"], sponsorActive: true },
    usage: [
      { period: "d:today", spent: 61, reserved: 4, limit: 250, remaining: 185 },
      { period: "m:this-month", spent: 1290, reserved: 0, limit: 4000, remaining: 2710 },
      { period: "lifetime", spent: 4102, reserved: 0, limit: null, remaining: null },
    ],
    credentials: [{ id: "cred_demo_2", prefix: "7b1e03da", issuedAt: 1756683600000, expiresAt: 1759275600000, revokedAt: null }],
    approvals: [
      { id: "apr_demo_2", state: "pending", additionalCredits: 120, createdAt: 1756698000000, limits: [{ label: "daily 250" }] },
    ],
    receipts: [{ id: "c081ae5d2201f3b7", ts: 1756693000000, amountCredits: "7", modelId: "Qwen2.5-7B" }],
  },
  agt_demo_scraper: {
    agent: MOCK_AGENTS[2],
    effective: { monthlyCredits: null, memberAllowance: null, models: null, sponsorActive: false },
    usage: [
      { period: "d:today", spent: 100, reserved: 0, limit: 100, remaining: 0 },
      { period: "lifetime", spent: 1870, reserved: 0, limit: 2000, remaining: 130 },
    ],
    credentials: [{ id: "cred_demo_3", prefix: "2d90ff10", issuedAt: 1756690800000, expiresAt: null, revokedAt: null }],
    approvals: [],
    receipts: [],
  },
};

/// @notice Account surfaces (balances, spend, recent calls) for a demo visitor.
export const MOCK_ACCOUNT = {
  hbar: "42.5180",
  credits: "6120",
  hederaId: "0.0.10482113",
  reqCount: 1284,
  paidUsd: 1.284,
  recentCalls: [
    { id: "9f2c4b8e11a0d7c3e10a", ts: 1756694400000, amountCredits: "12", modelId: "Llama-3.1-8B", latencyMs: 310 },
    { id: "4a71d0b39cc081ae5d22", ts: 1756690800000, amountCredits: "9", modelId: "Qwen2.5-7B", latencyMs: 288 },
    { id: "c081ae5d220f1e2d3c4b", ts: 1756687200000, amountCredits: "15", modelId: "Mistral-7B", latencyMs: 402 },
    { id: "8ad14c02e7bb41d9c03f", ts: 1756683600000, amountCredits: "11", modelId: "Llama-3.1-8B", latencyMs: 265 },
    { id: "1e73b207c94d3d6109aa", ts: 1756680000000, amountCredits: "8", modelId: "Qwen2.5-7B", latencyMs: 240 },
  ],
  modelSplit: [
    { model: "Llama-3.1-8B", calls: 612, tokens: 486_300 },
    { model: "Qwen2.5-7B", calls: 431, tokens: 302_180 },
    { model: "Mistral-7B", calls: 241, tokens: 171_940 },
  ],
  vaultTxs: [
    { id: "0xbc6a0fdf538d3bdac8adb9230d9a167c972f8874", ts: 1756672800000, hbar: 10, kind: "subscribe" },
    { id: "0x02bdc9f322bd7da968e3b73225729c3d7c60629a", ts: 1756586400000, hbar: -0.42, kind: "call" },
    { id: "0x7d3e5f6a81920b3c4d5e6f708192a3b4c5d6e7f8", ts: 1756500000000, hbar: 25, kind: "subscribe" },
  ],
};

/// @notice Wallet-attributed receipts for /usage.
export const MOCK_USAGE_RECEIPTS = MOCK_ACCOUNT.recentCalls.map((c) => ({
  id: c.id,
  modelId: c.modelId,
  host: "h-0f4c…",
  priceWei: "1500",
  latencyMs: c.latencyMs,
  amountCredits: c.amountCredits,
  ts: c.ts,
}));
