import express from "express";
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
import { type Health, MemoryHealth, PgHealth } from "./health.js";
import { createVaultDebit, createVaultSpendCapWriter, readVaultCredits, type SpendCapWriter } from "./vault.js";
import { type HostMeta, MemoryHostMeta, PgHostMeta, validRegion } from "./hostmeta.js";
import { logReceiptHcs, type HcsConfig } from "./hcs.js";
import { budgetAddressFor } from "./budget.js";
import { type DeviceFlow, MemoryDeviceFlow, PgDeviceFlow } from "./device.js";
import { proxyWithFallback, selectUpstream, type X402Creds } from "./upstream.js";
import { loadReferences, MemoryVerifier, PgVerifier, PROBES, spotCheck, type CheckReport, type Verifier } from "./verify.js";
import { createPaidFetch } from "./payer.js";
import { settleCall, type DebitFn } from "./settle.js";
import { FileTapStore, PgTapStore, tapInstruction, type TapKind, type TapStatus, type TapStore, verifyTapTransfer } from "./taps.js";
import { cachedGeo } from "./geo.js";
import { createTapExecutor } from "./tap-exec.js";
import { hostEarnings } from "./host-earnings.js";
import { applyHostSettings, authorizeHostSettings, HostSettingsError, MemoryHostRuntime, PgHostRuntime, type HostRuntimeStore } from "./host-runtime.js";

/// @notice Thrown when an org rule blocks a call. Caught by the chat handler
/// into a plain-language 403 (module scope: the catch lives outside try).
class OrgPolicyDenied extends Error {
  constructor(why: string) {
    super(`Not allowed in your organization (${why})`);
  }
}

export interface GatewayOptions {
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
  return [...hosts.values()];
}

export function createApp(opts: GatewayOptions = {}) {
  opts.runtime ??= new MemoryHostRuntime();
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
    try {
      const model = req.body?.model;
      if (typeof model !== "string" || !model) {
        res.status(400).json({ error: { message: "missing model", type: "invalid_request" } });
        return;
      }
      // Attribution (observability only, never authorization): a keyed call is
      // `key:<prefix>`; a logged-in browser call may claim `wallet:<0x…>`; else "dev".
      // Caps still enforce exclusively via keys — a wallet handle grants nothing.
      const claimed = typeof req.body?.userHandle === "string" ? req.body.userHandle.toLowerCase() : "";
      const walletHandle = /^0x[0-9a-f]{40}$/.test(claimed) ? `wallet:${claimed}` : null;
      // Bearer key (harness path): verify + enforce model allowlist. Absent = web/dev path.
      const auth = req.headers.authorization ?? "";
      let keyPrefix: string | undefined;
      if (auth.startsWith("Bearer ") && opts.keys) {
        const presented = auth.slice("Bearer ".length);
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
      // Org rules gate (firm policy). Handle = key:<prefix> for keyed calls,
      // wallet:<addr> for browser calls. Blocks speak plainly: the caller asked
      // for something their org disallows — never a stack trace.
      let orgRegionAllow: string[] | null = null; // intersected across caller orgs
      let orgVerifiedOnly = false;
      let orgPinnedHosts: string[] | null = null; // union: any pinned host serves
      let orgRateLimit: number | null = null; // strictest (min) across caller orgs
      let orgRateHandles: string[] = [];
      if (opts.orgRules) {
        const handle = keyPrefix ? `key:${keyPrefix}` : walletHandle;
        if (handle) {
          const orgs = await opts.orgRules.orgsForHandle(handle);
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
            }
            if (o.dailyCapCredits != null) {
              const dayStart = new Date().setUTCHours(0, 0, 0, 0);
              const receipts = (await opts.receipts?.list(10_000)) ?? [];
              const spent = o.handles.reduce((a, h) => a + sumSpent(receipts, h, dayStart), 0);
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
        );
        if (recent >= orgRateLimit) {
          res.status(429).json({
            error: { message: `org rate limit reached (${orgRateLimit}/min) — retry in a few seconds`, type: "quota_exceeded" },
          });
          return;
        }
      }
      const fallback = opts.fallbackUpstream ?? process.env.UPSTREAM_URL;
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
      // Wallet callers prepay via subscription: 0 vault credits = 402 before
      // any inference is spent. Key callers enforce via caps (429); anonymous
      // dev calls stay a free demo tier (can't identify them to charge).
      // Unreadable vault (unconfigured/down) never blocks — fail open, settle decides.
      if (walletHandle && !keyPrefix && opts.vaultAddress && opts.rpcUrl) {
        const walletAddr = walletHandle.slice("wallet:".length) as Address;
        const credits = await readVaultCredits(opts.rpcUrl, opts.vaultAddress, walletAddr);
        if (credits !== null && credits <= 0n) {
          res.status(402).json({
            error: {
              message: "out of credits — subscribe to continue",
              type: "payment_required",
            },
          });
          return;
        }
      }
      emit("routed", { model });
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
      selectedHost = host;
      emit("submitted", { endpoint });
      const paidFetch = opts.x402 ? createPaidFetch({ accountId: opts.x402.accountId, privateKey: opts.x402.privateKey }) : undefined;
      // The gateway buffers the completion and replays its own SSE envelope —
      // upstream always gets a plain request, never a stream (its SSE frames
      // are not JSON and would die in res.json()).
      const upstreamBody = { ...((req.body ?? {}) as object), stream: false };
      const { out, paid } = await proxyWithFallback(endpoint, upstreamBody, opts.x402, paidFetch, () => emit("paying", {}));
      if (paid) emit("paid-host", {});
      if (host && opts.health) await opts.health.recordLatency(host.address, Date.now() - t0);
      emit("running", {});
      const usage = (out as any)?.usage ?? {};
      const tokensIn = Number(usage.prompt_tokens ?? 0);
      const tokensOut = Number(usage.completion_tokens ?? 0);
      const receiptInput = {
        promptHash: sha256hex(JSON.stringify(req.body.messages ?? req.body)),
        completionHash: sha256hex(JSON.stringify(out)),
        modelDigest: host?.modelDigest ?? "fallback",
        host: host?.address ?? "fallback",
        priceWei: String(host?.pricePerReq ?? 0),
        latencyMs: Date.now() - t0,
        tokensIn,
        tokensOut,
        modelId: model,
        user: keyPrefix ? `key:${keyPrefix}` : (walletHandle ?? "dev"),
      };
      if (opts.receipts) await opts.receipts.append(buildReceipt(receiptInput));
      const receipt = (await opts.receipts?.list(1))?.[0]?.id;
      // Vault needs a real account, not a handle. Order: key budget account,
      // then the logged-in wallet itself (subscribed users debit their own
      // credits; broke/empty wallets revert inside settleCall and transparently
      // fall back to unsettled demo), then DEFAULT_PAYER, then "dev" (never debited).
      const payer =
        (keyPrefix && budgetAddressFor(keyPrefix)) ||
        walletHandle?.slice("wallet:".length) ||
        process.env.DEFAULT_PAYER ||
        "dev";
      const settled = opts.settle
        ? await settleCall(
            {
              user: payer,
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
      if (opts.settle && !settled.settled && payer !== "dev") {
        // "dev" = anonymous demo call with no wallet to debit: expected, not an error.
        console.error(`settle failed user=${payer} host=${host?.address} amount=${settled.amountCredits}: ${settled.error}`);
      }
      emit("settled", { receipt });
      if (sse) {
        res.write(`data: ${JSON.stringify({ ...(out as object), tor_receipt: receipt, tor_settled: settled.settled })}\n\n`);
        res.end();
        return;
      }
      res.json({ ...(out as object), tor_receipt: receipt, tor_settled: settled.settled });
    } catch (e: any) {
      if (selectedHost && opts.health) await opts.health.recordFail(selectedHost.address);
      // Mid-stream failures must not touch headers twice — that crashes the process.
      if (res.headersSent) {
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ message: String(e?.message ?? e).slice(0, 200) })}\n\n`);
          res.end();
        } catch {}
        return;
      }
      if (e instanceof OrgPolicyDenied) {
        res.status(403).json({ error: { message: e.message, type: "org_policy" } });
        return;
      }
      const code = String(e?.message ?? "").startsWith("no hosts") ? 404 : 502;
      res.status(code).json({ error: { message: String(e?.message ?? e).slice(0, 200), type: "upstream_error" } });
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
  startVerifyLoop(opts); // VERIFY_INTERVAL_MS=0/unset = off; VERIFY_AUTO_CHALLENGE=1 + OPERATOR_KEY files challenges
  createApp(opts).listen(PORT, () => console.log(`tor-gateway on :${PORT}`));
}
