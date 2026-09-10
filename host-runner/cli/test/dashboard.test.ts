import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialView, navigate, webLink } from "../src/dashboard.js";
import { cleanText, renderMonitor, textWidth, wrap } from "../src/monitor-view.js";
import { collectLog, rememberLogFiles } from "../src/monitor-logs.js";
import { serviceControl } from "../src/monitor-controls.js";

afterEach(() => vi.unstubAllEnvs());

describe("terminal dashboard", () => {
  it("navigates tabs, scrolls, and switches log sources without losing the selected tab", () => {
    const state = navigate(initialView(), { sequence: "5" });
    expect(state.tab).toBe(4);
    expect(navigate(state, { name: "l" }).logSource).toBe("ollama");
    expect(navigate(state, { name: "pagedown" }, 15).scroll).toBe(15);
    expect(navigate({ ...state, scroll: 15 }, { name: "right" })).toMatchObject({ tab: 5, scroll: 0 });
    expect(navigate({ ...state, tab: 0 }, { name: "left" }).tab).toBe(6);
  });

  it("fits small and large terminals, including wide model names and long logs", () => {
    for (const [columns, rows] of [[100, 32], [80, 24], [40, 12], [25, 8]]) {
      const state = { ...initialView(), tab: 4, logs: ["模型 ".repeat(100), "x".repeat(200), "ANSI: \x1b[31mred\x1b[0m"] };
      const output = renderMonitor(null, state, columns, rows, false);
      expect(output.split("\r\n").length).toBeLessThan(rows);
      for (const line of output.split("\r\n")) expect(textWidth(line)).toBeLessThan(columns);
      expect(output).not.toContain("\x1b");
    }
    expect(wrap("MODEL       TOKENS", 80)).toEqual(["MODEL       TOKENS"]);
  });

  it("strips escape sequences, terminal title changes, controls, and credential values", () => {
    const output = cleanText("\x1b[32mready\x1b[0m\x1b]0;injected title\x07\nnext\u202e Bearer secret token=hidden");
    expect(output).toBe("ready next  Bearer [redacted] token=[redacted]");
    expect(output).not.toMatch(/secret|hidden|injected|\x1b/);
  });

  it("opens the frontend for a hosted gateway without carrying credentials", () => {
    expect(webLink("https://example.test/api/gw", "/network")).toBe("https://example.test/network");
    expect(webLink("https://user:secret@example.test/api/gw", "/network")).toBe("https://trulyopenrouter.vercel.app/network");
  });

  it("reads a bounded log tail and retains setup paths without copying config secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tor-monitor-"));
    vi.stubEnv("TOR_HOME", dir);
    try {
      const log = join(dir, "tunnel.log");
      writeFileSync(log, "old line\n".repeat(4000) + "latest tunnel ready\n");
      rememberLogFiles({ tunnel: log });
      expect(statSync(join(dir, "monitor.json")).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(dir, "monitor.json"), "utf8"))).toEqual({ tunnel: log });
      const lines = await collectLog("tunnel");
      expect(lines.length).toBeLessThanOrEqual(80);
      expect(lines.at(-1)).toBe("latest tunnel ready");
      rmSync(log);
      expect((await collectLog("tunnel"))[0]).toContain("no longer available");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("resumes existing containers without rebuilding or changing their configuration", async () => {
    const shell = vi.fn().mockResolvedValue({ ok: true, out: "" });
    expect(await serviceControl("s", undefined, shell)).toContain("Local services started");
    expect(shell.mock.calls[0][1].slice(-3)).toEqual(["start", "ollama", "guard"]);
    expect(shell.mock.calls[0][1]).not.toContain("up");
    await serviceControl("p", undefined, shell);
    expect(shell.mock.calls[1][1].slice(-2)).toEqual(["stop", "guard"]);
    expect(shell.mock.calls[1][1]).not.toContain("down");
  });

  it("keeps failed service actions visible instead of claiming a successful pause", async () => {
    const result = await serviceControl("p", undefined, vi.fn().mockResolvedValue({ ok: false, out: "daemon unreachable" }));
    expect(result).toContain("did not finish");
    expect(result).not.toContain("Local guard paused");
  });
});
