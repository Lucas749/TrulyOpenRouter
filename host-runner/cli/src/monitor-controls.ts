import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sh } from "./util.js";

export const SERVICE_ACTIONS = {
  s: { label: "Start local services", args: ["start", "ollama", "guard"], success: "Local services started. Readiness is refreshing." },
  p: { label: "Pause serving", args: ["stop", "guard"], success: "Local guard paused. Registration and stake are unchanged. Press s to resume." },
  g: { label: "Restart guard", args: ["restart", "guard"], success: "Guard restarted. Readiness is refreshing." },
  o: { label: "Restart model service", args: ["restart", "ollama"], success: "Ollama restarted. The model loads on the next request." },
} as const;
export type ServiceKey = keyof typeof SERVICE_ACTIONS;

export async function serviceControl(key: ServiceKey, signal?: AbortSignal, shell: typeof sh = sh): Promise<string> {
  const action = SERVICE_ACTIONS[key];
  const compose = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docker-compose.yml");
  // Start existing containers to preserve their model, upstream, and payment settings.
  const result = await shell("docker", ["compose", "-f", compose, ...action.args], { timeoutMs: 20000, signal });
  if (!result.ok) return `${action.label} did not finish. Check Docker and the service logs. If containers are missing, rerun quickstart.`;
  return action.success;
}
