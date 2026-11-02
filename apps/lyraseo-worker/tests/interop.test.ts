import { env } from "cloudflare:workers";
import {
  createMessageBatch,
  createExecutionContext,
  getQueueResult,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runtimePaths } from "@lyraseo/contracts/runtime-signing";
import { Bridge, signEnvelope, type QueueRef } from "../src/bridge";
import worker from "../src/index";
import { consume, publish } from "../src/carrier";
import { enabled } from "./helpers";
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_BRIDGE_SECRET: string;
      TEST_ROTATED_BRIDGE_SECRET: string;
      DLQ_CAPTURE: Fetcher;
    }
  }
}
const integration = !!env.TEST_BRIDGE_SECRET;
async function control(action: string) {
  const r = await fetch("https://harness.test.invalid/" + action);
  expect(r.status).toBe(200);
  return r.json() as Promise<{
    pages: number;
    hops: number;
    work: { id: string; generation: number; disposition: string }[];
    audits: { status: string }[];
  }>;
}
function supervised() {
  return {
    ...enabled(),
    BRIDGE_KEY_ID: "supervised",
    BRIDGE_SECRET: env.TEST_BRIDGE_SECRET,
  };
}
function replacement() {
  return {
    ...supervised(),
    BRIDGE_KEY_ID: "replacement",
    BRIDGE_SECRET: env.TEST_ROTATED_BRIDGE_SECRET,
  };
}
const originalQueue = worker.queue;
const deadline = () => Date.now() + 25000;
async function consumeOne(body: QueueRef, e = supervised()) {
  const batch = createMessageBatch("lyraseo-carrier-local", [
    { id: "native", body, timestamp: new Date(), attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  await consume(batch, e);
  return getQueueResult(batch, ctx);
}
let sent: QueueRef[] = [];
beforeEach(() => {
  sent = [];
  vi.spyOn(worker, "queue").mockImplementation(async (batch) => {
    for (const message of batch.messages) {
      sent.push(message.body as QueueRef);
      message.ack();
    }
  });
});
afterEach(() => vi.restoreAllMocks());
async function captured(): Promise<QueueRef[]> {
  return sent.splice(0);
}
it("configured native WORK_QUEUE binding emits exact JSON", async () => {
  await captured();
  await env.WORK_QUEUE.send(
    {
      version: 1,
      workId: "00000000-0000-4000-8000-000000000002",
      generation: 1,
    },
    { contentType: "json" },
  );
  let bodies: QueueRef[] = [];
  await vi.waitFor(async () => {
    bodies.push(...(await captured()));
    expect(bodies).toHaveLength(1);
  });
  expect(bodies[0]).toEqual({
    version: 1,
    workId: "00000000-0000-4000-8000-000000000002",
    generation: 1,
  });
});
it.runIf(integration)(
  "signed workerd → B HTTP → persisted two-generation journey survives listener restart and duplicate",
  async () => {
    await control("seed");
    await captured();
    const e = supervised();
    await publish(e, deadline());
    let first: QueueRef[] = [];
    await vi.waitFor(async () => {
      first.push(...(await captured()));
      expect(first).toHaveLength(1);
    });
    expect((await consumeOne(first[0]!)).explicitAcks).toEqual(["native"]);
    expect((await control("state")).pages).toBe(1);
    await control("restart");
    expect((await consumeOne(first[0]!)).explicitAcks).toEqual(["native"]);
    expect((await control("state")).pages).toBe(1);
    await publish(e, deadline());
    let next: QueueRef[] = [];
    await vi.waitFor(async () => {
      next.push(...(await captured()));
      expect(next).toHaveLength(1);
    });
    expect(next[0]!.generation).toBe(first[0]!.generation + 1);
    expect((await consumeOne(next[0]!)).explicitAcks).toEqual(["native"]);
    const state = await control("state");
    expect(state.pages).toBe(2);
    expect(state.audits[0]!.status).toBe("COMPLETED");
  },
);
it.runIf(integration)(
  "early consumer retries before sender ack; stale late ack/defer cannot clear successor",
  async () => {
    await control("seed");
    const b = new Bridge(supervised());
    const claimed = await b.command(runtimePaths[0], { limit: 1 }, deadline());
    const ref = claimed.refs![0]!;
    const queue = {
      version: 1 as const,
      workId: ref.workId,
      generation: ref.generation,
    };
    expect((await consumeOne(queue)).retryMessages.map((x) => x.msgId)).toEqual(
      ["native"],
    );
    expect((await control("state")).pages).toBe(0);
    expect(
      (await b.command(runtimePaths[1], ref, deadline())).disposition,
    ).toBe("DELIVERED");
    expect((await consumeOne(queue)).explicitAcks).toEqual(["native"]);
    expect(
      (await b.command(runtimePaths[1], ref, deadline())).disposition,
    ).toBe("STALE");
    expect(
      (
        await b.command(
          runtimePaths[2],
          { ...ref, retrySeconds: 60 },
          deadline(),
        )
      ).disposition,
    ).toBe("STALE");
    expect((await control("state")).work[0]!.generation).toBe(
      ref.generation + 1,
    );
  },
);
it.runIf(integration)(
  "actual B accepts rotation and rejects revoked/cross-path/mutated workerd envelopes",
  async () => {
    await control("seed");
    const b = new Bridge(supervised());
    const envelope = await signEnvelope(
      b.config,
      runtimePaths[0],
      '{"limit":1}',
    );
    const send = (path: string, headers: Headers, body: string) =>
      fetch("https://bridge.test.invalid" + path, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
      });
    const changed = new Headers(envelope.headers);
    changed.set("x-lyra-audience", "other");
    expect((await send(envelope.path, changed, envelope.body)).status).toBe(
      401,
    );
    expect(
      (await send(envelope.path, envelope.headers, envelope.body + " ")).status,
    ).toBe(401);
    expect(
      (await send(runtimePaths[4], envelope.headers, envelope.body)).status,
    ).toBe(401);
    await control("revoke");
    expect(
      (await send(envelope.path, envelope.headers, envelope.body)).status,
    ).toBe(401);
    await control("rotate");
    await expect(
      new Bridge(replacement()).command(
        runtimePaths[4],
        { limit: 20 },
        deadline(),
      ),
    ).resolves.toMatchObject({ disposition: "OK" });
  },
);
for (const action of [
  "pause",
  "cancel",
  "delete",
  "target-revoke",
  "in-progress",
])
  it.runIf(integration)(`persisted ${action} prevents page work`, async () => {
    await control("seed");
    const b = new Bridge(supervised());
    const ref = (await b.command(runtimePaths[0], { limit: 1 }, deadline()))
      .refs![0]!;
    await b.command(runtimePaths[1], ref, deadline());
    await control(action);
    const result = await consumeOne({
      version: 1,
      workId: ref.workId,
      generation: ref.generation,
    });
    expect((await control("state")).pages).toBe(0);
    if (action === "pause" || action === "in-progress")
      expect(result.retryMessages).toHaveLength(1);
    else expect(result.explicitAcks).toEqual(["native"]);
  });

it("native retry exhaustion reaches configured DLQ after five retries", async () => {
  const attempts: number[] = [];
  vi.mocked(worker.queue).mockImplementation(async (batch, e) => {
    for (const message of batch.messages) {
      attempts.push(message.attempts);
      const retry = message.retry.bind(message);
      vi.spyOn(message, "retry").mockImplementation((options) => {
        expect(options).toEqual({ delaySeconds: 60 });
        retry({ delaySeconds: 0 });
      });
    }
    await consume(batch, e);
  });
  const poison = { operationId: "legacy-local-fixture" };
  await env.WORK_QUEUE.send(poison, { contentType: "json" });
  let dlq: unknown[] = [];
  await vi.waitFor(
    async () => {
      dlq.push(
        ...((await (
          await env.DLQ_CAPTURE.fetch("https://capture.invalid")
        ).json()) as unknown[]),
      );
      expect(dlq).toEqual([poison]);
    },
    { timeout: 10000, interval: 25 },
  );
  expect(attempts).toEqual([1, 2, 3, 4, 5, 6]);
});

it.runIf(integration)(
  "lease recovery fences lost claim, old ack/defer and restart at handoff boundaries",
  async () => {
    await control("seed");
    const b = new Bridge(supervised());
    const first = (await b.command(runtimePaths[0], { limit: 1 }, deadline()))
      .refs![0]!;
    await control("restart");
    await control("expire-delivery");
    await expect(
      b.command(runtimePaths[4], { limit: 20 }, deadline()),
    ).resolves.toMatchObject({ disposition: "OK" });
    const next = (await b.command(runtimePaths[0], { limit: 1 }, deadline()))
      .refs![0]!;
    expect(next.generation).toBe(first.generation + 1);
    expect(
      (await b.command(runtimePaths[1], first, deadline())).disposition,
    ).toBe("STALE");
    expect(
      (
        await b.command(
          runtimePaths[2],
          { ...first, retrySeconds: 60 },
          deadline(),
        )
      ).disposition,
    ).toBe("STALE");
    await control("restart");
    await b.command(runtimePaths[1], next, deadline());
    await control("restart");
    expect(
      (
        await consumeOne({
          version: 1,
          workId: next.workId,
          generation: next.generation,
        })
      ).explicitAcks,
    ).toEqual(["native"]);
    expect((await control("state")).pages).toBe(1);
  },
);
it.runIf(integration)(
  "real persisted lost dispatch and ack replay without duplicate claims/sends",
  async () => {
    await control("seed");
    const wire = fetch;
    const lost = new Set<string>();
    let sends = 0;
    const e = supervised();
    const originalSend = e.WORK_QUEUE.send.bind(e.WORK_QUEUE);
    e.WORK_QUEUE = {
      ...e.WORK_QUEUE,
      send: async (body, options) => {
        sends++;
        return originalSend(body, options);
      },
    };
    await publish(e, deadline(), async (request) => {
      const response = await wire(request);
      const path = new URL(request.url).pathname;
      if (!lost.has(path)) {
        lost.add(path);
        await response.body?.cancel();
        throw Error("injected response loss");
      }
      return response;
    });
    expect(sends).toBe(1);
    const state = await control("state");
    expect(state.work[0]!.generation).toBe(1);
    expect(state.work[0]!.disposition).toBe("DELIVERED");
  },
);
it.runIf(integration)(
  "duplicate concurrent native consumers preserve exactly one page commit",
  async () => {
    await control("seed");
    const b = new Bridge(supervised());
    const ref = (await b.command(runtimePaths[0], { limit: 1 }, deadline()))
      .refs![0]!;
    await b.command(runtimePaths[1], ref, deadline());
    const body = {
      version: 1 as const,
      workId: ref.workId,
      generation: ref.generation,
    };
    const results = await Promise.all([consumeOne(body), consumeOne(body)]);
    for (const result of results)
      expect(result.explicitAcks.length + result.retryMessages.length).toBe(1);
    const state = await control("state");
    expect(state.pages).toBe(1);
    expect(state.hops).toBe(2);
    expect(state.work[0]!.generation).toBe(ref.generation + 1);
  },
);
it.runIf(integration)(
  "same semantic envelope can re-sign under rotated key but revoked original cannot replay",
  async () => {
    await control("seed");
    const b = new Bridge(supervised());
    const envelope = await signEnvelope(
      b.config,
      runtimePaths[0],
      '{"limit":1}',
    );
    const first = await b.send(envelope, deadline());
    await control("rotate");
    expect(
      await b.send(envelope, deadline()).then(
        () => false,
        (error) => error instanceof Error && error.message === "AUTHENTICATION",
      ),
    ).toBe(true);
    const rotated = new Bridge(replacement());
    const rekeyed = await signEnvelope(
      rotated.config,
      envelope.path,
      envelope.body,
      Number(envelope.headers.get("x-lyra-issued-at")),
      envelope.headers.get("x-lyra-request-id")!,
    );
    expect(
      JSON.stringify(await rotated.send(rekeyed, deadline())) ===
        JSON.stringify(first),
    ).toBe(true);
  },
);

it.runIf(integration)(
  "round1 production exports scheduled to native Queue to original queue to persisted B journey",
  async () => {
    await control("seed");
    const native: QueueRef[] = [];
    vi.mocked(worker.queue).mockImplementation(async (batch) => {
      for (const message of batch.messages) {
        native.push(message.body as QueueRef);
        const retry = message.retry.bind(message);
        vi.spyOn(message, "retry").mockImplementation((options) => {
          expect(options).toEqual({ delaySeconds: 60 });
          retry({ delaySeconds: 1 });
        });
      }
      await originalQueue(batch, supervised());
    });
    const tick = async (minute: number) => {
      const ctx = createExecutionContext();
      worker.scheduled(
        createScheduledController({
          cron: "* * * * *",
          scheduledTime: new Date(Date.UTC(2026, 10, 3, 10, minute)),
        }),
        supervised(),
        ctx,
      );
      await waitOnExecutionContext(ctx);
    };
    await tick(6);
    await vi.waitFor(
      async () => {
        const state = await control("state");
        expect(state.pages).toBe(1);
        expect(state.work[0]!.generation).toBe(2);
        expect(state.audits[0]!.status).toBe("QUEUED");
      },
      { timeout: 6000 },
    );
    await tick(7);
    await vi.waitFor(
      async () => {
        const state = await control("state");
        expect(state.pages).toBe(2);
        expect(state.audits[0]!.status).toBe("COMPLETED");
      },
      { timeout: 6000 },
    );
    expect(new Set(native.map((message) => message.generation))).toEqual(
      new Set([1, 2]),
    );
    for (const message of native)
      expect(Object.keys(message).sort()).toEqual([
        "generation",
        "version",
        "workId",
      ]);
  },
);
it.runIf(integration)(
  "round1 independent secret rotation rejects old ID and old bytes under replacement ID",
  async () => {
    await control("seed");
    expect(env.TEST_BRIDGE_SECRET === env.TEST_ROTATED_BRIDGE_SECRET).toBe(
      false,
    );
    const original = new Bridge(supervised());
    const first = await signEnvelope(
      original.config,
      runtimePaths[0],
      '{"limit":1}',
    );
    const persisted = await original.send(first, deadline());
    await control("rotate");
    expect(
      await original.send(first, deadline()).then(
        () => false,
        (error) => error instanceof Error && error.message === "AUTHENTICATION",
      ),
    ).toBe(true);
    const wrong = new Bridge({ ...supervised(), BRIDGE_KEY_ID: "replacement" });
    const resign = async (bridge: Bridge) =>
      signEnvelope(
        bridge.config,
        first.path,
        first.body,
        Number(first.headers.get("x-lyra-issued-at")),
        first.headers.get("x-lyra-request-id")!,
      );
    const oldBytesRejected = await wrong
      .send(await resign(wrong), deadline())
      .then(
        () => false,
        (error) => error instanceof Error && error.message === "AUTHENTICATION",
      );
    expect(oldBytesRejected).toBe(true);
    const rotated = new Bridge(replacement());
    expect(
      JSON.stringify(await rotated.send(await resign(rotated), deadline())) ===
        JSON.stringify(persisted),
    ).toBe(true);
  },
);
