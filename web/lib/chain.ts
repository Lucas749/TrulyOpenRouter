// HashScan URL builders (Hedera testnet). Every money/serving number links out through these —
// never a bare "#" in product UI. Topic links land on the topic (per-message anchors aren't stable).

const ROOT = "https://hashscan.io/testnet";

export const HCS_AUDIT_TOPIC = "0.0.10379640";
export const USDC_TOKEN = "0.0.429274";

export const txUrl = (hash?: string | null): string => (hash ? `${ROOT}/transaction/${hash}` : "#");
export const accountUrl = (id?: string | null): string => (id ? `${ROOT}/account/${id}` : "#");
export const contractUrl = (addr?: string | null): string => (addr ? `${ROOT}/contract/${addr}` : "#");
export const tokenUrl = (id?: string | null): string => (id ? `${ROOT}/token/${id}` : "#");
export const topicUrl = (id: string = HCS_AUDIT_TOPIC): string => `${ROOT}/topic/${id}`;
