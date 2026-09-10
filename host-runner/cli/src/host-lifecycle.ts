import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { currentHostSettings, publishHostSettings } from "./host-runtime.js";
import { ensureTunnel, healthyGuard, stopTunnel } from "./host-tunnel.js";
import { type HostSettings } from "./host-settings.js";
import { sh } from "./util.js";

export type HostAction = "start" | "stop" | "restart" | "model";
export interface LifecycleDeps {
  current(): Promise<HostSettings>;
  publish(s: HostSettings): Promise<HostSettings>;
  start(): Promise<void>;
  stop(): Promise<void>;
  tunnel(endpoint: string): Promise<string>;
  stopTunnel(): Promise<void>;
  model(id: string): Promise<`0x${string}`>;
}

export async function operateHost(action: HostAction, deps: LifecycleDeps, model?: string, progress = (_message: string) => {}): Promise<string> {
  if (action === "model" && (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model))) throw new Error("Enter a valid Ollama model tag.");
  progress("Reading host settings…");
  let settings: HostSettings;
  try { settings = await deps.current(); }
  catch (error) {
    if (action !== "stop") throw error;
    await Promise.all([deps.stop(), deps.stopTunnel()]);
    throw new Error("Local services stopped. Network pause is unconfirmed. Check registration and connectivity, then retry Stop to sync it.");
  }
  if (action === "stop" || action === "restart") {
    progress("Pausing new requests…");
    let pauseError: unknown;
    try { settings = await deps.publish({ ...settings, paused: true }); } catch (error) { pauseError = error; }
    progress("Stopping guard, model service, and tunnel…");
    await Promise.all([deps.stop(), deps.stopTunnel()]);
    if (pauseError) throw new Error("Local services stopped. Gateway pause is unconfirmed. Retry Stop before restarting.");
    if (action === "stop") return "Host stopped. New routes paused; guard, Ollama, and managed tunnel stopped. Stake stays in place.";
  }
  progress("Starting Docker services…");
  await deps.start();
  const nextModel = model ?? settings.modelId;
  progress(`Preparing ${nextModel}… First downloads can take several minutes.`);
  const modelDigest = await deps.model(nextModel);
  progress("Checking the public endpoint…");
  const endpoint = await deps.tunnel(settings.endpoint);
  progress("Publishing host readiness…");
  await deps.publish({ ...settings, modelId: nextModel, modelDigest, endpoint, paused: action === "model" ? settings.paused : false });
  return action === "model" && settings.paused
    ? `Model changed to ${nextModel}. Network routing remains paused. Press s to serve.`
    : `Ready to serve ${nextModel}. Endpoint is reachable and network routing is enabled.`;
}

const compose = fileURLToPath(new URL("../../docker-compose.yml", import.meta.url));
export function lifecycleDeps(gateway?: string, signal?: AbortSignal): LifecycleDeps {
  const command = async (args: string[], timeoutMs = 30000) => {
    const result = await sh("docker", ["compose", "-f", compose, ...args], { timeoutMs, signal, maxOut: 16000 });
    if (!result.ok) throw new Error(`Docker ${args[0]} did not finish. Check Docker and the service logs, then retry.`);
    return result.out;
  };
  return {
    current: () => currentHostSettings(gateway, signal),
    publish: settings => publishHostSettings(settings, gateway, signal),
    start: async () => {
      const docker = await sh(process.execPath, [fileURLToPath(new URL("../../ensure-docker.mjs", import.meta.url))], { timeoutMs: 150000, signal });
      if (!docker.ok) throw new Error(docker.out || "Docker is not ready.");
      await command(["start", "ollama", "guard"]);
      for (let i = 0; i < 30; i++) {
        if (await healthyGuard("http://127.0.0.1:4122", signal)) return;
        await wait(1000, undefined, { signal });
      }
      throw new Error("The guard did not become healthy. Open Logs to inspect its startup.");
    },
    stop: async () => { await command(["stop", "guard", "ollama"]); },
    tunnel: endpoint => ensureTunnel(endpoint, signal), stopTunnel,
    model: async id => {
      // Request one JSON response so download progress cannot flood the terminal.
      const response = await fetch("http://127.0.0.1:11434/api/pull", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: id, stream: false }),
        signal: AbortSignal.any([AbortSignal.timeout(1800000), ...(signal ? [signal] : [])]),
      });
      const result = await response.json() as { status?: string; error?: string };
      if (!response.ok || result.status !== "success") throw new Error(`Model download failed: ${result.error ?? response.status}`);
      const modelfile = await command(["exec", "-T", "ollama", "ollama", "show", "--modelfile", id]);
      return `0x${createHash("sha256").update(modelfile).digest("hex")}`;
    },
  };
}
