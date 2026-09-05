import { loadConfig, saveConfig } from "./config.js";
import { banner, box, ok, Spinner } from "./ui.js";

async function api(gateway: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${gateway}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/// @notice Device-code login: prints code, polls until the user approves on the web.
export async function login(gateway: string, opts?: { pollMs?: number; timeoutMs?: number; onCode?: (code: string) => void }): Promise<void> {
  console.log(banner());
  const spin = new Spinner();
  spin.start("requesting link code");
  const { code, expiresAt } = await api(gateway, "/api/device/code", { method: "POST" });
  spin.stop();
  const show = opts?.onCode ?? ((c: string) => console.log(box("Link this host", [`open:  ${gateway.replace(/:\d+$/, ":3002")}/host/link?code=${c}`, ``, `code:   ${c}`])));
  show(code);
  const poll = new Spinner();
  poll.start("waiting for approval on the web");
  try {
    const deadline = Math.min(expiresAt, Date.now() + (opts?.timeoutMs ?? 10 * 60_000));
    for (;;) {
      await new Promise((r) => setTimeout(r, opts?.pollMs ?? 3000));
      const st: any = await api(gateway, `/api/device/poll?code=${code}`);
      if (st.status === "approved") {
        saveConfig({ gateway, token: st.token, userId: st.userId });
        poll.stop(ok(`linked as ${st.userId}`));
        return;
      }
      if (st.status !== "pending" || Date.now() > deadline) throw new Error(`login ${st.status}`);
    }
  } catch (e) {
    poll.stop();
    throw e; // index.ts renders the error once
  }
}

export function loggedIn(): boolean {
  const cfg = loadConfig();
  return !!(cfg.token && cfg.userId);
}
