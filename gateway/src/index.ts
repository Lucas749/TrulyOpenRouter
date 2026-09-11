import express from "express";
import { randomUUID } from "node:crypto";
import { boundedCompletion, MemoryBillingRequests, PgBillingRequests, type BillingRequests } from "./billing.js";
import { privySession, privySubscriber, subscriberWallet, SubscriberError, type VerifySession, type VerifySubscriber } from "./subscriber.js";
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { paymentMiddleware } from "@x402/express";
import { createResourceServer } from "./x402.js";
import { fetchEligibleHosts, fileChallenge, REGISTRY_ABI, type HostInfo } from "./registry.js";
import { issueKey, type KeyStore, MemoryKeyStore, PgKeyStore, verifyKey, type KeyScopes } from "./keys.js";
import { allowanceExceeded, type CapStore, PgCapStore, SpendCapStore, sumSpent } from "./allowances.js";
import { MemoryOrgRules, type OrgRuleStore, PgOrgRules } from "./orgrules.js";
import { buildReceipt, MemoryReceiptLog, PgReceiptLog, type ReceiptLog, sha256hex } from "./receipts.js";
import { db, dbEnabled, ensureSchema } from "./db.js";
import { FaucetError, PgHostFaucet, type HostFaucet } from "./faucet.js";
import { EndpointAvailability } from "./availability.js";
import { type Health, MemoryHealth, PgHealth } from "./health.js";
import { createVaultDebit, createVaultSpendCapWriter, readVaultCredits, type SpendCapWriter } from "./vault.js";
import { type HostMeta, MemoryHostMeta, PgHostMeta, validRegion } from "./hostmeta.js";
import { logReceiptHcs, type HcsConfig } from "./hcs.js";
import { budgetAddressFor } from "./budget.js";
import { type DeviceFlow, MemoryDeviceFlow, PgDeviceFlow } from "./device.js";
import { proxyWithFallback, selectUpstream, type X402Creds } from "./upstream.js";
import { loadReferences, MemoryVerifier, PgVerifier, PROBES, spotCheck, type CheckReport, type Verifier } from "./verify.js";
import { createPaidFetch } from "./payer.js";
import { priceForCall, settleCall, type DebitFn } from "./settle.js";
import { FileTapStore, PgTapStore, tapInstruction, type TapKind, type TapStatus, type TapStore, verifyTapTransfer } from "./taps.js";
import { cachedGeo } from "./geo.js";
import { createTapExecutor } from "./tap-exec.js";
import { hostEarnings } from "./host-earnings.js";
import { applyHostSettings, authorizeHostSettings, HostSettingsError, MemoryHostRuntime, PgHostRuntime, type HostRuntimeStore } from "./host-runtime.js";
import { normalizeSnapshot, PgTeams, TeamError } from "./teams.js";
import { approveTreasuryIntent, proposeTreasuryIntent, provisionTeamWallet, reconcileTreasuryIntent, rejectTreasuryIntent, TEST_USDC_ADDRESS, TreasuryError, type TreasuryDeps } from "./treasury.js";
import { AGENT_KEY_PREFIX, AgentError, normalizePolicy, PgAgents, type Agent, type AgentPolicy } from "./agents.js";
import { PgAccounting, periods, type CounterLimit, type Violation } from "./accounting.js";
import { ApprovalError, approvalAuthority, approvalMessage, decideAgentApproval, PgApprovals, type AgentApproval, type ApprovalMethod } from "./approvals.js";
import type { Identity, TeamMember } from "./teams.js";
import { challengeField, issueChallenge, LedgerChallengeError, messageSigner, stableJson, verifyChallenge } from "./ledger.js";

/// @notice Thrown when an org rule blocks a call. Caught by the chat handler
/// into a plain-language 403 (module scope: the catch lives outside try).
class OrgPolicyDenied extends Error {
  constructor(why: string) {
    super(`Not allowed in your organization (${why})`);
  }
}

/// @notice An eligible limit was reached before any payment; a human approval can help.
class ApprovalRequired extends Error {
  constructor(public body: Record<string, unknown>) {
    super(String(body.message));
  }
}

const stripDid = (id: string | null | undefined) => String(id ?? "").replace(/^did:privy:/, "");
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const constraintName = (v: Violation) =>
  v.subject.startsWith("member:") ? "member_allowance" : v.period.startsWith("d:") ? "daily_credits" : v.period.startsWith("m:") ? "monthly_credits" : "lifetime_credits";

export interface GatewayOptions {
  billing?: BillingRequests;
  requireSubscription?: boolean; // secure by default; false only in isolated development/tests
  verifySubscriber?: VerifySubscriber;
  subscriptionCredits?: (payer: Address) => Promise<bigint | null>;
  availability?: Pick<EndpointAvailability, "check">;
  faucet?: HostFaucet;
  payTo?: string; // Hedera service account; empty = dev mode (x402 gate off)
  registry?: Address;
  legacyRegistries?: Address[];
  rpcUrl?: string;
  knownModels?: string[];
  runtime?: HostRuntimeStore;
  vaultAddress?: Address; // pool balance source; absent = omitted (frontend shows —)
  fallbackUpstream?: string; // e.g. http://localhost:11434
  fetchHosts?: (modelId: string) => Promise<HostInfo[]>;
  keys?: KeyStore;
  receipts?: ReceiptLog;
  x402?: X402Creds; // gateway payer for gated hosts (Key Ring in prod, env in dev)
  meta?: HostMeta; // self-reported regions; absent = collection off
  hcs?: HcsConfig; // audit topic; absent = no onchain log (receipts still served)
  devices?: DeviceFlow; // CLI device-code login; absent = endpoint 501
  health?: Health; // upstream failure window; absent = collection off
  verifier?: Verifier; // model-identity spot checks; absent = collection off
  spendCaps?: CapStore; // member allowances; absent = no cap enforcement
  orgRules?: OrgRuleStore; // firm rules mirror; absent = no org enforcement
  teams?: PgTeams; // team finance mirror (Postgres); absent = team endpoints 501
  verifySession?: VerifySession; // Privy subject + linked wallets for team routes
  treasury?: TreasuryDeps; // Privy organization wallets; absent = treasury endpoints 501
  agents?: PgAgents; // agent identities and credentials (Postgres); absent = agent endpoints 501
  accounting?: PgAccounting; // durable counters for strict agent and member caps
  approvals?: PgApprovals; // human approvals for over-limit agent requests
  appOrigin?: string; // origin bound into approval messages and review links
  taps?: TapStore; // PENDING_TAP queue; absent = tap endpoints 501
  tapExecutor?: (kind: TapKind) => Promise<string>; // test override; default = Hedera via ring-held host key
  adminToken?: string; // authorizes /api/admin/* (env GATEWAY_ADMIN_TOKEN fallback)
  settle?: DebitFn; // Vault debit; absent = dev mode (no charging)
  spendCapWriter?: SpendCapWriter; // onchain allowance mirror; absent = chain sync unavailable (old vault / dev)
}

/// @notice Paid sender for verification probes: probes travel the SAME path as user
/// traffic (x402 when gated), so hosts earn for them and receipts stay complete.
function verificationSender(opts: GatewayOptions, endpoint: string) {
  return async (body: unknown) => {
    const paidFetch = opts.x402
      ? createPaidFetch({ accountId: opts.x402.accountId, privateKey: opts.x402.privateKey })
      : undefined;
    const { out } = await proxyWithFallback(endpoint, body, opts.x402, paidFetch);
    return out;
  };
}

/// @notice One sampling tick: random active host with references → spot-check → record.
/// Failing hosts are challenged onchain only when explicitly enabled (VERIFY_AUTO_CHALLENGE=1
/// + registry + OPERATOR_KEY); otherwise the failure is logged and routing drains regardless.
export async function verifyOnce(opts: GatewayOptions): Promise<CheckReport[]> {
  if (!opts.verifier) return [];
  const models = await knownModels(opts);
  const refs = loadReferences();
  const seen = new Map<string, HostInfo>();
  for (const id of models) {
    for (const h of await resolveHosts(opts, id)) seen.set(h.address, h);
  }
  const candidates = [...seen.values()].filter((h) => h.active && refs[h.modelId]);
  if (!candidates.length) return [];
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  const report = await spotCheck(
    target,
    verificationSender(opts, target.endpoint),
    PROBES,
    refs[target.modelId].refs,
    { model: target.modelId },
  );
  await opts.verifier.record(report);
  const summary = await opts.verifier.verification(target.address, target.modelId);
  console.log(
    `verify ${target.address.slice(0, 10)}… ${target.modelId}: ${report.passed}/${report.total}` +
      (report.inconclusive ? " (inconclusive)" : "") +
      (summary.failing ? " FAILING" : ""),
  );
  if (summary.failing) {
    if (process.env.VERIFY_AUTO_CHALLENGE === "1" && opts.registry && opts.rpcUrl && process.env.OPERATOR_KEY) {
      try {
        const tx = await fileChallenge(
          {
            rpcUrl: opts.rpcUrl,
            registry: target.registry ?? opts.registry,
            operatorKey: process.env.OPERATOR_KEY as `0x${string}`,
          },
          target.address,
          `0x${sha256hex(`${report.host}|${report.ts}|${report.passed}/${report.total}`)}`,
        );
        console.log(`challenge filed ✓ ${target.address} tx=${tx.slice(0, 18)}…`);
      } catch (e) {
        console.error(`challenge failed: ${String(e).slice(0, 200)}`);
      }
    } else {
      console.warn(`host failing verification, challenge not configured: ${target.address}`);
    }
  }
  return [report];
}

/// @notice Background sampling. VERIFY_INTERVAL_MS=0/unset = off. unref'd so tests exit cleanly.
export function startVerifyLoop(opts: GatewayOptions): void {
  const intervalMs = Number(process.env.VERIFY_INTERVAL_MS ?? 0);
  if (!opts.verifier || !intervalMs) return;
  const timer = setInterval(() => {
    verifyOnce(opts).catch((e) => console.error(`verify tick: ${String(e).slice(0, 200)}`));
  }, intervalMs);
  (timer as any).unref?.();
  console.log(`verify loop on: every ${intervalMs}ms`);
}

async function resolveRegisteredHosts(opts: GatewayOptions, modelId: string): Promise<HostInfo[]> {
  if (opts.fetchHosts) return opts.fetchHosts(modelId);
  // Bootstrap hosts remain available alongside permissionless registry hosts.
  let bootstrap: HostInfo[] = [];
  if (process.env.HOSTS_JSON) {
    try {
      const all = JSON.parse(process.env.HOSTS_JSON) as Partial<HostInfo>[];
      bootstrap = all
        .filter((h) => h.modelId === modelId)
        .map((h, i) => ({
          address: (h.address ?? `0x${String(i + 1).padStart(40, "0")}`) as `0x${string}`,
          endpoint: String(h.endpoint),
          modelId: String(h.modelId),
          modelDigest: (h.modelDigest ?? "demo") as `0x${string}`,
          pricePerReq: BigInt(h.pricePerReq ?? 1),
          pricePer1kTokens: BigInt(h.pricePer1kTokens ?? 0),
          stake: BigInt(h.stake ?? 0),
          active: true,
          lastHeartbeat: Date.now(),
          latencyMs: 200,
          reliability: 1,
        }));
    } catch {
      console.warn("HOSTS_JSON is invalid; using registry discovery");
    }
  }
  if (!opts.registry || !opts.rpcUrl) return bootstrap;
  const client = createPublicClient({ transport: http(opts.rpcUrl) });
  const registries = [...new Set([opts.registry, ...(opts.legacyRegistries ?? [])].map((r) => r.toLowerCase() as Address))];
  const results = await Promise.allSettled(registries.map((registry) => fetchEligibleHosts(client, registry, modelId)));
  const hosts = new Map(bootstrap.map((h) => [h.address.toLowerCase(), h]));
  // Prefer the primary registry over legacy records for the same key.
  for (let i = results.length - 1; i >= 0; i--) {
    const result = results[i];
    if (result.status === "fulfilled") {
      for (const host of result.value) hosts.set(host.address.toLowerCase(), host);
    } else {
      console.warn(`Registry discovery unavailable: ${registries[i]}`);
    }
  }
  if (!hosts.size && results.every((r) => r.status === "rejected")) throw new Error("Host registries are unavailable");
  return [...hosts.values()];
}

export async function knownModels(opts: GatewayOptions): Promise<string[]> {
  const records = await opts.runtime?.list() ?? [];
  return [...new Set([...(opts.knownModels ?? (process.env.MODELS ?? "").split(",").filter(Boolean)), ...records.flatMap(r => [r.registeredModelId, r.modelId])])];
}

export async function resolveHosts(opts: GatewayOptions, modelId: string): Promise<HostInfo[]> {
  const records = await opts.runtime?.list() ?? [];
  const models = new Set([modelId, ...records.filter(r => r.modelId === modelId).map(r => r.registeredModelId)]);
  const settings = new Map(records.map(r => [r.address.toLowerCase(), r]));
  const groups = await Promise.all([...models].map(id => resolveRegisteredHosts(opts, id)));
  const hosts = new Map<string, HostInfo>();
  for (const base of groups.flat()) {
    const host = applyHostSettings(base, settings.get(base.address.toLowerCase()));
    if (host.modelId === modelId) hosts.set(host.address.toLowerCase(), host);
  }
  return Promise.all([...hosts.values()].map(async host => {
    if (!opts.availability) return host;
    const availability = await opts.availability.check(host.endpoint);
    return { ...host, registeredActive: host.registeredActive ?? host.active, availability, active: host.active && availability.reachable };
  }));
}

export function createApp(opts: GatewayOptions = {}) {
  opts.runtime ??= new MemoryHostRuntime();
  const requireSubscription = opts.requireSubscription !== false;
  const billing = opts.billing ?? new MemoryBillingRequests();
  const origin = (opts.appOrigin ?? process.env.APP_ORIGIN ?? "https://trulyopenrouter.vercel.app").replace(/\/+$/, "");
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, service: "tor-gateway" }));

  // Single source of chain truth for CLIs and frontends (no hardcoded addresses downstream).
  app.get("/api/config", async (_req, res) => {
    res.json({
      chainId: 296,
      chain: "hedera-testnet",
      rpcUrl: opts.rpcUrl ?? process.env.RPC_URL ?? null,
      registry: opts.registry ?? process.env.REGISTRY ?? null,
      legacyRegistries: opts.legacyRegistries ?? [],
      vault: opts.vaultAddress ?? process.env.VAULT_ADDRESS ?? null,
      models: await knownModels(opts),
      hostRuntime: true,
      facilitator: "https://api.testnet.blocky402.com",
      usdc: "0.0.429274",
    });
  });

  const payTo = opts.payTo ?? process.env.HEDERA_SERVICE_ACCOUNT_ID ?? "";
  if (payTo) {
    app.use(
      paymentMiddleware(
        {
          "POST /v1/chat/completions": {
            accepts: [{ scheme: "exact", price: "$0.001", network: "hedera:testnet", payTo }],
            description: "TrulyOpenRouter inference — testnet USDC",
            mimeType: "application/json",
          },
        },
        createResourceServer(),
      ),
    );
  } else {
    console.warn("dev mode: x402 gate disabled (no HEDERA_SERVICE_ACCOUNT_ID)");
  }

  app.get("/v1/models", async (_req, res) => {
    const models = await knownModels(opts);
    const now = Date.now();
    const all = (await opts.receipts?.list(10_000)) ?? [];
    const day = 86_400_000;
    const data = [];
    for (const id of models) {
      const hosts = (await resolveHosts(opts, id)).filter(h => h.active);
      const mine = all.filter((r) => r.modelId === id && now - r.ts < day);
      const tokens = mine.reduce((a, r) => a + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0);
      const credits = mine.reduce((a, r) => a + BigInt(r.amountCredits ?? "0"), 0n);
      data.push({
        id,
        owned_by: "trulyopenrouter",
        hosts: hosts.length,
        minPricePerReq: hosts.length ? String(hosts.reduce((a, b) => (a.pricePerReq < b.pricePerReq ? a : b)).pricePerReq) : null,
        calls24h: mine.length,
        tokens24h: tokens,
        // $ = credits × 0.001 by defined unit (receipts.ts money rule)
        avgCreditsPer1kTokens: tokens > 0 ? String((credits * 1000n) / BigInt(tokens)) : null,
      });
    }
    res.json({ data });
  });

  app.post("/v1/chat/completions", async (req, res) => {
    let selectedHost: HostInfo | null = null;
    const requestId = randomUUID();
    let billingPayer: string | null = null;
    let paymentStarted = false;
    let availableCredits = 0n;
    // Strict caps: the reservation this request holds on durable counters, if any.
    let strict: { grantId: string | null; maximum: number } | null = null;
    try {
      const model = req.body?.model;
      if (typeof model !== "string" || !model) {
        res.status(400).json({ error: { message: "missing model", type: "invalid_request" } });
        return;
      }
      const claimed = typeof req.body?.userHandle === "string" ? req.body.userHandle.toLowerCase() : "";
      let walletHandle = !requireSubscription && /^0x[0-9a-f]{40}$/.test(claimed) ? `wallet:${claimed}` : null;
      const presented = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
      let keyPrefix: string | undefined;
      // Team billing: an active member (or their team agent) spends the team wallet's
      // vault credits. Membership and payer come only from the mirror.
      let teamBilling: { orgId: string; did: string; wallet: string; allowance: number | null } | null = null;
      // Agent credentials: a stable agent identity, its payer, and strict limits.
      let agentCall: { agent: Agent; payer: string } | null = null;
      if (presented?.startsWith(AGENT_KEY_PREFIX)) {
        if (!opts.agents || !opts.accounting || !opts.approvals) throw new SubscriberError(503, "billing_unavailable", "Agent access is unavailable. Try again later.");
        const resolved = await opts.agents.authenticate(presented);
        if (!resolved) throw new SubscriberError(401, "invalid_api_key", "This agent credential is invalid, expired, or revoked.");
        const agent = resolved.agent;
        if (agent.state !== "ready") throw new SubscriberError(403, agent.state === "paused" ? "agent_paused" : "agent_revoked", `This agent is ${agent.state}.`);
        if (agent.policy.models && !agent.policy.models.includes(model)) throw new SubscriberError(403, "model_not_allowed", `This agent may not use ${model}.`);
        if (agent.orgId) {
          if (!opts.teams) throw new SubscriberError(503, "billing_unavailable", "Team billing is unavailable. Try again later.");
          const [team, sponsor] = await Promise.all([opts.teams.team(agent.orgId), opts.teams.memberFor(agent.orgId, { userId: agent.sponsorDid ?? "", wallets: [] })]);
          if (!team || team.state !== "active" || !team.walletAddress) throw new SubscriberError(409, "team_wallet_inactive", "The agent's team has no active treasury wallet.");
          if (!sponsor) throw new SubscriberError(403, "sponsor_inactive", "The member sponsoring this agent is no longer active in the team.");
          teamBilling = { orgId: agent.orgId, did: sponsor.did, wallet: team.walletAddress, allowance: sponsor.allowanceCredits ?? team.defaultAllowanceCredits };
          agentCall = { agent, payer: team.walletAddress };
        } else {
          const budget = agent.budgetLabel ? budgetAddressFor(agent.budgetLabel) : null;
          if (!budget) throw new SubscriberError(503, "billing_unavailable", "The agent's budget account is unavailable.");
          agentCall = { agent, payer: budget.toLowerCase() };
        }
        if (agent.policy.requestsPerMinute != null) {
          const since = Date.now() - 60_000;
          const recent = ((await opts.receipts?.list(10_000)) ?? []).filter((r) => r.agent === agent.id && r.ts >= since).length;
          if (recent >= agent.policy.requestsPerMinute) throw new SubscriberError(429, "rate_limited", `This agent allows ${agent.policy.requestsPerMinute} requests per minute. Retry shortly.`);
        }
        if (agent.policy.maxConcurrent != null && (await opts.accounting.openReservations(agent.id)) >= agent.policy.maxConcurrent) {
          throw new SubscriberError(429, "concurrency_limited", "This agent has reached its concurrent request limit.");
        }
      } else if (presented?.startsWith("tor_sk_")) {
        if (!opts.keys) throw new SubscriberError(503, "auth_unavailable", "API key verification is unavailable.");
        const record = await opts.keys.find(presented);
        if (!record || !verifyKey(presented, record)) {
          res.status(401).json({ error: { message: "invalid api key", type: "invalid_api_key" } });
          return;
        }
        keyPrefix = record.prefix;
        if (record.scopes.models && !record.scopes.models.includes(model)) {
          res.status(404).json({ error: { message: `model ${model} not in key scope`, type: "model_not_found" } });
          return;
        }
        // Member allowance gate (team pools): pre-flight only — one call can still
        // overshoot slightly since true cost is known post-generation. The onchain
        // vault debit is the final backstop; this gate gives the clean 429 UX.
        if (opts.spendCaps) {
          const cap = await opts.spendCaps.getCap(keyPrefix);
          if (cap) {
            const spent = sumSpent((await opts.receipts?.list(10_000)) ?? [], `key:${keyPrefix}`, cap.periodStart);
            if (allowanceExceeded(spent, cap.cap)) {
              res.status(429).json({
                error: {
                  message: "monthly allowance exhausted — ask your team owner for an increase",
                  type: "quota_exceeded",
                },
              });
              return;
            }
          }
        }
      }
      // The request names the team for a browser session; the mirror decides the rest.
      const teamId = typeof req.body?.tor_team === "string" && req.body.tor_team ? req.body.tor_team : null;
      if (teamId && !keyPrefix && !agentCall) {
        if (!opts.teams || !opts.verifySession) throw new SubscriberError(503, "billing_unavailable", "Team billing is unavailable. Try again later.");
        if (!presented) throw new SubscriberError(401, "authentication_required", "Sign in to use team credits.");
        const identity = await opts.verifySession(presented);
        const [member, team] = await Promise.all([opts.teams.memberFor(teamId, identity), opts.teams.team(teamId)]);
        if (!member) throw new SubscriberError(403, "team_access_denied", "You are not an active member of this team.");
        if (!team || team.state !== "active" || !team.walletAddress) {
          throw new SubscriberError(409, "team_wallet_inactive", "This team has no active treasury wallet yet.");
        }
        teamBilling = { orgId: teamId, did: member.did, wallet: team.walletAddress, allowance: member.allowanceCredits ?? team.defaultAllowanceCredits };
      }
      if (requireSubscription && !keyPrefix && !teamBilling && !agentCall) {
        walletHandle = `wallet:${await subscriberWallet(presented, req.body?.userHandle, opts.verifySubscriber)}`;
      }
      const payer = (agentCall ? agentCall.payer : keyPrefix ? budgetAddressFor(keyPrefix) : teamBilling?.wallet ?? walletHandle?.slice("wallet:".length)) || null;
      if (requireSubscription) {
        if (!payer || !opts.settle || (!opts.subscriptionCredits && (!opts.vaultAddress || !opts.rpcUrl))) {
          throw new SubscriberError(503, "billing_unavailable", "Subscription billing is unavailable. Try again later.");
        }
        if (!await billing.acquire(payer, requestId)) {
          throw new SubscriberError(409, "billing_pending", "A previous request is running or its payment needs reconciliation. Wait before retrying.");
        }
        billingPayer = payer;
        const credits = await (opts.subscriptionCredits
          ? opts.subscriptionCredits(payer as Address)
          : readVaultCredits(opts.rpcUrl!, opts.vaultAddress!, payer as Address)).catch(() => null);
        if (credits === null) throw new SubscriberError(503, "billing_unavailable", "Your credit balance could not be verified. Try again later.");
        if (credits <= 0n) throw new SubscriberError(402, "payment_required", "Out of credits — subscribe to continue.");
        availableCredits = credits;
      }
      // Org rules gate (firm policy). Handle = key:<prefix> for keyed calls,
      // wallet:<addr> for browser calls. Blocks speak plainly: the caller asked
      // for something their org disallows — never a stack trace.
      let orgRegionAllow: string[] | null = null; // intersected across caller orgs
      let orgVerifiedOnly = false;
      let orgPinnedHosts: string[] | null = null; // union: any pinned host serves
      let orgRateLimit: number | null = null; // strictest (min) across caller orgs
      let orgRateHandles: string[] = [];
      const orgRateTeams: string[] = [];
      if (opts.orgRules) {
        const handle = keyPrefix ? `key:${keyPrefix}` : walletHandle;
        if (handle || teamBilling) {
          // Team-billed calls follow the billed team's rules; others follow every org of the handle.
          const orgs = teamBilling
            ? [await opts.orgRules.get(teamBilling.orgId)].filter((o): o is NonNullable<typeof o> => !!o)
            : await opts.orgRules.orgsForHandle(handle!);
          for (const o of orgs) {
            if (o.allowedModels && !o.allowedModels.includes(model)) {
              throw new OrgPolicyDenied(`model ${model} not allowed`);
            }
            if (o.allowedRegions) {
              orgRegionAllow = orgRegionAllow ? orgRegionAllow.filter((r) => o.allowedRegions!.includes(r)) : [...o.allowedRegions];
            }
            if (o.requireVerified) orgVerifiedOnly = true;
            if (o.pinnedHosts) {
              orgPinnedHosts = orgPinnedHosts ? [...new Set([...orgPinnedHosts, ...o.pinnedHosts])] : [...o.pinnedHosts];
            }
            if (o.rateLimitPerMin != null) {
              orgRateLimit = orgRateLimit == null ? o.rateLimitPerMin : Math.min(orgRateLimit, o.rateLimitPerMin);
              for (const h of o.handles) if (!orgRateHandles.includes(h)) orgRateHandles.push(h);
              if (!orgRateTeams.includes(o.orgId)) orgRateTeams.push(o.orgId);
            }
            if (o.dailyCapCredits != null) {
              const dayStart = new Date().setUTCHours(0, 0, 0, 0);
              const receipts = (await opts.receipts?.list(10_000)) ?? [];
              const spent = o.handles.reduce((a, h) => a + sumSpent(receipts, h, dayStart), 0) +
                receipts.filter((r) => r.team === o.orgId && r.ts >= dayStart).reduce((a, r) => a + (Number(r.amountCredits ?? 0) || 0), 0);
              if (spent >= o.dailyCapCredits) {
                res.status(429).json({
                  error: { message: "org daily ceiling reached — resets at UTC midnight", type: "quota_exceeded" },
                });
                return;
              }
            }
          }
        }
      }
      // Org rate limit: calls in the trailing 60s across member handles.
      if (orgRateLimit != null) {
        const receipts = (await opts.receipts?.list(10_000)) ?? [];
        const since = Date.now() - 60_000;
        const recent = orgRateHandles.reduce(
          (a, h) => a + receipts.filter((r) => r.user === h && r.ts >= since).length,
          0,
        ) + receipts.filter((r) => !!r.team && orgRateTeams.includes(r.team) && r.ts >= since).length;
        if (recent >= orgRateLimit) {
          res.status(429).json({
            error: { message: `org rate limit reached (${orgRateLimit}/min) — retry in a few seconds`, type: "quota_exceeded" },
          });
          return;
        }
      }
      const fallback = requireSubscription ? undefined : opts.fallbackUpstream ?? process.env.UPSTREAM_URL;
      const t0 = Date.now();
      const sse = (req.headers.accept ?? "").includes("text/event-stream");
      const emit = (event: string, data: unknown) => {
        if (sse) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      if (sse) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
      }
      if (!requireSubscription && walletHandle && !keyPrefix && opts.vaultAddress && opts.rpcUrl) {
        const credits = await readVaultCredits(opts.rpcUrl, opts.vaultAddress, walletHandle.slice(7) as Address);
        if (credits !== null && credits <= 0n) throw new SubscriberError(402, "payment_required", "Out of credits — subscribe to continue.");
      }
      const { endpoint, host } = await selectUpstream(model, async () => {
        const hosts = await resolveHosts(opts, model);
        // Failing verification = out of rotation until it recovers. The directory
        // still lists the host (with its failing status) — exclusion is routing-only.
        const ver = opts.verifier;
        let pool = hosts;
        if (ver) {
          const checks = await Promise.all(hosts.map(async (h) => ({ h, failing: (await ver.verification(h.address, h.modelId)).failing })));
          pool = checks.filter((c) => !c.failing).map((c) => c.h);
        }
        // Org routing policy: pinned hosts, allowed regions (observed geo,
        // self-report fallback), verified-only. Empty pool = explicit org
        // denial, not a silent 404.
        if (orgRegionAllow || orgVerifiedOnly || orgPinnedHosts) {
          const meta = opts.meta;
          const kept: typeof pool = [];
          for (const h of pool) {
            if (orgPinnedHosts && !orgPinnedHosts.some((a) => a.toLowerCase() === h.address.toLowerCase())) continue;
            if (orgRegionAllow) {
              const geo = meta ? await cachedGeo(h.address, h.endpoint, meta).catch(() => null) : null;
              const region = meta ? await meta.regionOf(h.address).catch(() => null) : null;
              if (![geo, region].filter(Boolean).some((r) => orgRegionAllow!.includes(r as string))) continue;
            }
            if (orgVerifiedOnly && ver) {
              const v = await ver.verification(h.address, h.modelId);
              if (!(v.checks > 0 && !v.failing)) continue;
            }
            kept.push(h);
          }
          if (kept.length === 0 && pool.length > 0) {
            throw new OrgPolicyDenied("no host matches org region/host policy");
          }
          pool = kept;
        }
        return pool;
      }, fallback);
      const bounded = requireSubscription ? boundedCompletion(req.body) : null;
      if (bounded) {
        const maximum = priceForCall(host, bounded.promptCeiling, bounded.completionCeiling);
        if (maximum < 1n) throw new SubscriberError(503, "billing_unavailable", "This host has no billable subscription price.");
        if (availableCredits < maximum) throw new SubscriberError(402, "payment_required", `This request needs up to ${maximum} credits available. Shorten it or add credits; only actual usage is charged.`);
        // Strict caps: reserve the maximum on agent and member counters before any payment.
        if (opts.accounting && (agentCall || teamBilling)) {
          const agent = agentCall?.agent ?? null;
          const max = Number(maximum);
          if (agent?.policy.maxRequestCredits != null && max > agent.policy.maxRequestCredits) {
            throw new SubscriberError(403, "request_too_large", `This request could cost up to ${max} credits; the agent allows ${agent.policy.maxRequestCredits} per request. Lower max_tokens.`);
          }
          const p = periods();
          const counters: CounterLimit[] = [];
          if (agent) {
            const approvable = agent.policy.exceptions.credits;
            counters.push({ subject: `agent:${agent.id}`, period: p.day, limit: agent.policy.dailyCredits, label: "agent daily credits", approvable });
            counters.push({ subject: `agent:${agent.id}`, period: p.month, limit: agent.policy.monthlyCredits, label: "agent monthly credits", approvable });
            counters.push({ subject: `agent:${agent.id}`, period: p.all, limit: agent.policy.lifetimeCredits, label: "agent lifetime credits", approvable });
          }
          if (teamBilling) {
            counters.push({ subject: `member:${teamBilling.orgId}:${teamBilling.did}`, period: p.month, limit: teamBilling.allowance, label: "member monthly allowance", approvable: !!agent });
          }
          const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].slice(0, 128) : null;
          const requestHash = sha256hex(JSON.stringify({ idempotencyKey, model, messages: req.body?.messages, max_tokens: bounded.body.max_tokens }));
          const grant = agent ? await opts.approvals!.claimGrant(agent.id, requestHash, agent.policyRevision, requestId) : null;
          const admitted = await opts.accounting.reserve({
            requestId, payer: payer!, agentId: agent?.id ?? null, orgId: teamBilling?.orgId ?? null, memberDid: teamBilling?.did ?? null, maximumCredits: max,
            counters: counters.map((c) => ({ ...c, extra: grant?.limits.find((l) => l.subject === c.subject && l.period === c.period)?.extra ?? 0 })),
            approvalId: grant?.id ?? null,
          });
          if (!admitted.ok) {
            if (grant) await opts.approvals!.finishGrant(grant.id, requestId, "approved");
            const primary = admitted.violations[0];
            if (!agent || admitted.violations.some((v) => !v.approvable)) {
              throw new SubscriberError(429, "quota_exceeded", `${capitalize(primary.label)} reached${agent ? "" : " — ask your team owner for an increase"}.`);
            }
            const memberLimit = admitted.violations.some((v) => v.subject.startsWith("member:"));
            const methods: ApprovalMethod[] = agent.orgId ? ["org_owner", ...(agent.ledgerAddress && !memberLimit ? (["ledger"] as const) : [])] : agent.ledgerAddress ? ["ledger"] : [];
            if (!methods.length) {
              throw new SubscriberError(429, "quota_exceeded", `${capitalize(primary.label)} reached. Enroll a Ledger to approve exceptions, or raise the limit.`);
            }
            const additional = Math.max(...admitted.violations.map((v) => v.needed));
            const team = agent.orgId ? await opts.teams!.team(agent.orgId) : null;
            const input = {
              agentId: agent.id, orgId: agent.orgId, memberDid: teamBilling?.did ?? null, methods, requestHash, idempotencyKey, model,
              maximumRequestCredits: max, additionalCredits: additional,
              limits: admitted.violations.map((v) => ({ subject: v.subject, period: v.period, label: v.label, limit: v.limit, extra: v.needed })),
              policyRevision: agent.policyRevision, membershipRevision: team?.membershipRevision ?? 0, ledgerRevision: agent.ledgerRevision,
            };
            let { approval } = await opts.approvals!.requestFor(input);
            if (approval.state === "approved" && (approval.grantExpiresAt ?? 0) <= Date.now()) {
              await opts.approvals!.setState(approval.id, ["approved"], "expired");
              ({ approval } = await opts.approvals!.requestFor(input));
            }
            if (approval.state === "reserved") throw new SubscriberError(409, "approval_in_use", "The approved exception is in use by another request. Retry after it settles.");
            throw new ApprovalRequired({
              type: "approval_required",
              message: `This request exceeds the ${primary.label}.`,
              approval_id: approval.id,
              approval_state: approval.state,
              approval_methods: approval.methods,
              approval_url: `${origin}/approvals/${approval.id}`,
              constraint: constraintName(primary),
              remaining_credits: String(Math.max(0, primary.limit - primary.spent - primary.reserved)),
              maximum_request_credits: String(max),
              additional_credits_requested: String(additional),
              poll_after_seconds: 5,
            });
          }
          strict = { grantId: grant?.id ?? null, maximum: max };
        }
        await billing.submitted(payer!, requestId, host!.address, maximum);
        paymentStarted = true;
      }
      selectedHost = host;
      emit("routed", { model });
      emit("submitted", { endpoint });
      const paidFetch = opts.x402 ? createPaidFetch({ accountId: opts.x402.accountId, privateKey: opts.x402.privateKey }) : undefined;
      // The gateway buffers the completion and replays its own SSE envelope —
      // upstream always gets a plain request, never a stream (its SSE frames
      // are not JSON and would die in res.json()).
      const upstreamBody = bounded?.body ?? { ...((req.body ?? {}) as object), stream: false };
      const { out, paid, x402Transaction } = await proxyWithFallback(endpoint, upstreamBody, opts.x402, paidFetch, () => emit("paying", {}));
      if (paid) emit("paid-host", { transaction: x402Transaction ?? null });
      if (host && opts.health) await opts.health.recordLatency(host.address, Date.now() - t0);
      emit("running", {});
      const usage = (out as any)?.usage ?? {};
      const tokensIn = Number(usage.prompt_tokens ?? 0);
      const tokensOut = Number(usage.completion_tokens ?? 0);
      if (strict && Number(priceForCall(host, tokensIn, tokensOut)) > strict.maximum) {
        // Never silently overrun an admitted bound: withhold and reconcile.
        throw new SubscriberError(503, "usage_exceeded_bound", "Usage exceeded the admitted bound. The completion is withheld until reconciliation.");
      }
      const receiptInput = {
        requestId,
        promptHash: sha256hex(JSON.stringify(req.body.messages ?? req.body)),
        completionHash: sha256hex(JSON.stringify(out)),
        modelDigest: host?.modelDigest ?? "fallback",
        host: host?.address ?? "fallback",
        priceWei: String(host?.pricePerReq ?? 0),
        latencyMs: Date.now() - t0,
        tokensIn,
        tokensOut,
        modelId: model,
        user: agentCall ? `agent:${agentCall.agent.id}` : keyPrefix ? `key:${keyPrefix}` : teamBilling ? `member:${teamBilling.orgId}:${teamBilling.did}` : (walletHandle ?? "dev"),
        ...(payer ? { payer } : {}),
        ...(teamBilling ? { team: teamBilling.orgId, member: teamBilling.did } : {}),
        ...(agentCall ? { agent: agentCall.agent.id, policyRevision: agentCall.agent.policyRevision } : {}),
        ...(strict?.grantId ? { grant: strict.grantId } : {}),
        ...(x402Transaction ? { x402Transaction } : {}),
      };
      const builtReceipt = buildReceipt(receiptInput);
      if (opts.receipts) await opts.receipts.append(builtReceipt);
      const receipt = builtReceipt.id;
      const settled = opts.settle
        ? await settleCall(
            {
              user: payer ?? "dev",
              host,
              promptTokens: tokensIn,
              completionTokens: tokensOut,
              // bytes32 link to the receipt: sha256 of the receipt id (ids are hex, not bytes).
              receiptHash: receipt ? (`0x${sha256hex(receipt)}` as `0x${string}`) : (`0x${"00".repeat(32)}` as `0x${string}`),
            },
            opts.settle,
          )
        : { settled: false, amountCredits: 0n, hostShare: 0n };
      if (opts.receipts && receipt) {
        await opts.receipts.annotate(receipt, {
          amountCredits: String(settled.amountCredits),
          ...(settled.txHash ? { debitTx: settled.txHash } : {}),
        });
      }
      if (opts.hcs && receipt) {
        const hcs = opts.hcs;
        const id = receipt;
        logReceiptHcs(hcs, id).then(async (seq) => {
          if (seq) {
            console.log(`hcs audit ✓ seq ${seq} <- ${id.slice(0, 12)}…`);
            await opts.receipts?.annotate(id, { hcsSeq: seq });
          }
        });
      }
      if (opts.settle && !settled.settled && payer) {
        console.error(`settle failed user=${payer} host=${host?.address} amount=${settled.amountCredits}: ${settled.error}`);
      }
      if (strict && settled.settled) {
        // Confirmed debit: actual usage becomes spent and the grant is used up.
        await opts.accounting!.settle(requestId, Number(settled.amountCredits));
        if (strict.grantId) await opts.approvals!.finishGrant(strict.grantId, requestId, "consumed");
        strict = null;
      }
      if (requireSubscription && !settled.settled) {
        throw new SubscriberError(503, "settlement_pending", "Payment could not be confirmed. Your completion has not been released.");
      }
      if (billingPayer) { await billing.release(billingPayer, requestId); billingPayer = null; }
      emit("settled", { receipt });
      if (sse) {
        res.write(`data: ${JSON.stringify({ ...(out as object), tor_receipt: receipt, tor_settled: settled.settled })}\n\n`);
        res.end();
        return;
      }
      res.json({ ...(out as object), tor_receipt: receipt, tor_settled: settled.settled });
    } catch (e: any) {
      if (strict) {
        // Unsettled reservation: free it only when no payment could have started.
        if (paymentStarted) {
          await opts.accounting!.markUncertain(requestId).catch(() => {});
          if (strict.grantId) await opts.approvals!.finishGrant(strict.grantId, requestId, "uncertain").catch(() => {});
        } else {
          await opts.accounting!.release(requestId).catch(() => {});
          if (strict.grantId) await opts.approvals!.finishGrant(strict.grantId, requestId, "approved").catch(() => {});
        }
        strict = null;
      }
      if (selectedHost && opts.health && !(e instanceof SubscriberError) && !(e instanceof ApprovalRequired)) await opts.health.recordFail(selectedHost.address);
      // Mid-stream failures must not touch headers twice — that crashes the process.
      if (res.headersSent) {
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ message: String(e?.message ?? e).slice(0, 200), ...(e instanceof SubscriberError ? { type: e.type } : {}) })}\n\n`);
          res.end();
        } catch {}
        return;
      }
      if (e instanceof ApprovalRequired) {
        res.status(403).json({ error: e.body });
        return;
      }
      if (e instanceof SubscriberError) {
        res.status(e.status).json({ error: { message: e.message, type: e.type } });
        return;
      }
      if (e instanceof OrgPolicyDenied) {
        res.status(403).json({ error: { message: e.message, type: "org_policy" } });
        return;
      }
      const code = String(e?.message ?? "").startsWith("no hosts") ? 404 : 502;
      res.status(code).json({ error: { message: String(e?.message ?? e).slice(0, 200), type: "upstream_error" } });
    } finally {
      if (billingPayer && !paymentStarted) await billing.release(billingPayer, requestId).catch(() => {});
    }
  });

  app.get("/api/receipts", async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json({ data: (await opts.receipts?.list(limit)) ?? [] });
  });

  app.get("/api/receipts/:id", async (req, res) => {
    const r = await opts.receipts?.get(req.params.id);
    if (!r) {
      res.status(404).json({ error: { message: "unknown receipt", type: "not_found" } });
      return;
    }
    res.json(r);
  });

  // Host directory for the explorer. Onchain truth + 24h call counts from receipts.
  app.get("/api/hosts", async (_req, res) => {
    const models = await knownModels(opts);
    const seen = new Map<string, HostInfo>();
    for (const id of models) {
      for (const h of await resolveHosts(opts, id)) seen.set(h.address, h);
    }
    const now = Date.now();
    const all = (await opts.receipts?.list(10_000)) ?? [];
    const day = 86_400_000;
    const week = 7 * day;
    res.json({
      data: await Promise.all(
        [...seen.values()].map(async (h) => {
          const mine = all.filter((r) => r.host === h.address);
          const success24h = mine.filter((r) => now - r.ts < day).length;
          // 7d host earnings in credits (metered user cost; host keeps 90% onchain).
          const mine7d = mine.filter((r) => now - r.ts < week);
          const earnings7d = mine7d.reduce((a, r) => a + (Number(r.amountCredits ?? 0) || 0), 0);
          const calls7d = mine7d.length;
          const [fail24h, region, geo, latencyMs, reliability, verification] = await Promise.all([
            opts.health?.fails24h(h.address) ?? 0,
            opts.meta?.regionOf(h.address) ?? null,
            opts.meta ? cachedGeo(h.address, h.endpoint, opts.meta).catch(() => null) : null,
            opts.health?.latencyMs(h.address) ?? null,
            opts.health?.reliability(success24h, h.address) ?? null,
            opts.verifier?.verification(h.address, h.modelId) ?? null,
          ]);
          return {
          address: h.address,
          registry: h.registry ?? null,
          endpoint: h.endpoint,
          modelId: h.modelId,
          modelDigest: h.modelDigest,
          registeredModelId: h.registeredModelId ?? h.modelId,
          registeredEndpoint: h.registeredEndpoint ?? h.endpoint,
          paused: h.paused ?? false,
          registeredActive: h.registeredActive ?? h.active,
          pricePerReq: String(h.pricePerReq),
          pricePer1kTokens: String(h.pricePer1kTokens),
          stake: String(h.stake),
          active: h.active,
          availability: h.availability ?? null,
          lastHeartbeat: h.lastHeartbeat,
          calls24h: success24h,
          calls7d,
          earnings7d,
          fail24h,
          region, // self-reported slug (may be null)
          geo, // observed IP geo (see geo.ts), null until first resolve
          latencyMs, // observed EMA, null until served
          reliability,
          verification,
        };
        }),
      ),
    });
  });

  // On-demand spot check (demo + explorer "verify now"). Probes are paid calls like any other.
  app.post("/api/verify/:address", async (req, res) => {
    // Operator-funded probes must not expose another public spending path.
    if (requireSubscription && !requireAdmin(req, res)) return;
    if (!opts.verifier) {
      res.status(501).json({ error: { message: "verifier not configured", type: "unavailable" } });
      return;
    }
    const models = await knownModels(opts);
    let found: HostInfo | undefined;
    for (const id of models) {
      found = (await resolveHosts(opts, id)).find(
        (h) => h.address.toLowerCase() === req.params.address.toLowerCase(),
      );
      if (found) break;
    }
    if (!found) {
      res.status(404).json({ error: { message: "unknown host", type: "not_found" } });
      return;
    }
    const refs = loadReferences()[found.modelId];
    if (!refs) {
      res.status(400).json({ error: { message: `no references for model ${found.modelId}`, type: "invalid_request" } });
      return;
    }
    try {
      const report = await spotCheck(
        found,
        verificationSender(opts, found.endpoint),
        PROBES,
        refs.refs,
        { model: found.modelId },
      );
      await opts.verifier.record(report);
      res.json({ ...report, verification: await opts.verifier.verification(found.address, found.modelId) });
    } catch (e) {
      res.status(502).json({ error: { message: String(e).slice(0, 200), type: "upstream_error" } });
    }
  });

  app.get("/api/hosts/:address/runtime", async (req, res) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(req.params.address)) { res.status(400).json({ error: { message: "Invalid host address" } }); return; }
    res.json(await opts.runtime!.get(req.params.address) ?? { revision: 0 });
  });

  app.post("/api/hosts/:address/runtime", async (req, res) => {
    try {
      const record = await authorizeHostSettings(req.body?.settings, req.body?.signature);
      if (record.address !== req.params.address.toLowerCase()) throw new HostSettingsError(403, "Host address mismatch");
      const registries = [opts.registry, ...(opts.legacyRegistries ?? [])].filter(Boolean).map(r => r!.toLowerCase());
      if (!registries.includes(record.registry)) throw new HostSettingsError(403, "Registry is not part of this network");
      const host = opts.fetchHosts
        ? (await opts.fetchHosts(record.registeredModelId)).find(h => h.address.toLowerCase() === record.address && h.registry?.toLowerCase() === record.registry)
        : await createPublicClient({ transport: http(opts.rpcUrl) }).readContract({ address: record.registry, abi: REGISTRY_ABI, functionName: "getHost", args: [record.address] });
      if (!host?.active || host.stake <= 0n || host.modelId !== record.registeredModelId) throw new HostSettingsError(403, "An active staked registration is required");
      if (!await opts.runtime!.put(record)) throw new HostSettingsError(409, "Settings changed. Refresh before trying again");
      // A replaced tunnel may resolve to another region. Discard its cached geo.
      await opts.meta?.setGeo(record.address, "").catch(() => {});
      res.json(record);
    } catch (error) {
      res.status(error instanceof HostSettingsError ? error.status : 503).json({ error: { message: error instanceof HostSettingsError ? error.message : "Host settings could not be verified. Try again" } });
    }
  });

  // Hosts self-report their region slug. Validated, overwrite-only, no auth in dev
  // (production: signature check against the host key — see SPEC).
  app.post("/api/hosts/:address/meta", async (req, res) => {
    if (!opts.meta) {
      res.status(501).json({ error: { message: "host meta not configured", type: "unavailable" } });
      return;
    }
    if (!validRegion(req.body?.region)) {
      res.status(400).json({ error: { message: "region must match [a-z0-9-]{2,32}", type: "invalid_request" } });
      return;
    }
    await opts.meta.setRegion(req.params.address, req.body.region);
    res.json({ address: req.params.address, region: req.body.region });
  });

  // Claim a host for an account (link step of `tor-host login`). Dev: open + overwrite;
  // production: signature check that the caller holds the host key (see SPEC).
  app.post("/api/hosts/:address/owner", async (req, res) => {
    if (!opts.meta) {
      res.status(501).json({ error: { message: "host meta not configured", type: "unavailable" } });
      return;
    }
    const userId = req.body?.userId;
    if (typeof userId !== "string" || !userId || userId.length > 128) {
      res.status(400).json({ error: { message: "userId required", type: "invalid_request" } });
      return;
    }
    await opts.meta.setOwner(req.params.address, userId);
    res.json({ address: req.params.address, owner: userId });
  });

  app.get("/api/owners/:userId/hosts", async (req, res) => {
    res.json({ data: (await opts.meta?.hostsOf(req.params.userId)) ?? [] });
  });

  // CLI device-code login. POST /api/device/code -> show code -> user approves on web
  // (POST /api/device/approve, Privy-authed in prod) -> CLI polls GET /api/device/poll.
  const needDevices = (res: any) => {
    if (opts.devices) return false;
    res.status(501).json({ error: { message: "device flow not configured", type: "unavailable" } });
    return true;
  };

  app.post("/api/device/code", async (_req, res) => {
    if (needDevices(res)) return;
    const { code, expiresAt } = await opts.devices!.issue();
    res.json({ code, expiresAt, approveUrl: "/host/link" });
  });

  app.get("/api/device/poll", async (req, res) => {
    if (needDevices(res)) return;
    res.json(await opts.devices!.poll(String(req.query.code ?? "")));
  });

  app.post("/api/device/approve", async (req, res) => {
    if (needDevices(res)) return;
    const out = await opts.devices!.approve(String(req.body?.code ?? ""), String(req.body?.userId ?? ""));
    if (!out) {
      res.status(400).json({ error: { message: "bad or expired code", type: "invalid_request" } });
      return;
    }
    res.json(out);
  });

  // Per-host detail for explorer pages: onchain record + 24h activity + withdrawable earnings
  // (vault read when configured, else null — frontend shows "—").
  app.get("/api/hosts/:address", async (req, res) => {
    const models = await knownModels(opts);
    let found: HostInfo | undefined;
    for (const id of models) {
      found = (await resolveHosts(opts, id)).find(
        (h) => h.address.toLowerCase() === req.params.address.toLowerCase(),
      );
      if (found) break;
    }
    if (!found) {
      res.status(404).json({ error: { message: "unknown host", type: "not_found" } });
      return;
    }
    const now = Date.now();
    const mine = ((await opts.receipts?.list(10_000)) ?? []).filter((r) => r.host === found!.address);
    const success24h = mine.filter((r) => now - r.ts < 86_400_000).length;
    const mine7d = mine.filter((r) => now - r.ts < 7 * 86_400_000);
    const earnings7d = mine7d.reduce((a, r) => a + (Number((r as any).amountCredits ?? 0) || 0), 0);
    let earningsWei: string | null = null;
    let earningsCredits: string | null = null;
    let earnings7dTinybar: string | null = null;
    if (opts.vaultAddress && opts.rpcUrl) {
      try {
        const client = createPublicClient({ transport: http(opts.rpcUrl) });
        const earnings = await hostEarnings(client, opts.vaultAddress, found.address);
        earningsWei = earnings.tinybar; // compatibility field; Hedera contract values are tinybar
        earningsCredits = earnings.credits;
        const settled = mine7d.filter(r => r.debitTx);
        const hostCredits = settled.reduce((total, r) => {
          const gross = BigInt(r.amountCredits ?? "0");
          return total + gross - gross * 1000n / 10000n;
        }, 0n);
        earnings7dTinybar = String(hostCredits * earnings.rate);
      } catch { /* Unknown balances remain null. */ }
    }
    res.json({
      address: found.address,
      registry: found.registry ?? null,
      endpoint: found.endpoint,
      modelId: found.modelId,
      modelDigest: found.modelDigest,
      registeredModelId: found.registeredModelId ?? found.modelId,
      registeredEndpoint: found.registeredEndpoint ?? found.endpoint,
      paused: found.paused ?? false,
      registeredActive: found.registeredActive ?? found.active,
      pricePerReq: String(found.pricePerReq),
      pricePer1kTokens: String(found.pricePer1kTokens),
      stake: String(found.stake),
      active: found.active,
      availability: found.availability ?? null,
      lastHeartbeat: found.lastHeartbeat,
      challenged: found.challenged ?? null,
      region: (await opts.meta?.regionOf(found.address)) ?? null,
      geo: opts.meta ? await cachedGeo(found.address, found.endpoint, opts.meta).catch(() => null) : null,
      calls24h: success24h,
      fail24h: (await opts.health?.fails24h(found.address)) ?? 0,
      reliability: (await opts.health?.reliability(success24h, found.address)) ?? null,
      latencyMs: (await opts.health?.latencyMs(found.address)) ?? null,
      verification: (await opts.verifier?.verification(found.address, found.modelId)) ?? null,
      earningsWei,
      earningsCredits,
      earnings7dTinybar,
      calls7d: mine7d.length,
      earnings7d,
      receipts: mine.slice(0, 20),
    });
  });

  // Usage slice backend: vault credit balance + this payer's receipt history.
  // :id is the payer handle ("key:<prefix>" or wallet address once web sessions map to keys).
  app.get("/api/users/:id/receipts", async (req, res) => {
    const mine = ((await opts.receipts?.list(10_000)) ?? []).filter((r) => r.user === req.params.id);
    res.json({ data: mine.slice(0, 100) });
  });

  app.get("/api/users/:id/credits", async (req, res) => {
    // Credits live onchain per wallet address; key handles have no vault account (null).
    let credits: string | null = null;
    if (opts.vaultAddress && opts.rpcUrl && /^0x[0-9a-fA-F]{40}$/.test(req.params.id)) {
      try {
        const client = createPublicClient({ transport: http(opts.rpcUrl) });
        credits = String(
          await client.readContract({
            address: opts.vaultAddress,
            abi: parseAbi(["function credits(address) view returns (uint256)"]),
            functionName: "credits",
            args: [req.params.id as Address],
          }),
        );
      } catch {
        credits = null;
      }
    }
    res.json({ id: req.params.id, credits });
  });

  // Network stats for the landing strip + explorer. Only real aggregates; anything
  // unwired is null (frontend renders "—", never a guess).
  app.get("/api/stats", async (_req, res) => {
    const models = await knownModels(opts);
    const seen = new Map<string, HostInfo>();
    for (const id of models) {
      for (const h of await resolveHosts(opts, id)) seen.set(h.address, h);
    }
    const hosts = [...seen.values()];
    const now = Date.now();
    const day = 86_400_000;
    const all = (await opts.receipts?.list(10_000)) ?? [];
    const last24h = all.filter((r) => now - r.ts < day);
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const settledToday = all.filter((r) => r.ts >= midnight.getTime()).length;
    const prices = last24h.map((r) => BigInt(r.priceWei)).filter((p) => p > 0n);
    const metered = last24h.filter(
      (r) => (r.tokensIn ?? 0) + (r.tokensOut ?? 0) > 0 && BigInt(r.amountCredits ?? "0") > 0n,
    );
    const tokensIn24h = metered.reduce((a, r) => a + (r.tokensIn ?? 0), 0);
    const tokensOut24h = metered.reduce((a, r) => a + (r.tokensOut ?? 0), 0);
    const credits24h = metered.reduce((a, r) => a + BigInt(r.amountCredits ?? "0"), 0n);
    const totalTokens = tokensIn24h + tokensOut24h;
    // $ = credits × 0.001 by defined unit (receipts.ts money rule) — frontend converts.
    const avgCreditsPer1kTokens =
      totalTokens > 0 ? String((credits24h * 1000n) / BigInt(totalTokens)) : null;
    let poolBalanceWei: string | null = null;
    if (opts.vaultAddress && opts.rpcUrl) {
      try {
        const client = createPublicClient({ transport: http(opts.rpcUrl) });
        poolBalanceWei = String(await client.getBalance({ address: opts.vaultAddress }));
      } catch {
        poolBalanceWei = null;
      }
    }
    res.json({
      hostsOnline: hosts.filter((h) => h.active).length,
      modelsServed: models.filter((m) => hosts.some((h) => h.modelId === m)).length,
      models,
      requests24h: last24h.length,
      settledToday,
      avgPriceWeiPerReq: prices.length ? String(prices.reduce((a, b) => a + b, 0n) / BigInt(prices.length)) : null,
      tokensIn24h,
      tokensOut24h,
      avgCreditsPer1kTokens,
      poolBalanceWei,
      ts: now,
      regions: (await opts.meta?.distinctRegions()) ?? null,
    });
  });

  // Dev key management. Production issues keys from the web app (Privy session) instead.
  app.post("/api/keys", async (req, res) => {
    if (!opts.keys) {
      res.status(501).json({ error: { message: "key store not configured", type: "unavailable" } });
      return;
    }
    const scopes = (req.body?.scopes ?? {}) as KeyScopes;
    const { key, record } = issueKey(scopes);
    await opts.keys.save(record);
    // Proper per-key budget account: deterministic derivation from the single master
    // (env in dev, Key Ring in prod). Funding stays an explicit operator step.
    // Display only — resolution re-derives from the master on every use.
    const budget = budgetAddressFor(record.prefix);
    res.json({ key, prefix: record.prefix, budget }); // key shown ONCE
  });

  app.delete("/api/keys/:prefix", async (req, res) => {
    if (!opts.keys || !(await opts.keys.revoke(req.params.prefix))) {
      res.status(404).json({ error: { message: "unknown key", type: "invalid_api_key" } });
      return;
    }
    res.json({ revoked: true });
  });

  // Budget account funding status (derived address + onchain HBAR check when RPC is set).
  app.get("/api/keys/:prefix/budget", async (req, res) => {
    const address = budgetAddressFor(req.params.prefix);
    let funded: boolean | null = null;
    if (address && opts.rpcUrl) {
      try {
        const client = createPublicClient({ transport: http(opts.rpcUrl) });
        funded = (await client.getBalance({ address: address as Address })) > 0n;
      } catch {
        funded = null;
      }
    }
    res.json({ prefix: req.params.prefix, budget: address, funded });
  });

  // Spend readout for a user handle (`key:<prefix>` or wallet address).
  // Public — receipts are already public; this just aggregates them.
  app.get("/api/usage/:handle", async (req, res) => {
    const handle = req.params.handle;
    const cap = handle.startsWith("key:") ? (await opts.spendCaps?.getCap(handle.slice(4))) ?? null : null;
    const since = cap?.periodStart ?? 0;
    const spent = sumSpent((await opts.receipts?.list(10_000)) ?? [], handle, since);
    res.json({ handle, spent, cap: cap?.cap ?? null, periodStart: cap?.periodStart ?? null });
  });

  // Admin cap writes. Trust boundary: the WEB server is the only caller, authed by
  // GATEWAY_ADMIN_TOKEN (shared env, localhost in dev). The wallet signature gates the
  // WEB route (verified via viem against the org owner's recorded wallet) — this route
  // only checks propagation auth. Fail closed when no token is configured.
  function requireAdmin(req: any, res: any): boolean {
    const token = opts.adminToken ?? process.env.GATEWAY_ADMIN_TOKEN;
    if (!token) {
      res.status(501).json({ error: { message: "admin API disabled (no token configured)", type: "unavailable" } });
      return false;
    }
    const presented = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (presented !== token) {
      res.status(401).json({ error: { message: "bad admin token", type: "unauthorized" } });
      return false;
    }
    return true;
  }

  // Verified login IDs arrive only through the web server's private admin hop.
  app.post("/api/admin/host-faucet", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!opts.faucet) return res.status(503).json({ error: { message: "Our test HBAR pool is unavailable. Please use the Hedera faucet.", type: "unavailable" } });
    try {
      const result = await opts.faucet.claim(String(req.body?.address ?? ""), String(req.body?.userId ?? ""));
      return res.status(result.status === "pending" ? 202 : result.status === "failed" ? 502 : 200).json(result);
    } catch (error) {
      if (error instanceof FaucetError) return res.status(error.status).json({ error: { message: error.message, type: error.code } });
      return res.status(503).json({ error: { message: "Funding is temporarily unavailable. Please retry or use the Hedera faucet.", type: "unavailable" } });
    }
  });

  // One-click Hedera account creation: sends 0.5 HBAR from the operator to a
  // fresh EVM address, which auto-creates its 0.0.x account (HIP-583 hollow
  // account). Only-if-nonexistent (mirror-checked) so each address drips once —
  // self-limiting against drain. The 10 HBAR subscribe still needs the faucet;
  // this just guarantees every user HAS a pasteable account id first.
  app.post("/api/admin/drip", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const address = String(req.body?.address ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) {
        return res.status(400).json({ error: { message: "address must be 0x + 40 hex", type: "invalid_request" } });
      }
      const mirror = process.env.MIRROR_URL ?? "https://testnet.mirrornode.hedera.com";
      const exists = await fetch(`${mirror}/api/v1/accounts/${address}`).then((r) => r.ok).catch(() => true);
      if (exists) return res.status(409).json({ error: { message: "account already exists — use the faucet", type: "already_created" } });
      const rpcUrl = process.env.RPC_URL ?? "";
      const operatorKey = process.env.OPERATOR_KEY ?? "";
      if (!rpcUrl || !operatorKey) {
        return res.status(501).json({ error: { message: "RPC_URL + OPERATOR_KEY required", type: "unavailable" } });
      }
      const { privateKeyToAccount } = await import("viem/accounts");
      const { defineChain } = await import("viem");
      const chain = defineChain({
        id: 296,
        name: "Hedera Testnet",
        network: "hedera-testnet",
        nativeCurrency: { decimals: 18, name: "HBAR", symbol: "HBAR" },
        rpcUrls: { default: { http: [rpcUrl] } },
        testnet: true,
      });
      const account = privateKeyToAccount(operatorKey as `0x${string}`);
      const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
      // 0.5 HBAR in wei (1 HBAR = 1e8 tinybar = 1e18 wei). Enough to create
      // the account with room for a few contract calls afterwards.
      const hash = await wallet.sendTransaction({ to: address as `0x${string}`, value: 500000000000000000n, chain });
      res.json({ tx: hash, account: null, note: "account creates on confirmation — refresh in ~10s" });
    } catch (e: any) {
      res.status(502).json({ error: { message: String(e?.message ?? e).slice(0, 160), type: "upstream_error" } });
    }
  });

  app.post("/api/admin/caps", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!opts.spendCaps) {
      res.status(501).json({ error: { message: "spend caps not configured", type: "unavailable" } });
      return;
    }
    try {
      const { prefix, cap, periodStart } = req.body ?? {};
      const rec = await opts.spendCaps.setCap(String(prefix), Number(cap), periodStart === undefined ? undefined : Number(periodStart));
      res.json({ prefix: String(prefix), ...rec });
    } catch (e: any) {
      res.status(400).json({ error: { message: String(e?.message ?? e).slice(0, 160), type: "invalid_request" } });
    }
  });

  app.delete("/api/admin/caps/:prefix", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!opts.spendCaps) {
      res.status(501).json({ error: { message: "spend caps not configured", type: "unavailable" } });
      return;
    }
    res.json({ prefix: req.params.prefix, removed: await opts.spendCaps.removeCap(req.params.prefix) });
  });

  // Onchain allowance mirror: set/clear one account's SpendCap in the vault.
  // Body: { address? 0x…, prefix? key-prefix, capCredits? number|null, periodDays? n }.
  // capCredits null/omitted = uncapped (periodDays 0 clears). capCredits 0 = deny-all.
  // prefix additionally caps the derived budget account (web never sees BUDGET_MASTER).
  // 501 when no chain writer (dev / old vault) — callers MUST treat that as
  // "chain sync unavailable" and continue, never as a mutation failure.
  app.post("/api/admin/spend-caps", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { address, prefix, capCredits, periodDays } = req.body ?? {};
      const targets = new Set<string>();
      if (address !== undefined && address !== null) {
        const a = String(address).toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(a)) {
          res.status(400).json({ error: { message: "address must be 0x + 40 hex", type: "invalid_request" } });
          return;
        }
        targets.add(a);
      }
      if (prefix !== undefined && prefix !== null) {
        const b = budgetAddressFor(String(prefix));
        if (b) targets.add(b.toLowerCase());
      }
      if (targets.size === 0) {
        res.status(400).json({ error: { message: "address and/or prefix required", type: "invalid_request" } });
        return;
      }
      if (!opts.spendCapWriter) {
        res.status(501).json({ error: { message: "vault spend-cap writer not configured", type: "unavailable" } });
        return;
      }
      const days = capCredits === null || capCredits === undefined ? 0 : Number(periodDays ?? 30);
      const cap = capCredits === null || capCredits === undefined ? 0n : BigInt(Math.max(0, Math.floor(Number(capCredits))));
      if (!Number.isInteger(days) || days < 0 || days > 365) {
        res.status(400).json({ error: { message: "periodDays must be 0..365", type: "invalid_request" } });
        return;
      }
      const txs: Record<string, unknown> = {};
      for (const t of targets) {
        txs[t] = await opts.spendCapWriter(t as `0x${string}`, cap, days);
      }
      res.json({ targets: [...targets], capCredits: capCredits ?? null, periodDays: days, txs });
    } catch (e: any) {
      res.status(502).json({ error: { message: String(e?.message ?? e).slice(0, 160), type: "upstream_error" } });
    }
  });

  // Org rules mirror (synced from web team management after signed approval).
  // Same trust shape as caps: caller holds the wallet signature, this hop is
  // token-authed. Body: { orgId, dailyCapCredits|null, allowedModels|null,
  // allowedRegions|null, requireVerified?, handles[] }.
  app.post("/api/admin/org-rules", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!opts.orgRules) {
      res.status(501).json({ error: { message: "org rules not configured", type: "unavailable" } });
      return;
    }
    try {
      const { orgId, dailyCapCredits, allowedModels, allowedRegions, requireVerified, rateLimitPerMin, pinnedHosts, handles } = req.body ?? {};
      if (!orgId || typeof orgId !== "string") throw new Error("orgId required");
      if (dailyCapCredits !== null && dailyCapCredits !== undefined && (!Number.isFinite(Number(dailyCapCredits)) || Number(dailyCapCredits) < 0)) {
        throw new Error("dailyCapCredits must be a non-negative number or null");
      }
      if (allowedModels !== null && allowedModels !== undefined && (!Array.isArray(allowedModels) || !allowedModels.every((m: unknown) => typeof m === "string"))) {
        throw new Error("allowedModels must be a string array or null");
      }
      if (allowedRegions !== null && allowedRegions !== undefined && (!Array.isArray(allowedRegions) || !allowedRegions.every((m: unknown) => typeof m === "string"))) {
        throw new Error("allowedRegions must be a string array or null");
      }
      if (rateLimitPerMin !== null && rateLimitPerMin !== undefined && (!Number.isInteger(rateLimitPerMin) || rateLimitPerMin <= 0)) {
        throw new Error("rateLimitPerMin must be a positive integer or null");
      }
      if (pinnedHosts !== null && pinnedHosts !== undefined && (!Array.isArray(pinnedHosts) || !pinnedHosts.every((m: unknown) => typeof m === "string"))) {
        throw new Error("pinnedHosts must be a string array or null");
      }
      const rule = {
        orgId,
        dailyCapCredits: dailyCapCredits ?? null,
        allowedModels: allowedModels ?? null,
        allowedRegions: allowedRegions ?? null,
        requireVerified: !!requireVerified,
        rateLimitPerMin: rateLimitPerMin ?? null,
        pinnedHosts: pinnedHosts ?? null,
        handles: Array.isArray(handles) ? handles.filter((h: unknown) => typeof h === "string") : [],
      };
      await opts.orgRules.set(rule);
      res.json({ rule });
    } catch (e: any) {
      res.status(400).json({ error: { message: String(e?.message ?? e).slice(0, 160), type: "invalid_request" } });
    }
  });

  app.get("/api/admin/org-rules/:orgId", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!opts.orgRules) {
      res.status(501).json({ error: { message: "org rules not configured", type: "unavailable" } });
      return;
    }
    res.json({ rule: await opts.orgRules.get(req.params.orgId) });
  });

  // Team membership mirror. The web server pushes the full snapshot after each
  // signed membership change; team payers and approvals resolve only from it.
  app.post("/api/admin/teams/:orgId/snapshot", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!opts.teams) {
      res.status(501).json({ error: { message: "team finance not configured", type: "unavailable" } });
      return;
    }
    try {
      const result = await opts.teams.applySnapshot(normalizeSnapshot(req.params.orgId, req.body));
      // A removed member's pending approvals and unused grants end with their access.
      for (const did of result.removed) await opts.approvals?.cancelOpen({ orgId: req.params.orgId, memberDid: did });
      res.json(result);
    } catch (e) {
      if (e instanceof TeamError) {
        res.status(e.status).json({ error: { message: e.message, type: "invalid_request" } });
        return;
      }
      res.status(503).json({ error: { message: "Team membership could not be saved. Try again.", type: "unavailable" } });
    }
  });

  // Team-scoped routes: a verified Privy session with an active membership in the team.
  async function teamActor(req: any, res: any, orgId: string) {
    if (!opts.teams || !opts.verifySession) {
      res.status(501).json({ error: { message: "team finance not configured", type: "unavailable" } });
      return null;
    }
    const jwt = String(req.headers.authorization ?? "").match(/^Bearer (\S+)$/i)?.[1];
    if (!jwt || jwt.startsWith("tor_sk_")) {
      res.status(401).json({ error: { message: "Sign in to continue.", type: "authentication_required" } });
      return null;
    }
    try {
      const identity = await opts.verifySession(jwt);
      const member = await opts.teams.memberFor(orgId, identity);
      if (!member) {
        res.status(404).json({ error: { message: "team not found", type: "not_found" } });
        return null;
      }
      return { identity, member, jwt };
    } catch (e) {
      if (e instanceof SubscriberError) res.status(e.status).json({ error: { message: e.message, type: e.type } });
      else res.status(503).json({ error: { message: "Login verification is unavailable. Try again later.", type: "unavailable" } });
      return null;
    }
  }

  function treasuryFailure(res: any, e: unknown) {
    if (e instanceof TreasuryError) {
      res.status(e.status).json({ error: { message: e.message, type: e.type } });
      return;
    }
    console.error(`treasury: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    res.status(502).json({ error: { message: "The treasury request could not be completed. Try again.", type: "upstream_error" } });
  }

  function requireTreasury(res: any): TreasuryDeps | null {
    if (opts.treasury) return opts.treasury;
    res.status(501).json({ error: { message: "team treasury not configured", type: "unavailable" } });
    return null;
  }

  // Provision the Privy organization wallet for a new team. The web server verified
  // the creator's login; that user becomes the team's first financial approver.
  app.post("/api/admin/teams", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const treasury = requireTreasury(res);
    if (!treasury) return;
    try {
      const recipients = Array.isArray(req.body?.recipients) ? req.body.recipients.map(String) : [];
      res.json({ team: await provisionTeamWallet(treasury, { name: String(req.body?.name ?? ""), approverUserId: String(req.body?.approverUserId ?? ""), recipients }) });
    } catch (e) {
      treasuryFailure(res, e);
    }
  });

  app.get("/api/team/orgs/:orgId/treasury", async (req, res) => {
    const actor = await teamActor(req, res, req.params.orgId);
    if (!actor) return;
    try {
      const team = await opts.teams!.team(req.params.orgId);
      const treasury = opts.treasury;
      const balances: Record<string, string | null> = { hbarWei: null, credits: null, testUsdcUnits: null };
      const plans: Array<{ planId: string; priceTinybar: string; credits: string }> = [];
      if (treasury && team?.walletAddress) {
        const wallet = team.walletAddress as Address;
        [balances.hbarWei, balances.credits, balances.testUsdcUnits] = await Promise.all([
          treasury.chain.balanceWei(wallet).then(String).catch(() => null),
          treasury.chain.credits(wallet).then(String).catch(() => null),
          treasury.chain.tokenBalance(TEST_USDC_ADDRESS, wallet).then(String).catch(() => null),
        ]);
        for (const planId of treasury.planIds) {
          const plan = await treasury.chain.plan(planId).catch(() => null);
          if (plan) plans.push({ planId: String(planId), priceTinybar: String(plan.priceTinybar), credits: String(plan.credits) });
        }
      }
      const strip = (id: string | null | undefined) => String(id ?? "").replace(/^did:privy:/, "");
      res.json({
        network: "hedera-testnet",
        team: team && {
          orgId: team.orgId, name: team.name, state: team.state, walletAddress: team.walletAddress, quorumId: team.quorumId, policyId: team.policyId,
          approverUserId: team.approverUserId, payoutRecipients: team.payoutRecipients, membershipRevision: team.membershipRevision,
        },
        balances,
        plans,
        intents: treasury ? await treasury.store.list(req.params.orgId, 20) : [],
        me: { did: actor.member.did, role: actor.member.role, financialApprover: !!team?.approverUserId && strip(actor.identity.userId) === strip(team.approverUserId) },
      });
    } catch (e) {
      treasuryFailure(res, e);
    }
  });

  app.post("/api/team/orgs/:orgId/intents", async (req, res) => {
    const actor = await teamActor(req, res, req.params.orgId);
    if (!actor) return;
    const treasury = requireTreasury(res);
    if (!treasury) return;
    try {
      res.json({ intent: await proposeTreasuryIntent(treasury, req.params.orgId, actor.member, String(req.body?.kind ?? ""), req.body ?? {}) });
    } catch (e) {
      treasuryFailure(res, e);
    }
  });

  app.get("/api/team/orgs/:orgId/intents/:id", async (req, res) => {
    const actor = await teamActor(req, res, req.params.orgId);
    if (!actor) return;
    const treasury = requireTreasury(res);
    if (!treasury) return;
    const intent = await treasury.store.get(req.params.id);
    if (!intent || intent.orgId !== req.params.orgId) {
      res.status(404).json({ error: { message: "Treasury transaction not found.", type: "not_found" } });
      return;
    }
    res.json({ intent });
  });

  app.post("/api/team/orgs/:orgId/intents/:id/approve", async (req, res) => {
    const actor = await teamActor(req, res, req.params.orgId);
    if (!actor) return;
    const treasury = requireTreasury(res);
    if (!treasury) return;
    try {
      res.json({ intent: await approveTreasuryIntent(treasury, req.params.orgId, req.params.id, actor) });
    } catch (e) {
      treasuryFailure(res, e);
    }
  });

  app.post("/api/team/orgs/:orgId/intents/:id/reject", async (req, res) => {
    const actor = await teamActor(req, res, req.params.orgId);
    if (!actor) return;
    const treasury = requireTreasury(res);
    if (!treasury) return;
    try {
      res.json({ intent: await rejectTreasuryIntent(treasury, req.params.orgId, req.params.id, actor.member) });
    } catch (e) {
      treasuryFailure(res, e);
    }
  });

  app.post("/api/team/orgs/:orgId/intents/:id/reconcile", async (req, res) => {
    const actor = await teamActor(req, res, req.params.orgId);
    if (!actor) return;
    const treasury = requireTreasury(res);
    if (!treasury) return;
    try {
      res.json({ intent: await reconcileTreasuryIntent(treasury, req.params.orgId, req.params.id, actor.member) });
    } catch (e) {
      treasuryFailure(res, e);
    }
  });

  // --- Agents ------------------------------------------------------------------

  async function sessionActor(req: any, res: any): Promise<{ identity: Identity; jwt: string } | null> {
    if (!opts.verifySession || !opts.agents) {
      res.status(501).json({ error: { message: "agents are not configured", type: "unavailable" } });
      return null;
    }
    const jwt = String(req.headers.authorization ?? "").match(/^Bearer (\S+)$/i)?.[1];
    if (!jwt || jwt.startsWith("tor_sk_")) {
      res.status(401).json({ error: { message: "Sign in to continue.", type: "authentication_required" } });
      return null;
    }
    try {
      return { identity: await opts.verifySession(jwt), jwt };
    } catch (e) {
      if (e instanceof SubscriberError) res.status(e.status).json({ error: { message: e.message, type: e.type } });
      else res.status(503).json({ error: { message: "Login verification is unavailable. Try again later.", type: "unavailable" } });
      return null;
    }
  }

  function agentFailure(res: any, e: unknown) {
    if (e instanceof AgentError || e instanceof ApprovalError || e instanceof LedgerChallengeError) {
      res.status(e.status).json({ error: { message: e.message, type: e.type } });
      return;
    }
    console.error(`agents: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    res.status(503).json({ error: { message: "The agent request could not be completed. Try again.", type: "unavailable" } });
  }

  function agentView(agent: Agent) {
    return {
      id: agent.id, name: agent.name, description: agent.description, ownerUserId: agent.ownerUserId, orgId: agent.orgId, sponsorDid: agent.sponsorDid,
      payerKind: agent.payerKind, state: agent.state, policy: agent.policy, policyRevision: agent.policyRevision,
      ledgerAddress: agent.ledgerAddress, ledgerRevision: agent.ledgerRevision, createdAt: agent.createdAt, updatedAt: agent.updatedAt,
      budgetAddress: agent.budgetLabel ? budgetAddressFor(agent.budgetLabel) : null,
    };
  }

  /// @notice Personal agents: their owner. Team agents: their owner while still a member, plus team owners and managers.
  async function agentAccess(agent: Agent, identity: Identity) {
    if (!agent.orgId) {
      const owner = stripDid(agent.ownerUserId) === stripDid(identity.userId);
      return { manage: owner, member: null as TeamMember | null };
    }
    const member = opts.teams ? await opts.teams.memberFor(agent.orgId, identity) : null;
    const owner = !!member && stripDid(agent.ownerUserId) === stripDid(identity.userId);
    return { manage: owner || member?.role === "owner" || member?.role === "manager", member };
  }

  /// @notice A team agent never receives broader limits or models than its sponsor and team.
  async function checkParent(orgId: string, sponsor: TeamMember, policy: AgentPolicy) {
    const team = await opts.teams!.team(orgId);
    if (!team || team.state !== "active" || !team.walletAddress) throw new AgentError(409, "team_wallet_inactive", "The team has no active treasury wallet yet.");
    const allowance = sponsor.allowanceCredits ?? team.defaultAllowanceCredits;
    for (const [label, value] of [["Daily", policy.dailyCredits], ["Monthly", policy.monthlyCredits], ["Lifetime", policy.lifetimeCredits]] as const) {
      if (allowance !== null && value !== null && value > allowance) {
        throw new AgentError(400, "exceeds_parent", `${label} credits cannot exceed the sponsoring member's allowance of ${allowance}.`);
      }
    }
    const rules = await opts.orgRules?.get(orgId);
    if (rules?.allowedModels && policy.models?.some((m) => !rules.allowedModels!.includes(m))) {
      throw new AgentError(400, "exceeds_parent", "The team does not allow some of these models.");
    }
    return { team, allowance, teamModels: rules?.allowedModels ?? null };
  }

  const CREDIT_FIELDS = ["dailyCredits", "monthlyCredits", "lifetimeCredits", "maxRequestCredits"];
  /// @notice Fields a policy change makes less restrictive.
  const widenedFields = (before: AgentPolicy, after: AgentPolicy) => [
    ...(["dailyCredits", "monthlyCredits", "lifetimeCredits", "maxRequestCredits", "requestsPerMinute", "maxConcurrent", "credentialTtlDays"] as const).filter(
      (k) => before[k] !== null && (after[k] === null || (after[k] as number) > (before[k] as number)),
    ),
    ...(before.models !== null && (after.models === null || after.models.some((m) => !before.models!.includes(m))) ? ["models"] : []),
    ...(before.verifiedOnly && !after.verifiedOnly ? ["verifiedOnly"] : []),
    ...(!before.exceptions.credits && after.exceptions.credits ? ["exceptions"] : []),
  ];

  const policyChangeLines = (agent: Agent, policy: AgentPolicy) => [
    "TrulyOpenRouter protected agent change",
    `origin: ${origin}`,
    "network: hedera-testnet",
    `agent: ${agent.id} (${agent.name})`,
    `approver: ${agent.ledgerAddress}`,
    `policy revision: ${agent.policyRevision}`,
    `current policy: ${stableJson(agent.policy)}`,
    `proposed policy: ${stableJson(policy)}`,
  ];

  const enrollmentLines = (agent: Agent, action: string, approver: string) => [
    "TrulyOpenRouter Ledger enrollment",
    `origin: ${origin}`,
    "network: hedera-testnet",
    `action: ${action}`,
    `agent: ${agent.id} (${agent.name})`,
    `payer: ${agent.orgId ? `team ${agent.orgId}` : "personal budget"}`,
    `approver: ${approver}`,
    `current approver: ${agent.ledgerAddress ?? "none"}`,
    `enrollment revision: ${agent.ledgerRevision}`,
  ];

  /// @notice A challenge counts only if every line describing the current state is still present.
  const describesCurrent = (message: string, lines: string[]) => {
    const present = new Set(message.split("\n"));
    return lines.every((l) => present.has(l));
  };

  async function agentUsage(agent: Agent) {
    const p = periods();
    const rows = opts.accounting
      ? await opts.accounting.usage([{ subject: `agent:${agent.id}`, period: p.day }, { subject: `agent:${agent.id}`, period: p.month }, { subject: `agent:${agent.id}`, period: p.all }])
      : [];
    return rows.map((r) => {
      const limit = r.period === p.day ? agent.policy.dailyCredits : r.period === p.month ? agent.policy.monthlyCredits : agent.policy.lifetimeCredits;
      return { ...r, limit, remaining: limit === null ? null : Math.max(0, limit - r.spent - r.reserved) };
    });
  }

  app.post("/api/agents", async (req, res) => {
    const actor = await sessionActor(req, res);
    if (!actor) return;
    try {
      const policy = normalizePolicy(req.body?.policy);
      let orgId: string | null = null;
      let sponsorDid: string | null = null;
      if (typeof req.body?.orgId === "string" && req.body.orgId) {
        const member = opts.teams ? await opts.teams.memberFor(req.body.orgId, actor.identity) : null;
        if (!member) throw new AgentError(404, "not_found", "team not found");
        await checkParent(req.body.orgId, member, policy);
        orgId = req.body.orgId;
        sponsorDid = member.did;
      }
      const created = await opts.agents!.create({ name: String(req.body?.name ?? ""), description: String(req.body?.description ?? ""), ownerUserId: actor.identity.userId, orgId, sponsorDid, policy });
      // The secret is shown once; only its salted hash is stored.
      res.json({ agent: agentView(created.agent), key: created.key, credential: created.credential });
    } catch (e) {
      agentFailure(res, e);
    }
  });

  app.get("/api/agents", async (req, res) => {
    const actor = await sessionActor(req, res);
    if (!actor) return;
    try {
      const byId = new Map<string, Agent>();
      for (const a of await opts.agents!.listForOwner(actor.identity.userId)) byId.set(a.id, a);
      for (const team of opts.teams ? await opts.teams.teamsFor(actor.identity) : []) {
        const member = await opts.teams!.memberFor(team.orgId, actor.identity);
        if (member?.role === "owner" || member?.role === "manager") for (const a of await opts.agents!.listForOrg(team.orgId)) byId.set(a.id, a);
      }
      res.json({ data: [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).map(agentView) });
    } catch (e) {
      agentFailure(res, e);
    }
  });

  async function managedAgent(req: any, res: any) {
    const actor = await sessionActor(req, res);
    if (!actor) return null;
    const agent = await opts.agents!.get(req.params.id);
    const access = agent ? await agentAccess(agent, actor.identity) : null;
    if (!agent || !access?.manage) {
      res.status(404).json({ error: { message: "Agent not found.", type: "not_found" } });
      return null;
    }
    return { actor, agent, access };
  }

  app.get("/api/agents/:id", async (req, res) => {
    const ctx = await managedAgent(req, res);
    if (!ctx) return;
    try {
      const { agent } = ctx;
      let effective: Record<string, unknown> = { monthlyCredits: agent.policy.monthlyCredits, models: agent.policy.models };
      if (agent.orgId && agent.sponsorDid && opts.teams) {
        const [team, sponsor, rules] = await Promise.all([opts.teams.team(agent.orgId), opts.teams.memberFor(agent.orgId, { userId: agent.sponsorDid, wallets: [] }), opts.orgRules?.get(agent.orgId)]);
        const allowance = sponsor ? sponsor.allowanceCredits ?? team?.defaultAllowanceCredits ?? null : 0;
        const monthly = [agent.policy.monthlyCredits, allowance].filter((v): v is number => v !== null);
        effective = {
          monthlyCredits: monthly.length ? Math.min(...monthly) : null,
          memberAllowance: allowance,
          models: rules?.allowedModels && agent.policy.models ? agent.policy.models.filter((m) => rules.allowedModels!.includes(m)) : agent.policy.models ?? rules?.allowedModels ?? null,
          sponsorActive: !!sponsor,
        };
      }
      const receipts = ((await opts.receipts?.list(10_000)) ?? []).filter((r) => r.agent === agent.id).slice(0, 20);
      res.json({
        agent: agentView(agent),
        effective,
        usage: await agentUsage(agent),
        credentials: await opts.agents!.credentials(agent.id),
        approvals: opts.approvals ? await opts.approvals.list({ agentIds: [agent.id] }, 20) : [],
        receipts,
      });
    } catch (e) {
      agentFailure(res, e);
    }
  });

  app.post("/api/agents/:id/rotate", async (req, res) => {
    const ctx = await managedAgent(req, res);
    if (!ctx) return;
    try {
      const issued = await opts.agents!.rotate(ctx.agent.id);
      res.json({ key: issued.key, credential: issued.credential });
    } catch (e) {
      agentFailure(res, e);
    }
  });

  app.post("/api/agents/:id/:action(pause|resume|revoke)", async (req, res) => {
    const ctx = await managedAgent(req, res);
    if (!ctx) return;
    try {
      const to = req.params.action === "pause" ? "paused" : req.params.action === "resume" ? "ready" : "revoked";
      const agent = await opts.agents!.setState(ctx.agent.id, to);
      if (to === "revoked") await opts.approvals?.cancelOpen({ agentId: agent.id });
      res.json({ agent: agentView(agent) });
    } catch (e) {
      agentFailure(res, e);
    }
  });

  app.patch("/api/agents/:id/policy", async (req, res) => {
    const ctx = await managedAgent(req, res);
    if (!ctx) return;
    try {
      const policy = normalizePolicy(req.body?.policy);
      const { agent } = ctx;
      if (agent.orgId) {
        const sponsor = await opts.teams!.memberFor(agent.orgId, { userId: agent.sponsorDid ?? "", wallets: [] });
        if (!sponsor) throw new AgentError(409, "sponsor_inactive", "The sponsoring member is no longer active.");
        await checkParent(agent.orgId, sponsor, policy);
      }
      const widened = widenedFields(agent.policy, policy);
      // Protected agents: widening needs the enrolled Ledger. A team owner may still
      // raise a team agent's credit limits within team rules without Ledger.
      const ownerCreditIncrease = !!agent.orgId && ctx.access.member?.role === "owner" && widened.every((f) => CREDIT_FIELDS.includes(f));
      if (agent.ledgerAddress && widened.length && !ownerCreditIncrease) {
        const ledger = req.body?.ledger;
        if (!ledger) throw new AgentError(403, "ledger_required", "Widening a Ledger-protected agent needs approval on its Ledger.");
        const message = verifyChallenge(ledger.message, ledger.token);
        if (!describesCurrent(message, policyChangeLines(agent, policy))) throw new LedgerChallengeError(409, "stale_challenge", "The agent or the proposed policy changed. Start again.");
        if ((await messageSigner(message, ledger.signature)) !== agent.ledgerAddress) throw new LedgerChallengeError(401, "bad_signature", "The enrolled Ledger did not approve this change.");
      }
      const updated = await opts.agents!.updatePolicy(agent.id, policy, Number(req.body?.expectedRevision));
      await opts.approvals?.cancelOpen({ agentId: agent.id });
      res.json({ agent: agentView(updated) });
    } catch (e) {
      agentFailure(res, e);
    }
  });

  app.post("/api/agents/:id/policy/challenge", async (req, res) => {
    const ctx = await managedAgent(req, res);
    if (!ctx) return;
    try {
      if (!ctx.agent.ledgerAddress) throw new AgentError(409, "not_protected", "This agent has no enrolled Ledger.");
      res.json(issueChallenge(policyChangeLines(ctx.agent, normalizePolicy(req.body?.policy))));
    } catch (e) {
      agentFailure(res, e);
    }
  });

  // --- Ledger enrollment ------------------------------------------------------
  // Personal agents: their owner enrolls. Team agents: an active team owner.
  // Replacing or removing an approver also needs the currently enrolled Ledger,
  // so a login alone can never disable protection.

  async function ledgerAgent(req: any, res: any) {
    const actor = await sessionActor(req, res);
    if (!actor) return null;
    const agent = await opts.agents!.get(req.params.id);
    const allowed = agent && agent.state !== "revoked" && (agent.orgId
      ? (await opts.teams?.memberFor(agent.orgId, actor.identity))?.role === "owner"
      : stripDid(agent.ownerUserId) === stripDid(actor.identity.userId));
    if (!agent || !allowed) {
      res.status(404).json({ error: { message: "Agent not found.", type: "not_found" } });
      return null;
    }
    return { actor, agent };
  }

  app.post("/api/agents/:id/ledger/challenge", async (req, res) => {
    const ctx = await ledgerAgent(req, res);
    if (!ctx) return;
    try {
      const raw = req.body?.address;
      const address = raw === undefined || raw === null || raw === "" ? null : String(raw).toLowerCase();
      if (address !== null && !/^0x[0-9a-f]{40}$/.test(address)) throw new AgentError(400, "invalid_request", "Enter the Ledger's Ethereum address.");
      const action = !ctx.agent.ledgerAddress ? "enroll" : address ? "replace" : "remove";
      if (action === "enroll" && !address) throw new AgentError(400, "invalid_request", "Connect the Ledger to enroll its address.");
      if (action === "replace" && address === ctx.agent.ledgerAddress) throw new AgentError(409, "already_enrolled", "This Ledger is already enrolled.");
      res.json({ action, currentApprover: ctx.agent.ledgerAddress, ...issueChallenge(enrollmentLines(ctx.agent, action, address ?? "none")) });
    } catch (e) {
      agentFailure(res, e);
    }
  });

  app.post("/api/agents/:id/ledger", async (req, res) => {
    const ctx = await ledgerAgent(req, res);
    if (!ctx) return;
    try {
      const { agent } = ctx;
      const message = verifyChallenge(req.body?.message, req.body?.token);
      const action = challengeField(message, "action");
      const approver = challengeField(message, "approver") ?? "";
      if (!action || !["enroll", "replace", "remove"].includes(action) || !describesCurrent(message, enrollmentLines(agent, action, approver))) {
        throw new LedgerChallengeError(409, "stale_challenge", "The agent or its Ledger enrollment changed. Start again.");
      }
      if (action !== "remove" && (await messageSigner(message, req.body?.signature)) !== approver) {
        throw new LedgerChallengeError(401, "bad_signature", "The Ledger being enrolled did not sign this enrollment.");
      }
      if (action !== "enroll" && (await messageSigner(message, action === "remove" ? req.body?.signature : req.body?.currentSignature)) !== agent.ledgerAddress) {
        throw new LedgerChallengeError(401, "bad_signature", "The currently enrolled Ledger must approve this change.");
      }
      const updated = await opts.agents!.setLedger(agent.id, action === "remove" ? null : approver, agent.ledgerRevision);
      await opts.approvals?.cancelOpen({ agentId: agent.id });
      res.json({ agent: agentView(updated) });
    } catch (e) {
      agentFailure(res, e);
    }
  });

  async function agentFromKey(req: any, res: any): Promise<Agent | null> {
    if (!opts.agents) {
      res.status(501).json({ error: { message: "agents are not configured", type: "unavailable" } });
      return null;
    }
    const key = String(req.headers.authorization ?? "").match(/^Bearer (\S+)$/i)?.[1] ?? "";
    const resolved = key.startsWith(AGENT_KEY_PREFIX) ? await opts.agents.authenticate(key) : null;
    if (!resolved) {
      res.status(401).json({ error: { message: "This agent credential is invalid, expired, or revoked.", type: "invalid_api_key" } });
      return null;
    }
    return resolved.agent;
  }

  const effectiveApprovalState = (a: AgentApproval, now = Date.now()) =>
    a.state === "pending" && now >= a.expiresAt ? "expired" : a.state === "approved" && (a.grantExpiresAt ?? 0) <= now ? "expired" : a.state;

  // Agents read their own identity, constraints, usage, and approval state. They can never approve.
  app.get("/v1/agent/self", async (req, res) => {
    const agent = await agentFromKey(req, res);
    if (!agent) return;
    const approvals = opts.approvals ? await opts.approvals.list({ agentIds: [agent.id] }, 20) : [];
    res.json({
      agent: { id: agent.id, name: agent.name, state: agent.state, payerKind: agent.payerKind, orgId: agent.orgId, policyRevision: agent.policyRevision },
      policy: agent.policy,
      usage: await agentUsage(agent),
      approvals: approvals.map((a) => ({ id: a.id, state: effectiveApprovalState(a), additional_credits: a.additionalCredits, expires_at: a.expiresAt, grant_expires_at: a.grantExpiresAt })),
    });
  });

  app.get("/v1/agent/approvals/:id", async (req, res) => {
    const agent = await agentFromKey(req, res);
    if (!agent) return;
    const approval = opts.approvals ? await opts.approvals.get(req.params.id) : null;
    if (!approval || approval.agentId !== agent.id) {
      res.status(404).json({ error: { message: "Approval not found.", type: "not_found" } });
      return;
    }
    res.json({
      id: approval.id, state: effectiveApprovalState(approval), approval_methods: approval.methods, additional_credits: approval.additionalCredits,
      maximum_request_credits: approval.maximumRequestCredits, grant_expires_at: approval.grantExpiresAt, approval_url: `${origin}/approvals/${approval.id}`, poll_after_seconds: 5,
    });
  });

  // Human review: team owners see their organization's approvals; agent owners see their agents'.
  app.get("/api/agent-approvals", async (req, res) => {
    const actor = await sessionActor(req, res);
    if (!actor) return;
    try {
      if (!opts.approvals) throw new ApprovalError(501, "unavailable", "approvals are not configured");
      const orgId = typeof req.query.orgId === "string" ? req.query.orgId : null;
      let list: AgentApproval[];
      if (orgId) {
        const member = opts.teams ? await opts.teams.memberFor(orgId, actor.identity) : null;
        if (member?.role !== "owner") throw new ApprovalError(404, "not_found", "team not found");
        list = await opts.approvals.list({ orgId });
      } else {
        const mine = await opts.agents!.listForOwner(actor.identity.userId);
        list = mine.length ? await opts.approvals.list({ agentIds: mine.map((a) => a.id) }) : [];
      }
      const agents = new Map<string, Agent | null>();
      for (const a of list) if (!agents.has(a.agentId)) agents.set(a.agentId, await opts.agents!.get(a.agentId));
      res.json({ data: list.map((a) => ({ ...a, state: effectiveApprovalState(a), agent: agents.get(a.agentId) ? agentView(agents.get(a.agentId)!) : null })) });
    } catch (e) {
      agentFailure(res, e);
    }
  });

  app.get("/api/agent-approvals/:id", async (req, res) => {
    const actor = await sessionActor(req, res);
    if (!actor) return;
    try {
      const approval = opts.approvals ? await opts.approvals.get(req.params.id) : null;
      const agent = approval ? await opts.agents!.get(approval.agentId) : null;
      const authority = agent && opts.teams ? await approvalAuthority({ teams: opts.teams }, agent, actor.identity) : null;
      if (!approval || !agent || !authority?.canView) throw new ApprovalError(404, "not_found", "Approval not found.");
      res.json({
        approval: { ...approval, state: effectiveApprovalState(approval) },
        agent: agentView(agent),
        message: approvalMessage(approval, { origin, agentName: agent.name }),
        canApprove: { org_owner: authority.orgOwner && approval.methods.includes("org_owner"), ledger: authority.ledgerHuman && approval.methods.includes("ledger") },
        evidence: await opts.approvals!.evidence(approval.id),
      });
    } catch (e) {
      agentFailure(res, e);
    }
  });

  app.post("/api/agent-approvals/:id/decide", async (req, res) => {
    const actor = await sessionActor(req, res);
    if (!actor) return;
    try {
      if (!opts.approvals || !opts.teams) throw new ApprovalError(501, "unavailable", "approvals are not configured");
      const decision = req.body?.decision === "deny" ? "deny" : req.body?.decision === "approve" ? "approve" : null;
      const method = req.body?.method === "ledger" ? "ledger" : req.body?.method === "org_owner" ? "org_owner" : null;
      if (!decision || !method) throw new ApprovalError(400, "invalid_request", "decision (approve|deny) and method (org_owner|ledger) are required.");
      const approval = await decideAgentApproval({ approvals: opts.approvals, agents: opts.agents!, teams: opts.teams, origin }, req.params.id, { identity: actor.identity }, { decision, method, signature: req.body?.signature });
      res.json({ approval });
    } catch (e) {
      agentFailure(res, e);
    }
  });

  // PENDING_TAP queue (L4, Hedera-only). Trust chain: web (wallet-signed
  // owner) -> admin token here -> Ledger-signed HBAR self-transfer (exact dust,
  // verified on the mirror node) -> Hedera execution with the ring-held host
  // key. Every step recorded on the tap; nothing executes early.
  const needTaps = (res: any): TapStore | null => {
    if (!opts.taps) {
      res.status(501).json({ error: { message: "tap queue not configured", type: "unavailable" } });
      return null;
    }
    return opts.taps;
  };

  app.get("/api/admin/taps", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const taps = needTaps(res);
    if (!taps) return;
    // Hero status for /security: ring backend + whether a Ledger tap account
    // is recorded. Read live from env (set at boot, never secret values).
    res.json({
      taps: await taps.list((req.query.status as TapStatus | undefined) ?? undefined),
      ringBackend: process.env.SECRETS_BACKEND === "ring" ? "ring" : "env",
      tapAccount: process.env.TAP_HEDERA_ACCOUNT ?? null,
    });
  });

  app.post("/api/admin/taps", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const taps = needTaps(res);
    if (!taps) return;
    try {
      const { kind, params } = req.body ?? {};
      const tap = await taps.queue(String(kind), (params ?? {}) as Record<string, string>);
      const ledgerAccount = process.env.TAP_HEDERA_ACCOUNT ?? "";
      res.json({
        tap,
        deviceInstruction: ledgerAccount ? tapInstruction(tap, ledgerAccount) : null,
        tapAccountConfigured: !!ledgerAccount,
      });
    } catch (e: any) {
      res.status(400).json({ error: { message: String(e?.message ?? e).slice(0, 160), type: "invalid_request" } });
    }
  });

  app.post("/api/admin/taps/:id/verify", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const taps = needTaps(res);
    if (!taps) return;
    try {
      const tap = await taps.get(req.params.id);
      if (!tap) return res.status(404).json({ error: { message: "tap not found", type: "not_found" } });
      const ledgerAccount = process.env.TAP_HEDERA_ACCOUNT ?? "";
      if (!ledgerAccount) {
        return res.status(501).json({ error: { message: "TAP_HEDERA_ACCOUNT not configured", type: "unavailable" } });
      }
      const txId = await verifyTapTransfer(tap, ledgerAccount);
      res.json({ tap: await taps.markApproved(tap.id, txId, ledgerAccount) });
    } catch (e: any) {
      res.status(400).json({ error: { message: String(e?.message ?? e).slice(0, 200), type: "tap_unapproved" } });
    }
  });

  app.post("/api/admin/taps/:id/execute", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const taps = needTaps(res);
    if (!taps) return;
    try {
      const tap = await taps.get(req.params.id);
      if (!tap) return res.status(404).json({ error: { message: "tap not found", type: "not_found" } });
      if (tap.status !== "approved") {
        return res.status(409).json({ error: { message: `tap is ${tap.status}, needs device approval first`, type: "tap_unapproved" } });
      }
      const rpcUrl = process.env.RPC_URL ?? "";
      const registry = process.env.TAP_REGISTRY ?? process.env.REGISTRY ?? "";
      const hostKey = process.env.HOST_KEY ?? "";
      if (!opts.tapExecutor && (!rpcUrl || !registry || !hostKey)) {
        return res.status(501).json({ error: { message: "RPC_URL + REGISTRY + HOST_KEY required", type: "unavailable" } });
      }
      const execute =
        opts.tapExecutor ??
        createTapExecutor({ rpcUrl, registry: registry as `0x${string}`, hostKey: hostKey as `0x${string}` });
      try {
        const execTx = await execute(tap.kind);
        res.json({ tap: await taps.markExecuted(tap.id, execTx) });
      } catch (e: any) {
        res.json({ tap: await taps.markFailed(tap.id, String(e?.message ?? e)) });
      }
    } catch (e: any) {
      res.status(400).json({ error: { message: String(e?.message ?? e).slice(0, 200), type: "invalid_request" } });
    }
  });

  return app;
}

const PORT = Number(process.env.PORT ?? 4021);

if (import.meta.url === `file://${process.argv[1]}`) {
  // Standalone server defaults: fresh key store + receipt log (tests inject their own).
  // Live legs (all env-driven, all optional in dev):
  //   REGISTRY (HostRegistry) + RPC_URL + MODELS + VAULT_ADDRESS + OPERATOR_KEY (vault debit)
  // Secrets: SECRETS_BACKEND=ring decrypts gateway/secrets/*.enc (Ledger Key Ring)
  // into memory first — ciphertext in repo, keys in trustchain. Env is the fallback.
  const { loadRingSecrets } = await import("./ring.js");
  if (process.env.SECRETS_BACKEND === "ring") {
    const { loaded, fallback } = await loadRingSecrets({ strict: true });
    console.log(`ring secrets: ${loaded.join(",")} (device-backed, never on disk)`);
    if (fallback.length) console.log(`env fallback: ${fallback.join(",")}`);
  }
  const rpcUrl = process.env.RPC_URL ?? "";
  // Storage: Postgres when DATABASE_URL is set (RDS in prod), otherwise the
  // in-memory/file backends (dev + tests). Same interfaces either way.
  if (dbEnabled()) {
    await ensureSchema();
    console.log("storage: postgres");
  } else {
    console.log("storage: memory/files (set DATABASE_URL for postgres)");
  }
  const pg = dbEnabled();
  const opts: GatewayOptions = {
    billing: pg ? new PgBillingRequests() : new MemoryBillingRequests(),
    verifySubscriber: privySubscriber(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET),
    availability: new EndpointAvailability(),
    runtime: pg ? new PgHostRuntime() : new MemoryHostRuntime(),
    keys: pg ? new PgKeyStore() : new MemoryKeyStore(),
    receipts: pg ? new PgReceiptLog() : new MemoryReceiptLog(),
    devices: pg ? new PgDeviceFlow() : new MemoryDeviceFlow(),
    meta: pg ? new PgHostMeta() : new MemoryHostMeta(),
    health: pg ? new PgHealth() : new MemoryHealth(),
    verifier: pg ? new PgVerifier() : new MemoryVerifier(),
    spendCaps: pg ? new PgCapStore() : new SpendCapStore(),
    taps: pg ? new PgTapStore() : new FileTapStore(),
    orgRules: pg ? new PgOrgRules() : new MemoryOrgRules(),
    teams: pg ? new PgTeams() : undefined,
    verifySession: privySession(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET),
    agents: pg ? new PgAgents() : undefined,
    accounting: pg ? new PgAccounting() : undefined,
    approvals: pg ? new PgApprovals() : undefined,
    appOrigin: process.env.APP_ORIGIN,
  };
  if (pg && process.env.FAUCET_ACCOUNT_ID && process.env.FAUCET_PRIVATE_KEY) {
    const { HederaFaucetSender } = await import("./faucet-hedera.js");
    const sender = new HederaFaucetSender(process.env.FAUCET_ACCOUNT_ID, process.env.FAUCET_PRIVATE_KEY);
    opts.faucet = new PgHostFaucet(db(), sender, address => opts.meta!.ownerOf(address), Number(process.env.FAUCET_DAILY_GRANTS || 10));
    console.log(`host funding: ${sender.accountId} · 5 testnet HBAR per grant`);
  }
  if (process.env.REGISTRY) opts.registry = process.env.REGISTRY as Address;
  opts.legacyRegistries = (process.env.LEGACY_REGISTRIES ?? "").split(",").map((r) => r.trim()).filter(Boolean) as Address[];
  if (rpcUrl) opts.rpcUrl = rpcUrl;
  if (process.env.VAULT_ADDRESS) opts.vaultAddress = process.env.VAULT_ADDRESS as Address;
  if (process.env.X402_PAYER_ID && process.env.X402_PAYER_KEY) {
    opts.x402 = { accountId: process.env.X402_PAYER_ID, privateKey: process.env.X402_PAYER_KEY };
  }
  if (process.env.HCS_TOPIC_ID && process.env.HCS_OPERATOR_ID && process.env.HCS_OPERATOR_KEY) {
    opts.hcs = {
      topicId: process.env.HCS_TOPIC_ID,
      operatorId: process.env.HCS_OPERATOR_ID,
      operatorKey: process.env.HCS_OPERATOR_KEY,
    };
  }
  if (process.env.VAULT_ADDRESS && rpcUrl && process.env.OPERATOR_KEY) {
    const vaultCfg = {
      rpcUrl,
      vault: process.env.VAULT_ADDRESS as Address,
      operatorKey: process.env.OPERATOR_KEY as `0x${string}`,
    };
    opts.settle = createVaultDebit(vaultCfg);
    opts.spendCapWriter = createVaultSpendCapWriter(vaultCfg);
  }
  // Team treasury: Privy organization wallets owned by approver + broker quorums.
  if (opts.teams && process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET && process.env.PRIVY_BROKER_AUTH_KEY && process.env.VAULT_ADDRESS && rpcUrl) {
    const { brokerKey, hederaTreasuryChain, PgTreasuryStore, privyAccess } = await import("./treasury.js");
    const vault = process.env.VAULT_ADDRESS as Address;
    opts.treasury = {
      privy: privyAccess(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET),
      broker: brokerKey(process.env.PRIVY_BROKER_AUTH_KEY),
      chain: hederaTreasuryChain(rpcUrl, vault),
      vault,
      planIds: (process.env.TEAM_PLAN_IDS ?? "0").split(",").map((id) => BigInt(id.trim())),
      hbarPayoutCapWei: BigInt(Math.round(Number(process.env.TEAM_PAYOUT_CAP_HBAR ?? 25) * 1e8)) * 10_000_000_000n,
      usdcPayoutCapUnits: BigInt(Math.round(Number(process.env.TEAM_PAYOUT_CAP_USDC ?? 5) * 1e6)),
      teams: opts.teams,
      store: new PgTreasuryStore(),
      paymentPending: async (payer) => (await db().query(`SELECT 1 FROM billing_requests WHERE payer = $1`, [payer.toLowerCase()])).rows.length > 0,
    };
    console.log("team treasury: Privy organization wallets with approver and broker quorum");
  }
  startVerifyLoop(opts); // VERIFY_INTERVAL_MS=0/unset = off; VERIFY_AUTO_CHALLENGE=1 + OPERATOR_KEY files challenges
  createApp(opts).listen(PORT, () => console.log(`tor-gateway on :${PORT}`));
}
