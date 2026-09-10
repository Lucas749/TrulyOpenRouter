export interface HostLocation {
  region: string;
  label: string;
  coordinates: [number, number];
  approximate: boolean;
}

// Region centers, not a host's street address. Keep the operator and gateway
// slug format (cc-region) alongside the broader regions used in previews.
const REGIONS: Record<string, { label: string; coordinates: [number, number] }> = {
  "ae-dubai": { label: "Dubai", coordinates: [55.27, 25.2] },
  "ae-abu-dhabi": { label: "Abu Dhabi", coordinates: [54.37, 24.45] },
  "us-oregon": { label: "Oregon", coordinates: [-120.55, 43.93] },
  "us-california": { label: "California", coordinates: [-119.4, 36.8] },
  "us-virginia": { label: "Virginia", coordinates: [-78.66, 37.43] },
  "us-west": { label: "US West", coordinates: [-122.4, 37.8] },
  "us-east": { label: "US East", coordinates: [-77.5, 39] },
  "us-central": { label: "US Central", coordinates: [-98.5, 29.4] },
  "ca-central": { label: "Canada Central", coordinates: [-79.4, 43.7] },
  "sa-east": { label: "South America East", coordinates: [-46.6, -23.5] },
  "eu-central": { label: "Europe Central", coordinates: [8.7, 50.1] },
  "eu-west": { label: "Europe West", coordinates: [4.9, 52.4] },
  "eu-north": { label: "Europe North", coordinates: [18.1, 59.3] },
  "eu-south": { label: "Europe South", coordinates: [14.5, 41.9] },
  "af-west": { label: "Africa West", coordinates: [3.4, 6.5] },
  "af-south": { label: "Africa South", coordinates: [18.4, -33.9] },
  "ap-south": { label: "Asia South", coordinates: [72.9, 19.1] },
  "ap-se": { label: "Southeast Asia", coordinates: [103.8, 1.35] },
  "ap-ne": { label: "Northeast Asia", coordinates: [139.7, 35.7] },
  "ap-east": { label: "Asia East", coordinates: [114.1, 22.3] },
  "ap-oce": { label: "Oceania", coordinates: [151.2, -33.9] },
};

const COUNTRY_NAMES: Record<string, string> = { US: "United States of America", CD: "Dem. Rep. Congo", CG: "Congo", CF: "Central African Rep.", DO: "Dominican Rep.", GQ: "Eq. Guinea", SS: "S. Sudan", BA: "Bosnia and Herz.", CZ: "Czechia", SZ: "eSwatini" };

export function hostLocation(region: string | null | undefined, countries: Record<string, [number, number]> = {}): HostLocation | null {
  if (!region) return null;
  const slug = region.trim().toLowerCase();
  const known = REGIONS[slug];
  if (known) return { region: slug, ...known, approximate: false };
  const code = /^([a-z]{2})(?:-|$)/.exec(slug)?.[1].toUpperCase();
  if (!code) return null;
  const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
  if (!name || name === code) return null;
  const coordinates = countries[COUNTRY_NAMES[code] ?? name];
  return coordinates ? { region: slug, label: name, coordinates, approximate: true } : null;
}
