import { saveConfig } from "./config.js";
import { api } from "./util.js";
import { banner, box, ok, Spinner } from "./ui.js";


/// @notice Device-code login: prints code, polls until the user approves on the web.
export async function login(gateway: string, opts?: { pollMs?: number; timeoutMs?: number; onCode?: (code: string) => void }): Promise<void> {
  console.log(banner());
  const spin = new Spinner();
  spin.start("requesting link code");
  const { code, expiresAt } = await api(gateway, "/api/device/code", { method: "POST" });
  spin.stop();
  const url = `${gateway.replace(/:\d+$/, ":3002")}/host/link?code=${code}`;
  const show = opts?.onCode ?? ((c: string) => console.log(box("Link this host", [`open:  ${url}`, ``, `code:   ${c}`])));
  show(code);
  // Open the approval page for them — one click while logged in, no typing.
  // Best-effort (headless/CI sets TOR_NO_OPEN=1); the printed box is the fallback.
  if (!process.env.TOR_NO_OPEN) {
    try {
      const { spawn } = await import("child_process");
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args: string[] = process.platform === "win32" ? ["/c", "start", url] : [url];
      const child = spawn(opener, args, { stdio: "ignore", detached: true });
      child.unref();
    } catch {}
  }
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


