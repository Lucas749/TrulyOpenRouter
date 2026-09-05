// Self-reported host regions ("eu-central"). Offchain metadata — the registry stays minimal.
// Displayed as self-reported everywhere (never presented as verified geo).

const REGION_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function validRegion(region: unknown): region is string {
  return typeof region === "string" && REGION_RE.test(region);
}

export class MemoryHostMeta {
  private regions = new Map<string, string>();
  private owners = new Map<string, string>(); // host -> Privy user id (claimed at link time)

  setRegion(address: string, region: string): void {
    this.regions.set(address.toLowerCase(), region);
  }

  regionOf(address: string): string | null {
    return this.regions.get(address.toLowerCase()) ?? null;
  }

  distinctRegions(): string[] {
    return [...new Set(this.regions.values())];
  }

  setOwner(address: string, userId: string): void {
    this.owners.set(address.toLowerCase(), userId);
  }

  ownerOf(address: string): string | null {
    return this.owners.get(address.toLowerCase()) ?? null;
  }

  hostsOf(userId: string): string[] {
    return [...this.owners.entries()].filter(([, u]) => u === userId).map(([a]) => a);
  }
}
