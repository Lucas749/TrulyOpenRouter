# What I need from you (checklist) — updated 2026-09-05

Work through top to bottom. Anything marked PUBLIC is safe to paste in chat.
Anything marked SECRET stays in your env files — never paste secrets, seeds, or passwords.

## 1. Hedera testnet — ONE click left

- [x] 3 ECDSA accounts created + funded (1000 HBAR each)
- [x] USDC (`0.0.429274`) associated on AGENT + SERVICE (done by agent)
- [x] Keys received, contracts deployed + verified (Registry `0xdee24d…fcf2`, Vault `0x6cb798…f8f6`)
- [ ] **Fund AGENT `0.0.10375331` with testnet USDC: faucet.circle.com** (select Hedera Testnet,
      paste the AGENT id, any amount ≥ 10 USDC). This single click unblocks the first live paid
      x402 call. Nothing else needed on Hedera.

## 2. Privy — done, one verification later

- [x] App created, App ID + secret received and stored (`web/.env.local`, gitignored)
- [ ] Enable **Email** login (dashboard.privy.io → your app → Login methods) if not already on
- [ ] Later, when I say the web app is servable: open it, log in once with your email, tell me
      you see your `0x…` address on the login button. That confirms the whole auth chain.

## 3. Ledger (your machine + device + USB) — ~15 min, do anytime

- [ ] `npm i -g @ledgerhq/wallet-cli` → `wallet-cli genuine-check` (device + Ethereum app)
- [ ] `wallet-cli skill install --agent cursor`
- [ ] Store a ring password in your OS keychain, then:
      `WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w) wallet-cli ring init`
      (one device tap)
- [ ] Send me (PUBLIC, not secrets): the output of `wallet-cli ring keys` (key names only)
- [ ] Send me NOTHING ELSE. No password, no seed, no recovery phrase — ever. If I ever ask,
      it's a bug; say no.

## 4. Two decisions (reply in one line each, no work)

- [ ] Genesis host models: your Ollama already has qwen3 27B + others — which 1–2 models should
      the genesis hosts serve for the demo? (Default if you don't answer: `qwen2.5:0.5b` for speed
      + one 27B to show routing by price.)
- [ ] Video: who records the ≤5min demo takes (you, or do we script + screen-record here)?
