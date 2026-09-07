"use client";

// Mock data — copied EXACTLY from the design slice (landing .dc.html renderVals).
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
  role: "owner" | "member";
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
  decidedByDid: string | null;
  ownerWallet: string | null;
  decision: "approve" | "deny" | null;
  signature: string | null;
}

export const MOCK_TEAM_ORG = { id: "org_mock_acme", defaultAllowanceCredits: 300 };

export const MOCK_TEAM_MEMBERS: MockTeamMember[] = [
  { did: "did:privy:owner1", email: "founder@acme.test", walletAddress: "0xAbC0000000000000000000000000000000000001", role: "owner", keyPrefix: "deadbeef01", allowanceCredits: null, effectiveCredits: 300, spentCredits: 41, createdAt: 1756680000000 },
  { did: "did:privy:ana7", email: "ana@acme.test", walletAddress: "0xAbC0000000000000000000000000000000000002", role: "member", keyPrefix: "deadbeef02", allowanceCredits: null, effectiveCredits: 300, spentCredits: 262, createdAt: 1756683600000 },
  { did: "did:privy:ben3", email: "ben@acme.test", walletAddress: "0xAbC0000000000000000000000000000000000003", role: "member", keyPrefix: "deadbeef03", allowanceCredits: 120, effectiveCredits: 120, spentCredits: 120, createdAt: 1756687200000 },
  { did: "did:privy:cat9", email: "cat@acme.test", walletAddress: null, role: "member", keyPrefix: null, allowanceCredits: null, effectiveCredits: 300, spentCredits: null, createdAt: 1756690800000 },
];

export const MOCK_TEAM_REQUESTS: MockIncreaseRequest[] = [
  { id: "req_mock_1", orgId: "org_mock_acme", memberDid: "did:privy:ana7", amountCredits: 450, status: "pending", createdAt: 1756694400000, decidedByDid: null, ownerWallet: null, decision: null, signature: null },
  { id: "req_mock_0", orgId: "org_mock_acme", memberDid: "did:privy:ben3", amountCredits: 200, status: "approved", createdAt: 1756689000000, decidedByDid: "did:privy:owner1", ownerWallet: "0xAbC0000000000000000000000000000000000001", decision: "approve", signature: "0xmock" },
];
