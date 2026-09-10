import { emitKeypressEvents, type Key } from "node:readline";
import { collectMonitor, decimalAmount, type MonitorOptions, type MonitorSnapshot } from "./monitor.js";
import { collectLog, LOG_SOURCES, rememberLogFiles, type LogFiles } from "./monitor-logs.js";
import { cleanText, renderMonitor, terminalFrame, viewportHeight, TABS, viewLines, type ViewState } from "./monitor-view.js";
import { sh } from "./util.js";
import { lifecycleDeps, operateHost, type HostAction } from "./host-lifecycle.js";
import { withdrawEarnings } from "./withdraw.js";
import { formatEther } from "viem";

export interface DashboardOptions extends MonitorOptions, LogFiles { once?: boolean; json?: boolean }
export function initialView(): ViewState {
  return { tab: 0, scroll: 0, refreshing: false, logSource: "guard", logs: ["Loading service logs…"], notice: "" };
}

export function navigate(state: ViewState, key: Key, pageSize = 12): ViewState {
  const next = { ...state, notice: "" };
  const number = Number(key.sequence);
  if (/^[1-7]$/.test(key.sequence ?? "")) next.tab = number - 1;
  else if (key.sequence === "?") next.tab = 6;
  else if (key.name === "right" || (key.name === "tab" && !key.shift)) next.tab = (next.tab + 1) % TABS.length;
  else if (key.name === "left" || (key.name === "tab" && key.shift)) next.tab = (next.tab + TABS.length - 1) % TABS.length;
  else if (key.name === "down" || key.name === "j") next.scroll += 1;
  else if (key.name === "up" || key.name === "k") next.scroll = Math.max(0, next.scroll - 1);
  else if (key.name === "pagedown") next.scroll += pageSize;
  else if (key.name === "pageup") next.scroll = Math.max(0, next.scroll - pageSize);
  else if (key.name === "home") next.scroll = 0;
  else if (key.name === "l" && next.tab === 4) { next.logSource = LOG_SOURCES[(LOG_SOURCES.indexOf(next.logSource) + 1) % LOG_SOURCES.length]; next.scroll = 0; }
  if (next.tab !== state.tab) next.scroll = 0;
  return next;
}

export function webLink(gateway: string, path: string): string {
  try {
    const url = new URL(gateway);
    if (url.pathname.endsWith("/api/gw") && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return `${url.origin}${url.pathname.slice(0, -7)}${path}`;
  } catch {}
  return `https://trulyopenrouter.vercel.app${path}`;
}

export async function printStatus(options: DashboardOptions = {}): Promise<void> {
  const snapshot = await collectMonitor(options);
  if (options.json) console.log(JSON.stringify(snapshot, null, 2));
  else console.log(["TrulyOpenRouter · Host status", "", ...viewLines(snapshot, initialView(), 96), "", "Explore: tor-host dashboard"].map(cleanText).join("\n"));
}

export async function dashboard(options: DashboardOptions = {}): Promise<void> {
  rememberLogFiles(options);
  if (options.once || options.json || !process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") return printStatus(options);
  const input = process.stdin, output = process.stdout;
  let snapshot: MonitorSnapshot | null = null;
  let state = initialView(), closed = false, busy = false, queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let confirmWithdrawal: ((value: boolean) => void) | undefined;
  const controller = new AbortController();
  const oldRaw = Boolean(input.isRaw);
  const color = process.env.NO_COLOR === undefined;
  let resolveDone: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });

  const render = () => {
    if (closed) return;
    const width = output.columns || 100, rows = output.rows || 30;
    const lines = viewLines(snapshot, state, Math.max(1, width - 4));
    state.scroll = Math.min(state.scroll, Math.max(0, lines.length - viewportHeight(width, rows)));
    output.write(terminalFrame(renderMonitor(snapshot, state, width, rows, color)));
  };
  const restore = () => {
    try { input.setRawMode(oldRaw); } catch {}
    output.write("\x1b[0m\x1b[?25h\x1b[?1049l");
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    controller.abort();
    confirmWithdrawal?.(false);
    resolveDone();
  };
  const refresh = async () => {
    if (closed) return;
    if (busy) { queued = true; return; }
    busy = true; clearTimeout(timer); state.refreshing = true; render();
    const logSource = state.logSource;
    try {
      const [next, logs] = await Promise.all([
        collectMonitor(options, controller.signal),
        state.tab === 4 ? collectLog(logSource, controller.signal) : Promise.resolve(null),
      ]);
      if (!closed) {
        snapshot = next;
        if (logs && state.logSource === logSource) state.logs = logs;
      }
    } catch {
      state.notice = "Refresh failed. Press r to retry.";
    } finally {
      busy = false; state.refreshing = false; render();
      if (!closed) {
        const delay = queued ? 0 : 10000;
        queued = false;
        timer = setTimeout(() => { void refresh(); }, delay);
      }
    }
  };
  const progress = (message: string) => { state.controlMessage = cleanText(message); state.notice = state.controlMessage; render(); };
  const execute = (work: () => Promise<string>) => {
    state.controlBusy = true;
    void work().then(progress).catch(error => progress(`Action incomplete: ${cleanText(error.shortMessage ?? error.message ?? error)}`)).finally(() => {
      state.controlBusy = false; state.dialog = undefined; confirmWithdrawal = undefined;
      if (!closed) { void refresh(); render(); }
    });
  };
  const lifecycle = (action: HostAction, model?: string) => operateHost(action, lifecycleDeps(options.gateway, controller.signal, progress), model, progress);
  const keypress = (text: string, key: Key) => {
    if (state.dialog) {
      if (state.dialog.kind === "withdraw") {
        if (["y", "n", "escape", "q"].includes(key.name ?? "")) {
          const accept = key.name === "y"; state.dialog = undefined; confirmWithdrawal?.(accept); render();
        }
      } else if (key.name === "escape") { state.dialog = undefined; render(); }
      else if (key.name === "up" || key.name === "down") {
        const choices = snapshot?.models.state === "ok" ? snapshot.models.data.map(model => model.name) : [];
        if (choices.length) {
          const index = choices.indexOf(state.dialog.input);
          const next = index < 0 ? (key.name === "down" ? 0 : choices.length - 1) : (index + (key.name === "down" ? 1 : choices.length - 1)) % choices.length;
          state.dialog.input = choices[next];
          render();
        }
      }
      else if (key.name === "return") { const model = state.dialog.input.trim(); state.dialog = undefined; execute(() => lifecycle("model", model)); }
      else if (key.name === "backspace") { state.dialog.input = state.dialog.input.slice(0, -1); render(); }
      else if (text && !key.ctrl && !key.meta && /^[a-zA-Z0-9._:/-]+$/.test(text)) { state.dialog.input = (state.dialog.input + text).slice(0, 128); render(); }
      return;
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      if (state.controlBusy) { state.notice = "Action in progress. Wait for its result before closing."; render(); return; }
      finish(); return;
    }
    if (state.tab === 5 && !state.controlBusy && !key.ctrl && !key.meta) {
      const actions: Record<string, HostAction> = { s: "start", p: "stop", x: "restart" };
      if (actions[key.name ?? ""]) { execute(() => lifecycle(actions[key.name!])); return; }
      if (key.name === "m") {
        state.dialog = { kind: "model", input: "", lines: ["CHANGE MODEL", "", "Downloaded models:", ...(snapshot?.models.state === "ok" ? snapshot.models.data.map(m => `  ${m.name}`) : ["  Loading or unavailable"]), "", "↑ / ↓ choose a downloaded model, or type a model tag.", "Existing model files stay on disk.", "Your stake stays in place; pricing stays unchanged."] };
        state.scroll = 0; render(); return;
      }
      if (key.name === "w" || key.name === "l") {
        const method = key.name === "l" ? "ledger" : "softkey";
        execute(() => withdrawEarnings(options.gateway, method, quote => new Promise<boolean>(resolve => {
          if (closed) { resolve(false); return; }
          confirmWithdrawal = resolve;
          state.dialog = { kind: "withdraw", input: "", lines: ["WITHDRAW ALL EARNINGS", "", `Current balance: ${decimalAmount(String(quote.tinybar), 8)} HBAR`, `Maximum network fee: ${formatEther(quote.maxFeeWei)} HBAR`, "", "Destination: your host wallet", quote.address, "", method === "ledger" ? "Ledger approval, then host-key submission." : "Sign with this machine's software host key.", "New earnings before confirmation are included. Your stake stays locked."] };
          state.scroll = 0; render();
        }), progress)); return;
      }
    }
    if (key.name === "r" || key.name === "return") { void refresh(); return; }
    if (key.name === "d" || key.name === "n") {
      const url = webLink(snapshot?.gateway ?? options.gateway ?? "", key.name === "d" ? "/host/dashboard" : "/network");
      state.notice = `Opening ${url}`; render();
      void sh(process.platform === "darwin" ? "open" : "xdg-open", [url], { timeoutMs: 3000, signal: controller.signal }).then(result => {
        if (!result.ok && !closed) { state.notice = `Open in your browser: ${url}`; render(); }
      });
      return;
    }
    const previous = state;
    state = navigate(state, key, viewportHeight(output.columns || 100, output.rows || 30));
    if (state.tab === 4 && (previous.tab !== state.tab || previous.logSource !== state.logSource)) {
      state.logs = ["Loading service logs…"]; void refresh();
    }
    render();
  };

  try {
    emitKeypressEvents(input);
    input.setRawMode(true); input.resume();
    input.on("keypress", keypress);
    input.on("end", finish);
    output.on("resize", render);
    process.on("SIGINT", finish); process.on("SIGTERM", finish); process.on("SIGHUP", finish);
    process.on("exit", restore);
    output.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    render(); void refresh();
    await done;
  } finally {
    finish(); restore();
    input.removeListener("keypress", keypress); input.removeListener("end", finish); input.pause();
    output.removeListener("resize", render);
    process.removeListener("SIGINT", finish); process.removeListener("SIGTERM", finish); process.removeListener("SIGHUP", finish);
    process.removeListener("exit", restore);
  }
  console.log("Host console closed. Reopen anytime with: tor-host dashboard");
}
