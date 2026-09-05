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
