import { afterEach, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import DataSections from "./sections";

afterEach(() => vi.useRealTimers());

it("renders the same initial HTML at build time and hydration time", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T10:00:00Z"));
  const buildHtml = renderToString(<DataSections hosts={[]} models={[]} receipts={[]} updatedAt={null} />);
  vi.setSystemTime(new Date("2026-09-11T10:05:00Z"));
  const browserHtml = renderToString(<DataSections hosts={[]} models={[]} receipts={[]} updatedAt={null} />);
  expect(buildHtml).toBe(browserHtml);
  expect(browserHtml).toContain("Waiting for data");
});

it("labels the actual refresh time instead of the render time", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T11:05:00Z"));
  const html = renderToString(<DataSections hosts={[]} models={[]} receipts={[]} updatedAt={Date.parse("2026-09-11T10:42:00Z")} />);
  expect(html).toContain("Updated 10:42 UTC");
});
