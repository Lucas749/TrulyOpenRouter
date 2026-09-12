# tor-agent — an agent that cannot leak its key, and has to ask you to spend more

The agent's key is sealed in a Ledger Key Ring (`wallet-cli ring`) and opened in memory for one task.
It pays hosts per request over x402 on Hedera. Anything over its limits stops and waits for a signature
from the Ledger enrolled to that agent. The same agent runs on a host with no USB port: `tor-agent enroll`
gives that host its own Key Ring membership, provisioned from the Mac where the Ledger lives.

```
tor-agent seal                      seal an agent key (stdin, or the clipboard) into the Key Ring
tor-agent run "<task>"              one task; stops for a human when it is over its limit
    --approve ledger                sign that approval on the Ledger attached to this machine
tor-agent approve                   sign whatever is waiting, from the machine holding the Ledger
tor-agent enroll --docker <name>    give a host with no USB port its own Key Ring membership
tor-agent status                    limits, usage, and anything waiting for a human
```

## Setup (once, on the Mac with the Ledger)

1. `npm i -g @ledgerhq/wallet-cli` and `wallet-cli ring init` (one device tap; needs Ledger Sync enabled
   in Ledger Live first). Keep the ring password in the keychain:
   `security add-generic-password -a default -s ledger-wallet-cli -w`
2. `npm --prefix agent-cli install`, then `alias tor-agent="node $PWD/agent-cli/bin/tor-agent.mjs"`.
3. At https://trulyopenrouter.vercel.app/agents create an agent, click **Connect Ledger**, and fund its
   budget (Deposit HBAR, then Buy credits). Set **Credits per UTC day** low, e.g. `0`, so the first
   request needs an approval.
4. Copy the key shown once and run `tor-agent seal`. Only ciphertext reaches disk.

## The hosted agent (a host with no USB port)

```sh
docker compose -f agent-cli/docker-compose.yml up -d --build   # Ledger CLI + headless secret store
tor-agent enroll --docker tor-agent-host                        # macOS asks you to Allow once
docker exec tor-agent-host tor-agent status
docker exec tor-agent-host tor-agent run "say hello"
```

`enroll` reads this Mac's Key Ring membership, works out the name that host looks for (Ledger's CLI names
it after the host's own state path), writes it into the host's keychain over stdin, copies the small state
file and the sealed key, then proves the host can open the Key Ring. The host never receives a readable
secret, and removing that keychain entry cuts it off with every file still in place.

## Testing guide

Each step says what a pass looks like. Steps marked **device** need the Ledger; **funds** need credits.

| # | Command | Pass |
|---|---|---|
| 1 | `tor-agent status` | Shows the gateway, the sealed key path, "Key Ring password: found", then the agent's limits and usage |
| 2 | `printf 'not-a-key' \| tor-agent seal` | Refuses: "That does not look like an agent key" |
| 3 | `tor-agent run "Reply with the single word ready"` (**funds**) | Prints "Agent key: opened from the Ledger Key Ring", the reply, and `receipt <id>` |
| 4 | Check that receipt at `/api/gw/api/receipts/<id>` | `x402Transaction` present: the host was paid on Hedera |
| 5 | `docker compose -f agent-cli/docker-compose.yml up -d --build` | Container `tor-agent-host` running; `docker exec tor-agent-host ls /dev/bus/usb` is empty |
| 6 | `tor-agent enroll --docker tor-agent-host` (**device-free**, one Allow click) | Ends with "Enrolled tor-agent-host…" and the host opening the Key Ring |
| 7 | `docker exec tor-agent-host tor-agent run "…"` (**funds**) | Same as step 3, from a machine with no device |
| 8 | Over-limit run, e.g. daily credits `0` (**funds**) | Stops with "Approval needed: …/approvals/apr_…" and waits |
| 9 | `tor-agent approve` on the Mac (**device**) | Ledger shows the approval; after signing: "Approved on the enrolled Ledger", and the waiting run finishes |
| 10 | Wrong device or a rejected press (**device**) | "This Ledger … is not the agent's enrolled Ledger" or "You rejected the approval"; the request is not sent |
| 11 | `docker exec tor-agent-host secret-tool clear service ledger-wallet-cli username $(…)` | The host can no longer open anything, with all files still in place |

Already verified without a device or credits: sealing and unsealing, the wrong-key guard, enrolment of the
container, the host opening the Key Ring, and a request from the container reaching production (it returned
401 for a throwaway key, which is the correct answer).

## Demo (about 3 minutes)

1. **A secret it cannot leak.** `cat` the sealed key file (ciphertext), `wallet-cli ring keys`, then
   `tor-agent run "…"` with the Ledger unplugged. Normal work needs no device.
2. **It pays for what it uses.** Open the receipt: the host was paid in test USDC on Hedera.
3. **Send the agent to a host with no USB.** `docker compose up`, `ls /dev/bus/usb` (empty),
   `tor-agent enroll --docker tor-agent-host`, then run the same task inside the container.
4. **The limit stops it; the Ledger releases it.** The container's run waits. On the Mac, `tor-agent approve`,
   read the terms on the device, press. The container's job finishes and the host gets paid.
5. **Cut the host off.** Remove its keychain entry; the same container can open nothing.

Say plainly on camera: the enrolled host holds a membership and a password, so it can open what that
membership allows; spending past the limits still needs the Ledger; and the production gateway still reads
environment secrets, because `ring init` requires the device on the machine it enrols.

## Safety

- Never print, echo or paste an agent key or the ring password. The CLI reads both by lookup.
- `enroll` sends secrets to the host on stdin only, never in an argument or an environment variable.
- Never run `wallet-cli ring destroy` on an enrolled host while it shares your membership: it tears down
  the ring, not just that host's copy.
