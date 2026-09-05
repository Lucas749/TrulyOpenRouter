#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { login } from "./login.js";
import { status } from "./status.js";

const [, , cmd, ...rest] = process.argv;
const gateway = () => {
  const g = rest.find((a) => a.startsWith("--gateway="))?.split("=")[1] ?? loadConfig().gateway ?? "";
  if (!g) throw new Error("no gateway — run: tor-host login --gateway=http://HOST:4121");
  return g;
};

try {
  if (cmd === "login") await login(rest.find((a) => a.startsWith("--gateway="))?.split("=")[1] ?? "http://127.0.0.1:4121");
  else if (cmd === "status") await status();
  else if (cmd === "run") console.log("tor-host run ships next — serves --model via Docker (see SERVING.md)");
  else if (cmd === "link") console.log("tor-host link ships next — claims this host for your account");
  else {
    console.log("tor-host — serve open models on TrulyOpenRouter\n\n  tor-host login [--gateway=URL]\n  tor-host status\n  tor-host run --model <id>     (next slice)\n  tor-host link                 (next slice)");
    if (cmd) process.exitCode = 1;
  }
} catch (e) {
  console.error(`error: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  process.exitCode = 1;
}
