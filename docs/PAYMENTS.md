# Payment flow and testnet funding

The deployed network is Hedera **testnet**. Token `0.0.429274` is Circle's
official test USDC, with six decimals. Transfers reach consensus, but the
tokens have no financial value and no backing by redeemable dollars.
See [Circle's token reference](https://developers.circle.com/stablecoins/usdc-contract-addresses).

## Where the money comes from

| Balance | Funding | Use |
|---|---|---|
| Subscriber credits | A subscriber deposits test HBAR into the vault | Metered inference; vault earnings are withdrawable in HBAR |
| Gateway USDC | Separately funded payer `0.0.10375331` | Direct x402 transfers to host wallets |
| Host startup faucet | Separate account `0.0.10472711`, funded by the operator | 5 test HBAR grants for registration |

The USDC payer received 20 test USDC from `0.0.11920` in
[this funding transaction](https://hashscan.io/testnet/transaction/0.0.11920-1788603611-312002297).
Refill this account through the [Circle faucet](https://faucet.circle.com/),
selecting Hedera Testnet and account `0.0.10375331`.
The gateway signs with `X402_PAYER_ID` / `X402_PAYER_KEY`; keys remain private.

There is **no automatic HBAR-to-USDC conversion**. The operator maintains the
USDC pool separately. The present testnet integration gives hosts both a
direct USDC payment and native HBAR earnings from vault settlement. These
are distinct balances; `tor-host withdraw` releases the HBAR vault balance.
Moving to mainnet would require mainnet configuration, real funding, and a
decision about this two-payment economic model.

## Two gates, with different meanings

1. A browser sends its Privy access token to the gateway. The gateway verifies
   that token and retrieves the user's linked wallets server-side. `userHandle`
   only selects a verified wallet; it cannot authorize spending another wallet.
   An API key instead uses its own deterministic budget account.
2. Anonymous or invalid credentials receive **401**. An unowned wallet receives
   **403**. A valid identity with insufficient subscription credits receives
   **402**, without contacting inference. This is a subscription error, not an
   x402 payment challenge. An unknown balance or missing billing configuration
   receives **503**.
3. After the subscription checks, the gateway sends a request to the host guard.
   An unpaid request receives **402** with `payment-required`: network
   `hedera:testnet`, asset `0.0.429274`, amount `1000` (0.001 test USDC).
4. The gateway's native Hedera x402 client signs the transfer. Blocky402 at
   `https://api.testnet.blocky402.com` verifies and settles it. The host response
   carries `payment-response`; receipts retain its transaction ID.
5. The vault debits the authenticated subscriber's actual metered usage. The
   gateway releases the completion only after successful debit confirmation.
   Receipts link `x402Transaction`, `debitTx`, and the HCS audit sequence.

The host endpoint remains available directly to any x402 payer; it does not
require a gateway subscription. Its raw Ollama port is internal and has no
payment middleware.

## Concurrent requests and uncertain payments

Production Postgres stores one `billing_requests` entry per payer before
inference. Other requests from that payer receive **409** until completion.
The gateway checks a conservative token ceiling, bounded text size, and a
finite output limit against available credits; the final debit uses actual
usage. It does not route paid subscription traffic through a free fallback.

Denials before submission release the entry. Confirmed settlement releases it.
A timeout, failed debit, or process interruption after submission retains the
entry across restarts. No completion is released after an unconfirmed debit.
Never clear these entries on a timer: first inspect the receipt with the same
`requestId`, its USDC transfer, and its vault debit. Reconcile the transaction
outcome before an operator removes that exact payer/request entry. Stale
entries from an interruption before submission also require inspection.

Operator-funded model verification is admin-only. Scheduled verification is
an explicit operator expense. `DEFAULT_PAYER` cannot bypass subscriber checks.
Isolated tests can explicitly set `requireSubscription: false`; the standalone
server always enforces subscriptions.

## Hedera prize evidence

Verified on 2026-09-11 with the Dubai host `0.0.10472685`:

- An empty API-key subscription received 402 before inference. After funding
  its subscription, the same key received `Ready!` and `tor_settled: true`.
- [Host payment: 0.001 test USDC](https://hashscan.io/testnet/transaction/0.0.7162784-1789115327-964979579)
  from `0.0.10375331` to `0.0.10472685`, token `0.0.429274`, result `SUCCESS`.
- [Subscriber debit](https://hashscan.io/testnet/transaction/0xbac600c13326adc49b74e6eebfe506fbdb9f0e94f5a07fc7ba0494791e536198)
  reduced credits from 10,000 to 9,998; the transaction receipt reports success.
- [Combined gateway receipt](https://trulyopenrouter.vercel.app/api/gw/api/receipts/1db8f56f4c7462efe8464c2e181013e5f24afd8ec5cb4b34a95fd68ff29ae5fe)
  includes both payments and HCS sequence 17.
- Anonymous requests, a forged funded wallet, and invalid sessions returned
  401 through both the public proxy and direct gateway. The unpaid host guard
  returned the native Hedera x402 challenge. The temporary test key is revoked.

The [AI & Agentic Payments requirements](https://ethglobal.com/events/ethonline2026/prizes#hedera)
permit testnet or mainnet and require Blocky402 settlement. The live guard and
gateway exercise that path with the native Hedera implementation in
`@x402/hedera`. The submission also needs a public repository and a video of
five minutes or less showing a paid request. Payment evidence alone does not
complete those submission requirements.
