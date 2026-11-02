import {
  createScheduledController,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { scheduledTick } from "../src/carrier";
import { runtimePaths } from "@lyraseo/contracts/runtime-signing";
import { enabled, json, responder } from "./helpers";
it("native scheduled waitUntil completes one recover then one dispatch", async () => {
  const calls: string[] = [];
  const ctx = createExecutionContext();
  const controller = createScheduledController({
    cron: "*/5 * * * *",
    scheduledTime: new Date("2026-11-03T10:05:00Z"),
  });
  ctx.waitUntil(
    scheduledTick(
      controller,
      enabled(),
      responder((path) => {
        calls.push(path);
        return json(
          path === runtimePaths[4]
            ? {
                disposition: "OK",
                reopened: 0,
                suppressed: 0,
                reconciliation: 0,
              }
            : { disposition: "OK", refs: [] },
        );
      }),
    ),
  );
  await waitOnExecutionContext(ctx);
  expect(calls).toEqual([runtimePaths[4], runtimePaths[0]]);
});
it("coincident minute branch skips while ordinary minute dispatches once", async () => {
  const wire = vi.fn(responder(() => json({ disposition: "OK", refs: [] })));
  await scheduledTick(
    createScheduledController({
      cron: "* * * * *",
      scheduledTime: new Date("2026-11-03T10:05:00Z"),
    }),
    enabled(),
    wire,
  );
  expect(wire).not.toHaveBeenCalled();
  await scheduledTick(
    createScheduledController({
      cron: "* * * * *",
      scheduledTime: new Date("2026-11-03T10:06:00Z"),
    }),
    enabled(),
    wire,
  );
  expect(wire).toHaveBeenCalledTimes(1);
});
it("failed recovery is observable even if the bounded dispatch succeeds", async () => {
  const calls: string[] = [];
  await expect(
    scheduledTick(
      createScheduledController({ cron: "*/5 * * * *" }),
      enabled(),
      responder((path) => {
        calls.push(path);
        return path === runtimePaths[4]
          ? json({ error: "UNAVAILABLE" }, 503)
          : json({ disposition: "OK", refs: [] });
      }),
    ),
  ).rejects.toThrow();
  expect(calls).toEqual([runtimePaths[4], runtimePaths[0]]);
});
it("exported scheduled handler registers actual bounded work with native context", async () => {
  const { default: worker } = await import("../src/index");
  const requests: Request[] = [];
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const request = input as Request;
      requests.push(request);
      return new URL(request.url).pathname === runtimePaths[4]
        ? json({
            disposition: "OK",
            reopened: 0,
            suppressed: 0,
            reconciliation: 0,
          })
        : json({ disposition: "OK", refs: [] });
    });
  try {
    const ctx = createExecutionContext();
    worker.scheduled(
      createScheduledController({ cron: "*/5 * * * *" }),
      enabled(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      runtimePaths[4],
      runtimePaths[0],
    ]);
  } finally {
    spy.mockRestore();
  }
});
