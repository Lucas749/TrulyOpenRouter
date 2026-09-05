"use client";

function Bar({ pct, color = "#0D0D0D" }: { pct: number; color?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#F4F4F4]">
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
    </div>
  );
}

export interface SectionsData {
  hosts: any[];
  models: any[];
  receipts: any[];
}

function dollarsPer1k(avgCreditsPer1k: string | null): string {
  if (avgCreditsPer1k === null) return "—";
  return `$${(Number(avgCreditsPer1k) * 0.001).toFixed(4)}`;
}

export default function DataSections({ hosts, models, receipts }: SectionsData) {
  const stamp = new Date().toISOString().slice(11, 16);
  const byModel = new Map<string, { tokens: number; calls: number }>();
  for (const r of receipts) {
    const m = r.modelId ?? "unknown";
    const e = byModel.get(m) ?? { tokens: 0, calls: 0 };
    e.tokens += (r.tokensIn ?? 0) + (r.tokensOut ?? 0);
    e.calls += 1;
    byModel.set(m, e);
  }
  const totalTokens = [...byModel.values()].reduce((a, e) => a + e.tokens, 0);
  const share = [...byModel.entries()].map(([id, e]) => ({ id, ...e, pct: totalTokens ? (e.tokens / totalTokens) * 100 : 0 })).sort((a, b) => b.tokens - a.tokens);

  const hours = new Array(24).fill(0);
  const now = Date.now();
  for (const r of receipts) {
    const h = Math.floor((now - r.ts) / 3_600_000);
    if (h >= 0 && h < 24) hours[23 - h] += 1;
  }
  const maxH = Math.max(1, ...hours);

  const byRegion = new Map<string, number>();
  for (const h of hosts) {
    if (!h.region) continue;
    byRegion.set(h.region, (byRegion.get(h.region) ?? 0) + 1);
  }
  const regions = [...byRegion.entries()].sort((a, b) => b[1] - a[1]);
  const totalHosts = Math.max(1, hosts.length);

  const priced = hosts.filter((h) => h.active);
  const cheapest = priced.length ? priced.reduce((a, b) => (BigInt(a.pricePerReq) < BigInt(b.pricePerReq) ? a : b)) : null;
  const busiest = hosts.length ? [...hosts].sort((a, b) => (b.calls24h ?? 0) - (a.calls24h ?? 0))[0] : null;
  const reliable = hosts.length
    ? [...hosts].filter((h) => h.reliability !== null).sort((a, b) => (b.reliability ?? 0) - (a.reliability ?? 0))[0]
    : null;

  const section = "flex flex-col gap-4";
  const h2 = "m-0 text-[20px] font-medium tracking-[-0.02em]";
  const updated = <span className="font-mono text-xs text-[#8F8F8F]">Updated {stamp} UTC</span>;

  return (
    <div className="flex flex-col gap-10">
      <nav className="sticky top-16 z-20 flex gap-4 overflow-x-auto border-b border-[#E5E5E0] bg-white/90 py-2 text-sm backdrop-blur">
        {[["volume", "Volume"], ["cost", "Token Cost"], ["reliability", "Reliability"], ["share", "Market Share"], ["geo", "Geo"]].map(([id, label]) => (
          <a key={id} href={`#sec-${id}`} className="whitespace-nowrap text-[#6E6E73] hover:text-black">{label}</a>
        ))}
      </nav>

      <section id="sec-volume" className={section}>
        <div className="flex items-baseline justify-between"><h2 className={h2}>Volume</h2>{updated}</div>
        <div className="flex h-24 items-end gap-1">
          {hours.map((v, i) => (
            <div key={i} className="flex-1 rounded-sm bg-[#0D0D0D]" style={{ height: `${Math.max(3, (v / maxH) * 100)}%`, opacity: v ? 1 : 0.12 }} title={`${v} calls`} />
          ))}
        </div>
        <p className="m-0 font-mono text-xs text-[#8F8F8F]">settled calls per hour, trailing 24h</p>
      </section>

      <section id="sec-cost" className={section}>
        <div className="flex items-baseline justify-between"><h2 className={h2}>Token Cost</h2>{updated}</div>
        {models.length ? (
          <div className="overflow-x-auto rounded-[14px] border border-[#E5E5E0]">
            <table className="w-full text-left text-sm">
              <thead><tr className="border-b border-[#E5E5E0] text-xs uppercase tracking-wide text-[#6E6E73]">
                <th className="px-4 py-3 font-medium">Model</th><th className="px-4 py-3 font-medium">24h calls</th>
                <th className="px-4 py-3 font-medium">24h tokens</th><th className="px-4 py-3 font-medium">Avg $/1k</th>
              </tr></thead>
              <tbody>
                {models.map((m: any) => (
                  <tr key={m.id} className="border-b border-[#F4F4F4] last:border-0">
                    <td className="px-4 py-3 font-mono text-xs">{m.id}</td>
                    <td className="px-4 py-3 font-mono text-xs">{m.calls24h ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs">{(m.tokens24h ?? 0).toLocaleString("en-US")}</td>
                    <td className="px-4 py-3 font-mono text-xs">{dollarsPer1k(m.avgCreditsPer1kTokens ?? null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="m-0 text-sm text-[#8F8F8F]">no models with traffic yet</p>
        )}
      </section>

      <section id="sec-reliability" className={section}>
        <div className="flex items-baseline justify-between"><h2 className={h2}>Reliability</h2>{updated}</div>
        {hosts.length ? (
          <div className="flex flex-col gap-3">
            {hosts.map((h: any) => (
              <div key={h.address} className="flex items-center gap-3 text-sm">
                <span className="w-24 shrink-0 truncate font-mono text-xs">{h.address.slice(0, 8)}…</span>
                <div className="flex-1"><Bar pct={(h.reliability ?? 0) * 100} color={h.active ? "#10A37F" : "#DC2626"} /></div>
                <span className="w-14 text-right font-mono text-xs">{h.reliability === null || h.reliability === undefined ? "—" : `${(h.reliability * 100).toFixed(1)}%`}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 text-sm text-[#8F8F8F]">no hosts registered yet</p>
        )}
      </section>

      <section id="sec-share" className={section}>
        <div className="flex items-baseline justify-between"><h2 className={h2}>Market Share</h2>{updated}</div>
        {share.length ? (
          <div className="flex flex-col gap-3">
            {share.map((s) => (
              <div key={s.id} className="flex items-center gap-3 text-sm">
                <span className="w-32 shrink-0 truncate font-mono text-xs">{s.id}</span>
                <div className="flex-1"><Bar pct={s.pct} /></div>
                <span className="w-24 text-right font-mono text-xs">{s.pct.toFixed(1)}% · {(s.tokens || 0).toLocaleString("en-US")} tok</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 text-sm text-[#8F8F8F]">no token flow yet — share appears with traffic</p>
        )}
      </section>

      <section id="sec-geo" className={section}>
        <div className="flex items-baseline justify-between"><h2 className={h2}>Geo</h2>{updated}</div>
        {regions.length ? (
          <div className="flex flex-col gap-3">
            {regions.map(([r, n]) => (
              <div key={r} className="flex items-center gap-3 text-sm">
                <span className="w-24 shrink-0 font-mono text-xs">{r}</span>
                <div className="flex-1"><Bar pct={(n / totalHosts) * 100} /></div>
                <span className="w-20 text-right font-mono text-xs">{n} host{n === 1 ? "" : "s"}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 text-sm text-[#8F8F8F]">no self-reported regions yet</p>
        )}
        <p className="m-0 font-mono text-[11px] text-[#8F8F8F]">regions are host self-reports, not verified geo</p>
      </section>

      {(cheapest || busiest || reliable) && (
        <section className="flex flex-col gap-4">
          <h2 className={h2}>Compare</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              cheapest && { t: "Cheapest right now", id: cheapest.address, d: `${cheapest.pricePerReq} wei/req · ${cheapest.modelId}` },
              busiest && { t: "Top by 24h calls", id: busiest.address, d: `${busiest.calls24h ?? 0} calls · ${busiest.modelId}` },
              reliable && { t: "Most reliable", id: reliable.address, d: `${((reliable.reliability ?? 0) * 100).toFixed(1)}% success · ${reliable.modelId}` },
            ].map((c) =>
              c ? (
                <a key={c.t} href={`/network/host/${c.id}`} className="flex flex-col gap-1.5 rounded-[14px] border border-[#E5E5E0] p-4 hover:bg-black/[0.02]">
                  <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#6E6E73]">{c.t}</span>
                  <span className="font-mono text-sm">{c.id.slice(0, 10)}…</span>
                  <span className="font-mono text-xs text-[#6E6E73]">{c.d}</span>
                </a>
              ) : null,
            )}
          </div>
        </section>
      )}
    </div>
  );
}
