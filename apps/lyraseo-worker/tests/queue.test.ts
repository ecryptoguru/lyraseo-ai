import {
  createMessageBatch,
  createExecutionContext,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { consume } from "../src/carrier";
import { enabled, json, queued, responder } from "./helpers";
afterEach(() => vi.restoreAllMocks());
async function run(
  bodies: unknown[],
  transport?: Parameters<typeof consume>[2],
  e = enabled(),
) {
  const batch = createMessageBatch(
    "lyraseo-carrier-local",
    bodies.map((body, i) => ({
      id: String(i),
      timestamp: new Date(),
      body,
      attempts: 1,
    })),
  );
  const retry = batch.messages.map((message) => vi.spyOn(message, "retry"));
  const ctx = createExecutionContext();
  await consume(batch, e, transport);
  for (const spy of retry)
    if (spy.mock.calls.length)
      expect(spy).toHaveBeenCalledWith({ delaySeconds: 60 });
  return getQueueResult(batch, ctx);
}
for (const disposition of ["COMPLETED", "YIELDED", "STALE"])
  it(`native explicit ack ${disposition}`, async () => {
    const result = await run(
      [queued],
      responder(() => json({ disposition })),
    );
    expect(result.explicitAcks).toEqual(["0"]);
    expect(result.retryMessages).toEqual([]);
    expect(result.ackAll).toBe(false);
  });
for (const response of [
  () => json({ disposition: "IN_PROGRESS" }),
  () => json({ disposition: "RETRY" }, 503),
  () => json({ disposition: "PAUSED" }),
  () => json({ disposition: "CHECKPOINTED" }),
  () => json({ disposition: "COMPLETED", proof: "private" }),
  () => json({ error: "INVALID_AUTHENTICATION" }, 401),
  () => json({ error: "REQUEST_CONFLICT" }, 409),
  () => new Response(null),
])
  it(`retries unknown/nonterminal response ${response().status} ${response.toString()}`, async () => {
    const result = await run([queued], responder(response));
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: "0" }]);
  });
it("poison and legacy bodies never reach a bridge; logs contain only fixed codes", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const send = vi.fn();
  const result = await run(
    [
      { operationId: "private-url" },
      { ...queued, claimToken: "secret" },
      { ...queued, generation: 0 },
      { ...queued, version: 2 },
      null,
    ],
    send,
  );
  expect(send).not.toHaveBeenCalled();
  expect(result.retryMessages).toHaveLength(5);
  expect(result.explicitAcks).toEqual([]);
  for (const [entry] of spy.mock.calls)
    expect(JSON.parse(entry as string)).toEqual({
      code: "QUEUE_SCHEMA",
      attempts: 1,
    });
});
it("mixed batch preserves first ack and explicitly retries excess serial work", async () => {
  const send = vi.fn(responder(() => json({ disposition: "COMPLETED" })));
  const result = await run([queued, { operationId: "x" }, queued], send);
  expect(send).toHaveBeenCalledTimes(1);
  expect(result.explicitAcks).toEqual(["0"]);
  expect(result.retryMessages.map((x) => x.msgId)).toEqual(["1", "2"]);
});
it("default exported worker never calls network when unqualified", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const batch = createMessageBatch("lyraseo-carrier-local", [
    { id: "disabled", timestamp: new Date(), body: queued, attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  const result = await getQueueResult(batch, ctx);
  expect(fetch).not.toHaveBeenCalled();
  expect(result.retryMessages).toHaveLength(1);
  expect(worker.fetch().status).toBe(503);
});
it("round1 exact cutoff success retries native message before timer callback", async () => {
  let now = Date.now();
  const initial = now;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const response = json({ disposition: "COMPLETED" });
  const cancel = vi.spyOn(response.body!, "cancel");
  const result = await run(
    [queued],
    responder(() => {
      now = initial + 47000;
      return response;
    }),
  );
  expect(result.explicitAcks).toEqual([]);
  expect(result.retryMessages.map((x) => x.msgId)).toEqual(["0"]);
  expect(cancel).toHaveBeenCalled();
});
