// Minimal ANSI UI kit: spinners, step lists, boxes. Zero deps, OpenCode/Claude-Code flavor.
// All renderers are pure (return strings) except Spinner, so they stay unit-tested.

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  amber: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function frames(): string[] {
  return [...FRAMES];
}

export type StepState = "pending" | "active" | "done" | "fail";

export function stepIcon(s: StepState): string {
  switch (s) {
    case "done": return `${C.green}●${C.reset}`;
    case "active": return `${C.cyan}◐${C.reset}`;
    case "fail": return `${C.red}●${C.reset}`;
    default: return `${C.gray}○${C.reset}`;
  }
}

export interface Step {
  label: string;
  state: StepState;
  detail?: string;
}

export function renderSteps(steps: Step[]): string {
  return steps
    .map((s) => `  ${stepIcon(s.state)} ${s.label}${s.detail ? ` ${C.dim}${s.detail}${C.reset}` : ""}`)
    .join("\n");
}

export function box(title: string, lines: string[], width = 56): string {
  const w = Math.max(width, title.length + 4, ...lines.map((l) => l.length + 2));
  const top = `╭─ ${title} ${"─".repeat(Math.max(0, w - title.length - 4))}╮`;
  const bottom = `╰${"─".repeat(w)}╯`;
  const body = lines.map((l) => `│ ${l.padEnd(w - 2)}│`).join("\n");
  return `${C.gray}${top}${C.reset}\n${body}\n${C.gray}${bottom}${C.reset}`;
}

const MARK = ["█████   ███   ████ ", "  █    █   █  █   █", "  █    █   █  ████ ", "  █    █   █  █ █  ", "  █     ███   █  █ "];

export function mark(): string {
  return MARK.map((l) => `${C.bold}${l}${C.reset}`).join("\n");
}

export function banner(): string {
  // TOR_QUIET=1 when orchestrated (quickstart owns the screen already) —
  // the link box, spinners and results still print, just no second banner.
  if (process.env.TOR_QUIET) return "";
  return `${mark()}\n${C.bold}TrulyOpenRouter${C.reset} ${C.dim}· host CLI · like OpenRouter, except open${C.reset}`;
}

export function ok(msg: string): string {
  return `${C.green}✓${C.reset} ${msg}`;
}

export function warn(msg: string): string {
  return `${C.amber}!${C.reset} ${msg}`;
}

export function err(msg: string): string {
  return `${C.red}✕${C.reset} ${msg}`;
}

/// @notice TTY spinner. No-op strings when piped (clean logs).
export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private i = 0;
  private text = "";

  constructor(private stream: NodeJS.WriteStream = process.stderr) {}

  start(text: string): void {
    this.text = text;
    if (!this.stream.isTTY) {
      this.stream.write(`${text}...\n`);
      return;
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), 80);
  }

  message(text: string): void {
    this.text = text;
  }

  stop(final?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.stream.write("\r\x1b[K");
    }
    if (final) this.stream.write(`${final}\n`);
  }

  private tick(): void {
    this.stream.write(`\r${C.cyan}${FRAMES[this.i++ % FRAMES.length]}${C.reset} ${this.text}`);
  }
}


