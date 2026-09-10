import { expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { hostSettingsMessage, type HostSettings } from "../src/host-settings.js";
import { authorizeHostSettings } from "../../../gateway/src/host-runtime.js";

it("produces a host settings signature the gateway accepts", async () => {
  const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
  const intent: HostSettings = { address: account.address, registry: `0x${"2".repeat(40)}`, registeredModelId: "qwen2.5:0.5b", modelId: "deepseek-r1:8b", modelDigest: `0x${"0".repeat(64)}`, endpoint: "https://new.trycloudflare.com", paused: false, revision: 1, expiresAt: Date.now() + 60000 };
  const signature = await account.signMessage({ message: hostSettingsMessage(intent) });
  expect(await authorizeHostSettings(intent, signature)).toMatchObject({ revision: 1, modelId: intent.modelId, address: account.address.toLowerCase() });
});
