import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const installMac = "https://docs.docker.com/desktop/setup/install/mac-install/";

function runCommand(command, args, timeoutMs = 5000) {
  return spawnSync(command, args, {
    encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"],
  });
}

// Check the engine before quickstart builds the CLI or downloads any models.
// Each probe has a timeout, so an unresponsive socket cannot stall onboarding.
export async function ensureDocker({
  platform = process.platform, exec = runCommand, log = console.log,
  wait = sleep, now = Date.now, timeoutMs = 120000,
} = {}) {
  const cli = exec("docker", ["--version"]);
  if (cli.error?.code === "ENOENT") {
    throw new Error(platform === "darwin"
      ? `Docker command was not found. Install Docker Desktop:\n${installMac}\nIf it is already installed, open Docker and finish setup, then rerun quickstart.`
      : "Docker command was not found. Install Docker Engine and Compose:\nhttps://docs.docker.com/engine/install/\nThen rerun quickstart.");
  }
  if (cli.error || cli.status !== 0) {
    throw new Error("Docker is installed, but its command could not run. Repair your Docker installation, then rerun quickstart.");
  }

  const ready = (limit = 5000) => {
    const result = exec("docker", ["info", "--format", "{{.ServerVersion}}"], limit);
    return !result.error && result.status === 0;
  };
  if (!ready()) {
    if (platform !== "darwin") {
      throw new Error("Docker is installed, but the engine is not reachable.\nStart your Docker service (on Linux: sudo systemctl start docker),\ncheck that docker info works for your user, then rerun quickstart.");
    }
    log("Docker engine is not reachable. Starting Docker Desktop...");
    const start = exec("open", ["-a", "Docker"]);
    if (start.error || start.status !== 0) {
      throw new Error(`Docker Desktop could not open. Open Docker from Applications.\nIf the app is missing, install it here: ${installMac}\nThen rerun quickstart.`);
    }
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      if (ready(Math.min(5000, remaining))) break;
      const left = deadline - now();
      if (left <= 0) break;
      log(`Waiting for Docker Desktop (${Math.ceil(left / 1000)}s left). Complete any setup prompts in its window.`);
      await wait(Math.min(2000, left));
    }
    if (now() >= deadline) {
      throw new Error("Docker Desktop is still not ready. Open its window and finish setup or restart it.\nIf it shows Running, check your Docker connection with docker context ls.\nOnce docker info succeeds, rerun quickstart.");
    }
  }
  const compose = exec("docker", ["compose", "version"]);
  if (compose.error || compose.status !== 0) {
    throw new Error("Docker is running, but Docker Compose is missing.\nUpdate Docker Desktop, or install the Compose plugin: https://docs.docker.com/compose/install/\nThen rerun quickstart.");
  }
  log("Docker is running and ready.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await ensureDocker();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
