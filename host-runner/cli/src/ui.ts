// Minimal ANSI UI kit: spinners, step lists, boxes. No dependencies.
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

function ansi(key: keyof typeof C): string {
  if (process.env.NO_COLOR !== undefined) return "";
  const enabled = process.env.FORCE_COLOR === "1" || process.stdout.isTTY || process.stderr.isTTY;
  return enabled ? C[key] : "";
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function frames(): string[] {
  return [...FRAMES];
}

export type StepState = "pending" | "active" | "done" | "fail";

export function stepIcon(s: StepState): string {
  switch (s) {
    case "done": return `${ansi("green")}●${ansi("reset")}`;
    case "active": return `${ansi("cyan")}◐${ansi("reset")}`;
    case "fail": return `${ansi("red")}●${ansi("reset")}`;
    default: return `${ansi("gray")}○${ansi("reset")}`;
  }
}

export interface Step {
  label: string;
  state: StepState;
  detail?: string;
}

export function renderSteps(steps: Step[]): string {
  return steps
    .map((s) => `  ${stepIcon(s.state)} ${s.label}${s.detail ? ` ${ansi("dim")}${s.detail}${ansi("reset")}` : ""}`)
    .join("\n");
}

export function box(title: string, lines: string[], width = 56): string {
  const w = Math.max(width, title.length + 4, ...lines.map((l) => l.length + 2));
  const top = `╭─ ${title} ${"─".repeat(Math.max(0, w - title.length - 4))}╮`;
  const bottom = `╰${"─".repeat(w)}╯`;
  const body = lines.map((l) => `│ ${l.padEnd(w - 2)}│`).join("\n");
  return `${ansi("gray")}${top}${ansi("reset")}\n${body}\n${ansi("gray")}${bottom}${ansi("reset")}`;
}

const MARK = ["█████   ███   ████ ", "  █    █   █  █   █", "  █    █   █  ████ ", "  █    █   █  █ █  ", "  █     ███   █  █ "];

export function mark(): string {
  return MARK.map((l) => `${ansi("bold")}${l}${ansi("reset")}`).join("\n");
}

export function banner(): string {
  // TOR_QUIET=1 when orchestrated (quickstart owns the screen already) —
  // the link box, spinners and results still print, just no second banner.
  if (process.env.TOR_QUIET) return "";
  return `${mark()}\n${ansi("bold")}TrulyOpenRouter${ansi("reset")} ${ansi("dim")}· host CLI · like OpenRouter, except open${ansi("reset")}`;
}

export function ok(msg: string): string {
  return `${ansi("green")}✓${ansi("reset")} ${msg}`;
}

export function warn(msg: string): string {
  return `${ansi("amber")}!${ansi("reset")} ${msg}`;
}

export function err(msg: string): string {
  return `${ansi("red")}✕${ansi("reset")} ${msg}`;
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
    if (!this.stream.isTTY && text !== this.text) this.stream.write(`${text}...\n`);
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
    this.stream.write(`\r${ansi("cyan")}${FRAMES[this.i++ % FRAMES.length]}${ansi("reset")} ${this.text}`);
  }
}


