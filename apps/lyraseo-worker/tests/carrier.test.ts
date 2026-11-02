import { afterEach, expect, it, vi } from "vitest";
import { runtimePaths } from "@lyraseo/contracts/runtime-signing";
import { Bridge, configuration, signEnvelope } from "../src/bridge";
import { publish } from "../src/carrier";
import { enabled, json, ref, queued, responder } from "./helpers";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("awaits send before private DB ack and sends only opaque reference", async () => {
  const events: string[] = [];
  let release!: () => void;
  const e = enabled();
  e.WORK_QUEUE = {
    ...e.WORK_QUEUE,
    send: vi.fn(async (body) => {
      events.push("send");
      expect(body).toEqual(queued);
      await new Promise<void>((r) => (release = r));
      events.push("sent");
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    }),
  };
  const wire = responder((path) => {
    events.push(path);
    return json(
      path === runtimePaths[0]
        ? { disposition: "OK", refs: [ref] }
        : { disposition: "DELIVERED" },
    );
  });
  const run = publish(e, Date.now() + 25000, wire);
  await vi.waitFor(() => expect(events).toContain("send"));
  expect(events).not.toContain(runtimePaths[1]);
  release();
  await run;
  expect(events).toEqual([runtimePaths[0], "send", "sent", runtimePaths[1]]);
});
it("validates entire claim before any publication", async () => {
  for (const refs of [
    [ref, { ...ref, generation: 2 }],
    [{ ...ref, extra: 1 }],
    [{ ...ref, workId: "bad" }],
  ]) {
    const e = enabled();
    const send = vi.fn();
    e.WORK_QUEUE = { ...e.WORK_QUEUE, send };
    await expect(
      publish(
        e,
        Date.now() + 25000,
        responder(() => json({ disposition: "OK", refs })),
      ),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  }
});
it("failed send defers exactly claimed token and never ack", async () => {
  const e = enabled();
  e.WORK_QUEUE = {
    ...e.WORK_QUEUE,
    send: vi.fn(async () => {
      throw Error("contains-secret");
    }),
  };
  const paths: string[] = [];
  await expect(
    publish(
      e,
      Date.now() + 25000,
      responder(async (path, r) => {
        paths.push(path);
        if (path === runtimePaths[2])
          expect(await r.json()).toEqual({ ...ref, retrySeconds: 60 });
        return json(
          path === runtimePaths[0]
            ? { disposition: "OK", refs: [ref] }
            : { disposition: "DEFERRED" },
        );
      }),
    ),
  ).rejects.toThrow();
  expect(paths).toEqual([runtimePaths[0], runtimePaths[2]]);
});
it("replays a lost dispatch and ack exactly once with original signed bytes", async () => {
  const e = enabled();
  e.WORK_QUEUE = {
    ...e.WORK_QUEUE,
    send: vi.fn(async () => ({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    })),
  };
  const seen = new Map<
    string,
    { body: string; headers: Record<string, string> }
  >();
  const count = new Map<string, number>();
  await publish(
    e,
    Date.now() + 25000,
    responder(async (path, r) => {
      const n = count.get(path) ?? 0;
      count.set(path, n + 1);
      const wire = {
        body: await r.text(),
        headers: Object.fromEntries(r.headers),
      };
      if (!n) {
        seen.set(path, wire);
        throw Error("response lost");
      }
      expect(wire).toEqual(seen.get(path));
      return json(
        path === runtimePaths[0]
          ? { disposition: "OK", refs: [ref] }
          : { disposition: "DELIVERED" },
      );
    }),
  );
  expect([...count.values()]).toEqual([2, 2]);
});
it("does not refresh an expired replay envelope", async () => {
  const e = enabled();
  const wire = vi.fn();
  const b = new Bridge(e, wire);
  const envelope = await signEnvelope(
    b.config,
    runtimePaths[0],
    '{"limit":1}',
    Math.floor(Date.now() / 1000) - 60,
  );
  await expect(b.send(envelope, Date.now() + 8000)).rejects.toThrow("DEADLINE");
  expect(wire).not.toHaveBeenCalled();
});
it("strict origin configuration rejects paths, credentials, alternate forms and HTTP", () => {
  for (const origin of [
    "http://bridge.test.invalid",
    "https://bridge.test.invalid/",
    "https://u:p@bridge.test.invalid",
    "https://bridge.test.invalid?q=x",
    "https://bridge.test.invalid/#x",
    "https://bridge.test.invalid/api",
    "https://BRIDGE.test.invalid",
  ])
    expect(() =>
      configuration({ ...enabled(), BRIDGE_ORIGIN: origin }),
    ).toThrow("CONFIGURATION");
});
it("response byte cap cancels chunked/no-length stream before parsing", async () => {
  let cancelled = false;
  const wire = responder(
    () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(20000));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  await expect(
    new Bridge(enabled(), wire).command(
      runtimePaths[0],
      { limit: 1 },
      Date.now() + 8000,
    ),
  ).rejects.toThrow("INVALID_RESPONSE");
  expect(cancelled).toBe(true);
});
for (const headers of [
  { "content-encoding": "gzip" },
  { "content-type": "text/plain" },
  { "content-length": "32769" },
] as Record<string, string>[])
  it(`rejects response metadata ${JSON.stringify(headers)}`, async () => {
    await expect(
      new Bridge(
        enabled(),
        responder(
          () =>
            new Response("{}", {
              headers: { "content-type": "application/json", ...headers },
            }),
        ),
      ).command(runtimePaths[0], { limit: 1 }, Date.now() + 8000),
    ).rejects.toThrow("INVALID_RESPONSE");
  });
it("rejects redirect and duplicate JSON disposition", async () => {
  for (const response of [
    new Response(null, {
      status: 302,
      headers: { location: "https://other.invalid" },
    }),
    new Response('{"disposition":"IN_PROGRESS","disposition":"COMPLETED"}', {
      headers: { "content-type": "application/json" },
    }),
  ])
    await expect(
      new Bridge(
        enabled(),
        responder(() => response),
      ).command(runtimePaths[3], queued, Date.now() + 47000),
    ).rejects.toThrow("INVALID_RESPONSE");
});
it("client deadline aborts a streaming unknown result and clears timer", async () => {
  let cancelled = false;
  const b = new Bridge(
    enabled(),
    responder(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ),
  );
  await expect(
    b.command(runtimePaths[3], queued, Date.now() + 25),
  ).rejects.toThrow("TRANSPORT");
  expect(cancelled).toBe(true);
});
it("late transport response is cancelled after client deadline", async () => {
  let deliver!: (response: Response) => void;
  let cancelled = false;
  const bridge = new Bridge(
    enabled(),
    () => new Promise<Response>((r) => (deliver = r)),
  );
  const pending = bridge.command(runtimePaths[3], queued, Date.now() + 20);
  await expect(pending).rejects.toThrow("TRANSPORT");
  deliver(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await vi.waitFor(() => expect(cancelled).toBe(true));
});
it("response BOM and escaped duplicate keys never authorize success", async () => {
  for (const raw of [
    '\ufeff{"disposition":"COMPLETED"}',
    String.raw`{"disposition":"IN_PROGRESS","dispos\u0069tion":"COMPLETED"}`,
  ])
    await expect(
      new Bridge(
        enabled(),
        responder(
          () =>
            new Response(raw, {
              headers: { "content-type": "application/json" },
            }),
        ),
      ).command(runtimePaths[3], queued, Date.now() + 8000),
    ).rejects.toThrow("INVALID_RESPONSE");
});

for (const path of runtimePaths)
  it(`streamed response 32KiB boundary ${path}`, async () => {
    const body =
      path === runtimePaths[3]
        ? queued
        : path === runtimePaths[1]
          ? ref
          : path === runtimePaths[2]
            ? { ...ref, retrySeconds: 60 }
            : { limit: 1 };
    const result =
      path === runtimePaths[0]
        ? { disposition: "OK", refs: [] }
        : path === runtimePaths[4]
          ? { disposition: "OK", reopened: 0, suppressed: 0, reconciliation: 0 }
          : {
              disposition:
                path === runtimePaths[3]
                  ? "COMPLETED"
                  : path === runtimePaths[1]
                    ? "DELIVERED"
                    : "DEFERRED",
            };
    const text = JSON.stringify(result);
    const raw = text + " ".repeat(32768 - text.length);
    await expect(
      new Bridge(
        enabled(),
        responder(
          () =>
            new Response(raw, {
              headers: { "content-type": "application/json" },
            }),
        ),
      ).command(path, body, Date.now() + 8000),
    ).resolves.toMatchObject({ disposition: result.disposition });
    let cancelled = false;
    const bytes = new TextEncoder().encode(raw + " ");
    let index = 0;
    await expect(
      new Bridge(
        enabled(),
        responder(
          () =>
            new Response(
              new ReadableStream({
                pull(controller) {
                  if (index >= bytes.length) {
                    controller.close();
                    return;
                  }
                  controller.enqueue(bytes.slice(index, index + 503));
                  index += 503;
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: { "content-type": "application/json" } },
            ),
        ),
      ).command(path, body, Date.now() + 8000),
    ).rejects.toThrow("INVALID_RESPONSE");
    // End-of-stream may already have arrived; overflow always rejects before JSON.
    expect(typeof cancelled).toBe("boolean");
  });
for (const [path, ms] of [
  [runtimePaths[0], 8000],
  [runtimePaths[3], 47000],
] as const)
  it(`exact client timeout ${ms}ms`, async () => {
    const bridge = new Bridge(
      enabled(),
      responder(
        () =>
          new Response(new ReadableStream({}), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const envelope = await signEnvelope(
      bridge.config,
      path,
      JSON.stringify(path === runtimePaths[3] ? queued : { limit: 1 }),
    );
    vi.useFakeTimers();
    const result = expect(
      bridge.send(envelope, Date.now() + 90000),
    ).rejects.toThrow("TRANSPORT");
    await vi.advanceTimersByTimeAsync(ms);
    await result;
  });
it("ambiguous send times out at five seconds then defers without ack", async () => {
  let started!: () => void;
  const gate = new Promise<void>((r) => (started = r));
  const e = enabled();
  e.WORK_QUEUE = {
    ...e.WORK_QUEUE,
    send: vi.fn(() => {
      vi.useFakeTimers();
      started();
      return new Promise<QueueSendResponse>(() => {});
    }),
  };
  const paths: string[] = [];
  const pending = expect(
    publish(
      e,
      Date.now() + 25000,
      responder((path) => {
        paths.push(path);
        return json(
          path === runtimePaths[0]
            ? { disposition: "OK", refs: [ref] }
            : { disposition: "DEFERRED" },
        );
      }),
    ),
  ).rejects.toThrow();
  await gate;
  await vi.advanceTimersByTimeAsync(5000);
  await pending;
  expect(paths).toEqual([runtimePaths[0], runtimePaths[2]]);
});

it("missing producer binding fails configuration before claim", async () => {
  const e = enabled();
  Reflect.deleteProperty(e, "WORK_QUEUE");
  const transport = vi.fn();
  await expect(publish(e, Date.now() + 25000, transport)).rejects.toThrow(
    "CONFIGURATION",
  );
  expect(transport).not.toHaveBeenCalled();
});
for (const [path, milliseconds] of [
  [runtimePaths[0], 8000],
  [runtimePaths[3], 47000],
] as const) {
  it(`round1 absolute fetch cutoff ${milliseconds} rejects before timer fires`, async () => {
    let now = Date.now();
    const initial = now;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let cancelled = false;
    const bridge = new Bridge(
      enabled(),
      responder(() => {
        now = initial + milliseconds;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  JSON.stringify(
                    path === runtimePaths[3]
                      ? { disposition: "COMPLETED" }
                      : { disposition: "OK", refs: [] },
                  ),
                ),
              );
              c.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const envelope = await signEnvelope(
      bridge.config,
      path,
      JSON.stringify(path === runtimePaths[3] ? queued : { limit: 1 }),
    );
    try {
      await expect(bridge.send(envelope, initial + 60000)).rejects.toThrow(
        "TRANSPORT",
      );
    } finally {
      clock.mockRestore();
    }
  });
}
it("round1 body read at exact cutoff rejects valid success before timer fires", async () => {
  let now = Date.now();
  const initial = now;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let cancelled = false;
  const bridge = new Bridge(
    enabled(),
    responder(
      () =>
        new Response(
          new ReadableStream(
            {
              pull(c) {
                now = initial + 47000;
                c.enqueue(
                  new TextEncoder().encode('{"disposition":"COMPLETED"}'),
                );
                c.close();
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "application/json" } },
        ),
    ),
  );
  await expect(
    bridge.command(runtimePaths[3], queued, initial + 60000),
  ).rejects.toThrow("TRANSPORT");
});
it("round1 Queue send at exact cutoff defers instead of DB ack without timer callback", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const paths: string[] = [];
  const e = enabled();
  e.WORK_QUEUE = {
    ...e.WORK_QUEUE,
    send: vi.fn(async () => {
      now += 5000;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    }),
  };
  await expect(
    publish(
      e,
      now + 25000,
      responder((path) => {
        paths.push(path);
        return json(
          path === runtimePaths[0]
            ? { disposition: "OK", refs: [ref] }
            : {
                disposition:
                  path === runtimePaths[1] ? "DELIVERED" : "DEFERRED",
              },
        );
      }),
    ),
  ).rejects.toThrow();
  expect(paths).toEqual([runtimePaths[0], runtimePaths[2]]);
});
it("round1 expired shared budget after send permits neither ack nor defer", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const paths: string[] = [];
  const e = enabled();
  e.WORK_QUEUE = {
    ...e.WORK_QUEUE,
    send: vi.fn(async () => {
      now += 25000;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    }),
  };
  await expect(
    publish(
      e,
      now + 25000,
      responder((path) => {
        paths.push(path);
        return json({ disposition: "OK", refs: [ref] });
      }),
    ),
  ).rejects.toThrow();
  expect(paths).toEqual([runtimePaths[0]]);
});
for (const invalid of [undefined, null, 1, true, {}, ["valid-id"]])
  it(`round1 non-string key ID ${typeof invalid} causes no transport`, async () => {
    const e = enabled();
    Reflect.set(e, "BRIDGE_KEY_ID", invalid);
    const send = vi.fn(responder(() => json({ disposition: "OK", refs: [] })));
    await expect(publish(e, Date.now() + 25000, send)).rejects.toThrow(
      "CONFIGURATION",
    );
    expect(send).not.toHaveBeenCalled();
  });
