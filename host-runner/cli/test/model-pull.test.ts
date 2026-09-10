import { expect, it } from "vitest";
import { readPullProgress } from "../src/model-pull.js";

const stream = (parts: string[]) => new Response(new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } }));
it("reads fragmented download updates and waits for completion", async () => {
  const progress: string[] = [];
  await readPullProgress(stream(['{"status":"pulling","total":100,', '"completed":20}\n{"status":"pulling","total":100,"completed":20}\n', '{"status":"success"}']), message => progress.push(message));
  expect(progress).toEqual(["pulling · 20%", "success"]);
});
it("rejects truncated downloads and errors after progress has begun", async () => {
  await expect(readPullProgress(stream(['{"status":"pulling"}\n']), () => {})).rejects.toThrow("before completion");
  await expect(readPullProgress(stream(['{"status":"pulling"}\n{"error":"disk full"}']), () => {})).rejects.toThrow("disk full");
});
