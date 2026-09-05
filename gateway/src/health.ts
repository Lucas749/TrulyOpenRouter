// Upstream failure tracking (24h rolling window, in-memory).
// Successes come from the receipt log; only failures need a separate counter.
// reliability = success / (success + fail), null when nothing observed.

const DAY = 86_400_000;

export class MemoryHealth {
  private fails = new Map<string, number[]>();

  recordFail(address: string, now = Date.now()): void {
    const list = this.fails.get(address.toLowerCase()) ?? [];
    list.push(now);
    this.fails.set(address.toLowerCase(), list);
  }

  fails24h(address: string, now = Date.now()): number {
    const list = (this.fails.get(address.toLowerCase()) ?? []).filter((t) => now - t < DAY);
    this.fails.set(address.toLowerCase(), list);
    return list.length;
  }

  reliability(success24h: number, address: string, now = Date.now()): number | null {
    const fails = this.fails24h(address, now);
    if (success24h + fails === 0) return null;
    return success24h / (success24h + fails);
  }
}
