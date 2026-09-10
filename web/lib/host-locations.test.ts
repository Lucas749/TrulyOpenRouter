import { expect, it } from "vitest";
import { hostLocation } from "./host-locations";

it("maps the actual gateway region slugs for Dubai and Oregon", () => {
  expect(hostLocation("ae-dubai")).toMatchObject({ label: "Dubai", coordinates: [55.27, 25.2] });
  expect(hostLocation("us-oregon")).toMatchObject({ label: "Oregon", coordinates: [-120.55, 43.93] });
});

it("uses an explicitly approximate country center for new region names", () => {
  expect(hostLocation("fr-brittany", { France: [2, 47] })).toMatchObject({ label: "France", coordinates: [2, 47], approximate: true });
  expect(hostLocation("us-new-region", { "United States of America": [-100, 40] })?.approximate).toBe(true);
});

it("keeps missing and unmappable locations off the globe", () => {
  expect(hostLocation(null)).toBeNull();
  expect(hostLocation("moon-base")).toBeNull();
  expect(hostLocation("fr-new-region")).toBeNull();
});

it("retains broad region support and normalizes input", () => {
  expect(hostLocation(" AE-DUBAI ")?.label).toBe("Dubai");
  expect(hostLocation("eu-west")?.coordinates).toEqual([4.9, 52.4]);
});
