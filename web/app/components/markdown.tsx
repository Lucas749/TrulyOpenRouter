"use client";

import type { ReactNode } from "react";

// Enough markdown for model output: headings, lists, fenced code, bold, italic,
// inline code and links. Nodes are built directly rather than through innerHTML,
// so a completion can never inject markup into the page.

const SAFE_HREF = /^https?:\/\//i;
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${n++}`;
    if (tok.startsWith("`")) {
      out.push(<code key={k} className="rounded bg-[#F4F4F4] px-1 py-0.5 font-mono text-[13px]">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      out.push(<strong key={k} className="font-semibold">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      const href = link?.[2] ?? "";
      out.push(link && SAFE_HREF.test(href)
        ? <a key={k} href={href} target="_blank" rel="noreferrer" className="text-[#2563EB] underline">{link[1]}</a>
        : <span key={k}>{link?.[1] ?? tok}</span>);
    } else {
      out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  INLINE.lastIndex = 0;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^(#{1,4})\s+(.*)$/;

export default function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (!para.length) return;
    const key = `p${blocks.length}`;
    blocks.push(<p key={key} className="m-0 text-[15px] leading-relaxed">{inline(para.join(" "), key)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const key = `l${blocks.length}`;
    const items = list.items.map((it, i) => <li key={`${key}-${i}`} className="leading-relaxed">{inline(it, `${key}-${i}`)}</li>);
    blocks.push(list.ordered
      ? <ol key={key} className="m-0 list-decimal space-y-1 pl-5 text-[15px]">{items}</ol>
      : <ul key={key} className="m-0 list-disc space-y-1 pl-5 text-[15px]">{items}</ul>);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      flushPara();
      flushList();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith("```"); i++) body.push(lines[i]);
      const key = `c${blocks.length}`;
      blocks.push(
        <pre key={key} className="m-0 overflow-x-auto rounded-lg bg-[#0D0D0D] p-3 font-mono text-[12px] leading-relaxed text-[#E6EAF0]">{body.join("\n")}</pre>,
      );
      continue;
    }

    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const key = `h${blocks.length}`;
      const size = heading[1].length <= 2 ? "text-[17px]" : "text-[15px]";
      blocks.push(<p key={key} className={`m-0 font-semibold ${size}`}>{inline(heading[2], key)}</p>);
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBER.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((numbered ? numbered[2] : bullet![1]).trim());
      continue;
    }

    // A plain line under an open list continues that item rather than starting a paragraph.
    if (list) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  flushList();

  return <div className="flex w-full flex-col gap-3">{blocks}</div>;
}
