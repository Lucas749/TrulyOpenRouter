# What I need from you (checklist)

Work through top to bottom. Anything marked PUBLIC is safe to paste in chat.
Anything marked SECRET stays in your env files — never paste secrets, seeds, or passwords.

## 1. Hedera testnet (portal.hedera.com) — ~20 min

- [ ] Create **3 ECDSA** testnet accounts (ECDSA, not ED25519 — x402 needs ECDSA):
  - `DEPLOYER` — deploys Registry + Vault (one-time, ~HBAR fees)
  - `AGENT` — gateway's x402 payer (needs USDC)
  - `SERVICE` — host payee (receives USDC; per-host wallets later)
- [ ] Fund all three with testnet HBAR: faucet.hedera.com
- [ ] Associate testnet USDC (`0.0.429274`) on AGENT + SERVICE
- [ ] Fund AGENT with testnet USDC: faucet.circle.com (Hedera Testnet)
- [ ] Send me (PUBLIC): the three `0.0.xxxxx` account IDs
- [ ] Send me (SECRET, testnet-only — worthless funds, but keep the habit): `DEPLOYER_KEY`,
      `HEDERA_AGENT_PRIVATE_KEY`, `HEDERA_SERVICE_PRIVATE_KEY` — I export them locally, deploy,
      run the first live paid call, then you rotate them. NEVER mainnet keys, ever.

What I do the minute I have them: `forge script` deploy → verify on HashScan → flip the
gateway from fallback-Ollama to x402-paid routes → record the first real paid inference.

## 2. Privy (dashboard.privy.io) — ~10 min

- [ ] Create app → copy the **App ID** (PUBLIC, starts with `cl…`) → send it to me
- [ ] Enable **Email** login method; leave everything else default for now
- [ ] Keep the **App Secret** to yourself for now — I only need it when we build org
      wallets/policies (server-side SDK); it goes in `web/.env.local`, never in chat

What I do: `NEXT_PUBLIC_PRIVY_APP_ID` → login button goes live → subscribe flow next.

## 3. Ledger (your machine + device + USB) — ~15 min

- [ ] `npm i -g @ledgerhq/wallet-cli` → `wallet-cli genuine-check` (device + Ethereum app)
- [ ] `wallet-cli skill install --agent cursor`
- [ ] Store a ring password in your OS keychain, then:
      `WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w) wallet-cli ring init`
      (one device tap; Linux: `secret-tool` variant — see LEDGER.md)
- [ ] Send me (PUBLIC, not secrets): the output of `wallet-cli ring keys` (key names only)
- [ ] Send me NOTHING ELSE. No password, no seed, no recovery phrase — ever. If I ever ask,
      it's a bug; say no.

What I do: secrets-broker wiring + VPS enrollment + tap-gated withdrawals; you tap on demand.
