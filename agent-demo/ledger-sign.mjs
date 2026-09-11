#!/usr/bin/env node
// Sign one TrulyOpenRouter spending approval on a Ledger connected over USB, with Ledger's Device
// Management Kit. Reads the exact approval message on stdin, checks that the device's Ethereum address is
// the agent's enrolled Ledger, shows the message on the device, and prints only the signature on stdout.
// Progress goes to stderr. Nothing is sent to any chain.
//
//   node agent-demo/ledger-sign.mjs 0xEnrolledLedgerAddress < approval-message.txt
import { createRequire } from "node:module";

// The kits' ESM builds use directory imports that Node cannot resolve; their CommonJS builds load in Node.
const require = createRequire(import.meta.url);
const { DeviceManagementKitBuilder } = require("@ledgerhq/device-management-kit");
const { SignerEthBuilder } = require("@ledgerhq/device-signer-kit-ethereum");
const { nodeHidIdentifier, nodeHidTransportFactory } = require("@ledgerhq/device-transport-kit-node-hid");

const PATH = "44'/60'/0'/0/0"; // the account the web enrollment verified on the device
const STEPS = {
  "unlock-device": "Unlock your Ledger.",
  "confirm-open-app": "Approve opening the Ethereum app on the Ledger.",
  "sign-personal-message": "Read the approval on the Ledger and sign it.",
};

const say = (text) => console.error(text);
const fail = (text) => {
  say(text);
  process.exit(1);
};
// Ledger kit errors carry a tag and the underlying error rather than a message.
const describe = (e) => e?.message || e?.originalError?.message || e?._tag || String(e);
const timeout = (ms, what) => new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took too long`)), ms).unref());

const expected = String(process.argv[2] ?? "").toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(expected)) fail("Usage: node agent-demo/ledger-sign.mjs <enrolled Ledger address> < approval-message.txt");
const message = await new Promise((resolve) => {
  let text = "";
  process.stdin.setEncoding("utf8").on("data", (d) => (text += d)).on("end", () => resolve(text));
});
if (!message.trim()) fail("No approval message on stdin.");

let lastStep = null;
/// Resolve a device action with its output; report what the person has to do while it waits.
function complete(action, ms) {
  return new Promise((resolve, reject) => {
    let subscription;
    const settle = (finish) => {
      clearTimeout(timer);
      finish();
      queueMicrotask(() => subscription?.unsubscribe());
    };
    const timer = setTimeout(() => {
      action.cancel();
      reject(new Error("the Ledger stopped answering"));
    }, ms);
    subscription = action.observable.subscribe({
      next(state) {
        const step = state.status === "pending" ? state.intermediateValue?.requiredUserInteraction : undefined;
        if (step && STEPS[step] && step !== lastStep) say(STEPS[(lastStep = step)]);
        if (state.status === "completed") settle(() => resolve(state.output));
        if (state.status === "error" || state.status === "stopped") settle(() => reject(state.error ?? new Error("the Ledger action did not complete")));
      },
      error: (e) => settle(() => reject(e)),
    });
  });
}

const dmk = new DeviceManagementKitBuilder().addTransport(nodeHidTransportFactory).build();
say("Looking for a Ledger on USB…");
const device = await Promise.race([
  new Promise((resolve, reject) => {
    let subscription;
    subscription = dmk.startDiscovering({ transport: nodeHidIdentifier }).subscribe({
      next(found) {
        resolve(found);
        queueMicrotask(() => subscription?.unsubscribe());
      },
      error: reject,
    });
  }),
  timeout(30_000, "Finding a Ledger"),
]).catch((e) => fail(`No Ledger found: ${describe(e)}. Plug it in, unlock it, and quit Ledger Live.`));

const sessionId = await Promise.race([dmk.connect({ device }), timeout(20_000, "Opening the Ledger")]).catch((e) =>
  fail(`The Ledger could not be opened: ${describe(e)}. Quit Ledger Live, reconnect the Ledger, and try again.`),
);
const signer = new SignerEthBuilder({ dmk, sessionId }).build();

const account = await complete(signer.getAddress(PATH, { checkOnDevice: false }), 120_000).catch((e) => fail(`Could not read the Ledger's address: ${describe(e)}.`));
if (String(account.address).toLowerCase() !== expected) {
  fail(`This Ledger (${account.address}) is not the agent's enrolled Ledger (${expected}). Nothing was signed.`);
}
say("This is the enrolled Ledger.");

const signature = await complete(signer.signMessage(PATH, message), 180_000).catch((e) => {
  const reason = describe(e);
  fail(/condition not satisfied|denied|rejected/i.test(reason) ? "You rejected the approval on the Ledger. Nothing was signed." : `No signature: ${reason}.`);
});
const word = (hex) => String(hex).replace(/^0x/, "").padStart(64, "0");
const v = signature.v < 27 ? signature.v + 27 : signature.v;
process.stdout.write(`0x${word(signature.r)}${word(signature.s)}${v.toString(16).padStart(2, "0")}\n`);

await dmk.disconnect({ sessionId }).catch(() => {});
dmk.close();
process.exit(0);
