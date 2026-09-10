import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureDocker } from "../ensure-docker.mjs";

function machine({ missing = false, online = true, bootProbes = 0, launchFails = false, compose = true, probeMs = 0 } = {}) {
  let elapsed = 0;
  let launched = false;
  const commands = [];
  const messages = [];
  const options = {
    platform: "darwin", timeoutMs: 6000,
    now: () => elapsed,
    wait: async (ms) => { elapsed += ms; },
    log: (message) => messages.push(message),
    exec: (command, args, limit = 5000) => {
      const text = [command, ...args].join(" ");
      commands.push(text);
      if (text === "docker --version") {
        return missing ? { error: { code: "ENOENT" }, status: null } : { status: 0 };
      }
      if (text === "open -a Docker") {
        launched = true;
        return { status: launchFails ? 1 : 0 };
      }
      if (args[0] === "info") {
        elapsed += Math.min(probeMs, limit);
        if (probeMs >= limit) return { error: { code: "ETIMEDOUT" }, status: null };
        return { status: online || (launched && bootProbes-- <= 0) ? 0 : 1 };
      }
      if (text === "docker compose version") return { status: compose ? 0 : 1 };
      assert.fail(`Unexpected command: ${text}`);
    },
  };
  return { options, commands, messages, elapsed: () => elapsed };
}

test("an already running engine proceeds without reopening Docker", async () => {
  const m = machine();
  await ensureDocker(m.options);
  assert.ok(!m.commands.some((c) => c.startsWith("open ")));
  assert.equal(m.messages.at(-1), "Docker is running and ready.");
});

test("a stopped engine opens Desktop once and waits until it is ready", async () => {
  const m = machine({ online: false, bootProbes: 2 });
  await ensureDocker(m.options);
  assert.equal(m.commands.filter((c) => c === "open -a Docker").length, 1);
  assert.equal(m.elapsed(), 4000);
  assert.match(m.messages.join("\n"), /Starting Docker Desktop/);
  assert.match(m.messages.join("\n"), /Complete any setup prompts/);
  assert.equal(m.messages.at(-1), "Docker is running and ready.");
});

test("missing Docker gives installation steps without trying to start containers", async () => {
  const m = machine({ missing: true });
  await assert.rejects(ensureDocker(m.options), /Docker command was not found.*Install Docker Desktop/s);
  assert.deepEqual(m.commands, ["docker --version"]);
});

test("a CLI installation without a working Desktop app explains how to recover", async () => {
  const m = machine({ online: false, launchFails: true });
  await assert.rejects(ensureDocker(m.options), /Open Docker from Applications.*If the app is missing/s);
  assert.equal(m.elapsed(), 0);
  assert.ok(!m.commands.includes("docker compose version"));
});

test("startup that never completes stops waiting and gives a next step", async () => {
  const m = machine({ online: false, bootProbes: Infinity });
  await assert.rejects(ensureDocker(m.options), /still not ready.*finish setup or restart it/s);
  assert.equal(m.elapsed(), 6000);
  assert.ok(!m.commands.includes("docker compose version"));
});

test("unresponsive engine probes remain bounded by the startup deadline", async () => {
  const m = machine({ online: false, probeMs: 10000 });
  await assert.rejects(ensureDocker(m.options), /still not ready/);
  assert.equal(m.elapsed(), 11000); // Initial 5s probe plus the 6s startup budget.
  assert.ok(!m.commands.includes("docker compose version"));
});

test("a running engine without Compose gives plugin installation steps", async () => {
  const m = machine({ compose: false });
  await assert.rejects(ensureDocker(m.options), /Docker Compose is missing/);
  assert.ok(!m.commands.some((c) => c.startsWith("open ")));
});

test("Linux service errors give Linux instructions without opening a Mac app", async () => {
  const m = machine({ online: false });
  await assert.rejects(ensureDocker({ ...m.options, platform: "linux" }), /sudo systemctl start docker/);
  assert.ok(!m.commands.some((c) => c.startsWith("open ")));
});
