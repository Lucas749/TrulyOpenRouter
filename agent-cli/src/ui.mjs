// Minimal ANSI UI kit, matching the host CLI's look: spinners, boxes, marks. No dependencies.
// Renderers are pure (return strings) except Spinner, and colour switches off when piped.

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

function ansi(key) {
  if (process.env.NO_COLOR !== undefined) return "";
  const enabled = process.env.FORCE_COLOR === "1" || process.stdout.isTTY || process.stderr.isTTY;
  return enabled ? C[key] : "";
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const dim = (text) => `${ansi("dim")}${text}${ansi("reset")}`;
export const bold = (text) => `${ansi("bold")}${text}${ansi("reset")}`;
export const ok = (text) => `${ansi("green")}✓${ansi("reset")} ${text}`;
export const warn = (text) => `${ansi("amber")}!${ansi("reset")} ${text}`;
export const err = (text) => `${ansi("red")}✕${ansi("reset")} ${text}`;

const MAX_BOX = 76;

export function box(title, lines, width = 56) {
  // Clip long values so the border always lines up, whatever path or id lands in a row.
  lines = lines.map((line) => (line.length <= MAX_BOX ? line : `${line.slice(0, MAX_BOX - 1)}…`));
  const w = Math.min(MAX_BOX + 2, Math.max(width, title.length + 4, ...lines.map((l) => l.length + 2)));
  const top = `╭─ ${title} ${"─".repeat(Math.max(0, w - title.length - 4))}╮`;
  const bottom = `╰${"─".repeat(w)}╯`;
  const body = lines.map((l) => `│ ${l.padEnd(w - 2)}│`).join("\n");
  return `${ansi("gray")}${top}${ansi("reset")}\n${body}\n${ansi("gray")}${bottom}${ansi("reset")}`;
}

export const BRAND_MARK = ["█████   ███   ████ ", "  █    █   █  █   █", "  █    █   █  ████ ", "  █    █   █  █ █  ", "  █     ███   █  █ "];

export function banner() {
  // TOR_QUIET=1 when another tool owns the screen; results and spinners still print.
  if (process.env.TOR_QUIET) return "";
  const mark = BRAND_MARK.map((line) => bold(line)).join("\n");
  return `${mark}\n${bold("TrulyOpenRouter")} ${dim("· agent CLI · the key stays sealed in your Ledger Key Ring")}`;
}

/// @notice TTY spinner. Plain lines when piped, so logs stay readable.
export class Spinner {
  constructor(stream = process.stderr) {
    this.stream = stream;
    this.timer = null;
    this.i = 0;
    this.text = "";
  }

  start(text) {
    this.text = text;
    if (!this.stream.isTTY) {
      this.stream.write(`${text}...\n`);
      return this;
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), 80);
    return this;
  }

  message(text) {
    if (!this.stream.isTTY && text !== this.text) this.stream.write(`${text}...\n`);
    this.text = text;
  }

  stop(final) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.stream.write("\r\x1b[K");
    }
    if (final) this.stream.write(`${final}\n`);
  }

  tick() {
    this.stream.write(`\r${ansi("cyan")}${FRAMES[this.i++ % FRAMES.length]}${ansi("reset")} ${this.text}`);
  }
}
