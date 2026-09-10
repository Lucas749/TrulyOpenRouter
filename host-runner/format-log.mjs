import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";

export function formatLog(input, { width = 80, lines = 6 } = {}) {
  const columns = Math.max(20, width - 4);
  const cleaned = stripVTControlCharacters(input.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, ""))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .split(/\r\n?|\n/)
    .map((line) => line.trimEnd().replace(/(pulling [0-9a-f]{4})[0-9a-f]*: *([0-9]+%?).*/, "$1… $2"))
    .filter((line) => line.trim());
  const result = [];
  for (const line of cleaned.slice(-lines)) {
    let remaining = [...line];
    while (remaining.length > columns) {
      const candidate = remaining.slice(0, columns).lastIndexOf(" ");
      const end = candidate > columns / 2 ? candidate : columns;
      result.push(remaining.slice(0, end).join(""));
      remaining = remaining.slice(end);
      while (remaining[0] === " ") remaining.shift();
    }
    result.push(remaining.join(""));
  }
  return result.map((line) => `  ${line}`).join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const output = formatLog(readFileSync(process.argv[2], "utf8"), {
      lines: Number(process.argv[3]) || 6, width: Number(process.argv[4]) || 80,
    });
    if (output) process.stdout.write(output + "\n");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
