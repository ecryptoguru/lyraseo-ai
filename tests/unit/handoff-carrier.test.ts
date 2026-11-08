import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { startControlledRuntime } from "../../apps/lyraseo-web/src/server/runtime/listener";
import { createControlledFixture } from "../../apps/lyraseo-web/src/server/runtime/fixture";
import { createHandoffFixture } from "../../apps/lyraseo-web/src/server/runtime/handoff-fixture";
import { Bridge, signEnvelope } from "../../apps/lyraseo-worker/src/bridge";
import { consume } from "../../apps/lyraseo-worker/src/carrier";
import { runtimePaths } from "../../packages/contracts/src/runtime-signing";

const workId = "00000000-0000-4000-8000-000000000002";
const eventId = "00000000-0000-4000-8000-000000000003";
const secret = Buffer.alloc(32, 8).toString("base64url");
const signingSecret = randomBytes(32);
const key = {
  id: "fixture",
  principal: "lyraseo_dispatch",
  audience: "lyraseo-kernel-a",
  actions: runtimePaths,
  secret: signingSecret,
};
const env = {
  WORK_QUEUE: { send: async () => ({}) },
  CARRIER_QUALIFIED: "true",
  CARRIER_ENABLED: "true",
  BRIDGE_ORIGIN: "https://bridge.test.invalid",
  BRIDGE_KEY_ID: key.id,
  BRIDGE_SECRET: signingSecret.toString("base64url"),
  BRIDGE_PRINCIPAL: key.principal,
  BRIDGE_AUDIENCE: key.audience,
} as Env;
function binding(kind: "WORDPRESS" | "WEBHOOK") {
  const body =
    kind === "WEBHOOK"
      ? JSON.stringify({ id: eventId, workspaceId: "w", siteId: "s" })
      : JSON.stringify({
          title: "Test",
          content: "<p>Test</p>",
          status: "draft",
        });
  return {
    kind,
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    url:
      kind === "WEBHOOK"
        ? "https://example.com/hook"
        : "https://example.com/blog/wp-json/wp/v2/posts?_fields=id,status,link",
    connectionUrl:
      kind === "WEBHOOK"
        ? "https://example.com/hook"
        : "https://example.com/blog/",
    generation: 1,
    eventId: kind === "WEBHOOK" ? eventId : null,
    cipher: "cipher",
    keyId: kind === "WEBHOOK" ? "key" : null,
    previousCipher: null,
    previousKeyId: null,
    workspaceId: "w",
    siteId: "s",
  };
}
function database(initial: ReturnType<typeof binding>) {
  const state = {
    binding: initial,
    result: undefined as undefined | { disposition: string },
    receipts: [] as unknown[],
    revoked: false,
    checks: 0,
    audit: 0,
  };
  const db = {
    async $transaction(fn: (tx: unknown) => unknown) {
      return fn({
        async $queryRaw(parts: TemplateStringsArray, ...args: unknown[]) {
          const sql = parts.join("?");
          if (sql.includes("set_config")) return [];
          if (sql.includes("resolve_delivery")) return [{ found: true }];
          if (sql.includes("admit_step"))
            return [
              {
                result: state.result ?? {
                  disposition: "ADMITTED",
                  proof: "fixture-proof",
                  kind: state.binding.kind,
                },
              },
            ];
          if (sql.includes("check_step")) {
            state.checks++;
            if (state.revoked) throw Error("STALE_ATTEMPT");
            return [{ result: { ...state.binding } }];
          }
          if (sql.includes("finish_step")) {
            state.receipts.push(args.slice(2));
            state.result = { disposition: "COMPLETED" };
            return [{ result: state.result }];
          }
          state.audit++;
          throw Error("unexpected query");
        },
      });
    },
  };
  return { db: db as never, state };
}
async function harness(
  kind: "WORDPRESS" | "WEBHOOK",
  respond: Parameters<typeof createHandoffFixture>[2],
  afterResolve?: Parameters<typeof createHandoffFixture>[3],
) {
  const { db, state } = database(binding(kind));
  const fixture = createHandoffFixture(
    "https://example.com",
    () =>
      kind === "WEBHOOK"
        ? secret
        : JSON.stringify({
            username: "fixture",
            applicationPassword: "fixture",
          }),
    respond,
    afterResolve,
  );
  const keys = [key];
  const server = await startControlledRuntime({
    db,
    keys: () => keys,
    fixture: createControlledFixture(
      "https://example.com",
      async () => new Response(""),
    ),
    handoffFixture: fixture,
  });
  const wire = (request: Request) =>
    fetch(server.origin + new URL(request.url).pathname, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      duplex: "half",
    } as RequestInit);
  const bridge = new Bridge(env, wire);
  return { state, server, wire, bridge, keys };
}
it("runs the signed worker step and replays its exact completion without a second post", async () => {
  const post = vi.fn(async () => ({
    status: 201,
    body: '{"id":9,"status":"draft"}',
  }));
  const h = await harness("WORDPRESS", post);
  try {
    const envelope = await signEnvelope(
      h.bridge.config,
      runtimePaths[3],
      JSON.stringify({ version: 1, workId, generation: 1 }),
    );
    expect(
      (await h.bridge.send(envelope, Date.now() + 10000)).disposition,
    ).toBe("COMPLETED");
    expect(
      (await h.bridge.send(envelope, Date.now() + 10000)).disposition,
    ).toBe("COMPLETED");
    expect(post).toHaveBeenCalledTimes(1);
    expect(h.state.receipts[0]).toEqual([
      "CONFIRMED_DRAFT",
      201,
      "HTTP_RESPONSE",
      9,
      "https://example.com/blog/wp-admin/post.php?post=9&action=edit",
    ]);
    expect(h.state.audit).toBe(0);
  } finally {
    await h.server.close();
  }
});
it("records ambiguous WordPress failure once and never repeats on signed replay", async () => {
  const post = vi.fn(async () => {
    throw Error("private provider response");
  });
  const h = await harness("WORDPRESS", post);
  try {
    const e = await signEnvelope(
      h.bridge.config,
      runtimePaths[3],
      JSON.stringify({ version: 1, workId, generation: 1 }),
    );
    await h.bridge.send(e, Date.now() + 10000);
    await h.bridge.send(e, Date.now() + 10000);
    expect(post).toHaveBeenCalledTimes(1);
    expect(h.state.receipts[0]).toEqual([
      "UNRESOLVED",
      null,
      "TRANSPORT_UNKNOWN",
      null,
      null,
    ]);
  } finally {
    await h.server.close();
  }
});
it.each([
  "cipher",
  "keyId",
  "generation",
  "body",
  "bodyHash",
  "eventId",
  "workspaceId",
  "siteId",
  "url",
  "connectionUrl",
] as const)(
  "rejects changed %s after resolution before opening",
  async (field) => {
    let change = () => {};
    const post = vi.fn(async () => ({ status: 204, body: "" }));
    const h = await harness("WEBHOOK", post, async () => change());
    change = () => {
      Object.assign(h.state.binding, {
        [field]: field === "generation" ? 2 : "changed",
      });
    };
    try {
      await expect(
        h.bridge.command(
          runtimePaths[3],
          { version: 1, workId, generation: 1 },
          Date.now() + 10000,
        ),
      ).rejects.toThrow();
      expect(post).not.toHaveBeenCalled();
      expect(h.state.receipts).toHaveLength(0);
    } finally {
      await h.server.close();
    }
  },
);
it("aborts a running request when proof is revoked", async () => {
  let seen!: () => void;
  const started = new Promise<void>((r) => {
    seen = r;
  });
  let aborted = false;
  const h = await harness("WEBHOOK", async (_url, _body, _headers, signal) => {
    seen();
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    return { status: 204, body: "" };
  });
  try {
    const run = h.bridge.command(
      runtimePaths[3],
      { version: 1, workId, generation: 1 },
      Date.now() + 10000,
    );
    await started;
    h.state.revoked = true;
    await expect(run).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(h.state.receipts).toHaveLength(0);
  } finally {
    await h.server.close();
  }
});
it("aborts an in-flight request when its signer is revoked", async () => {
  let started!: () => void;
  const opened = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const h = await harness("WEBHOOK", async (_url, _body, _headers, signal) => {
    started();
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    return { status: 204, body: "" };
  });
  try {
    const run = h.bridge.command(
      runtimePaths[3],
      { version: 1, workId, generation: 1 },
      Date.now() + 10000,
    );
    await opened;
    h.keys.length = 0;
    await expect(run).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(h.state.receipts).toHaveLength(0);
  } finally {
    await h.server.close();
  }
});
it("does not settle after the signed caller cancels during provider I/O", async () => {
  let opened!: () => void, stopped!: () => void;
  const started = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const h = await harness("WEBHOOK", async (_url, _body, _headers, signal) => {
    opened();
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          stopped();
          resolve();
        },
        { once: true },
      ),
    );
    return { status: 204, body: "" };
  });
  try {
    const envelope = await signEnvelope(
      h.bridge.config,
      runtimePaths[3],
      JSON.stringify({ version: 1, workId, generation: 1 }),
    );
    const cancellation = new AbortController();
    const request = new Request(h.bridge.config.origin + envelope.path, {
      method: "POST",
      headers: envelope.headers,
      body: envelope.body,
      signal: cancellation.signal,
    });
    const run = h.wire(request);
    await started;
    cancellation.abort();
    await expect(run).rejects.toThrow();
    await aborted;
    expect(h.state.receipts).toHaveLength(0);
  } finally {
    await h.server.close();
  }
});
it("passes webhook retry through the actual queue consumer with a stable event ID", async () => {
  const posts: Array<{ body: string; id: string }> = [];
  const h = await harness("WEBHOOK", async (_url, body, headers) => {
    posts.push({ body, id: headers["X-Lyraseo-Event-Id"]! });
    return { status: 503, body: "" };
  });
  const ack = vi.fn(),
    retry = vi.fn();
  try {
    await consume(
      {
        messages: [
          {
            body: { version: 1, workId, generation: 1 },
            attempts: 1,
            ack,
            retry,
          },
        ],
      } as never,
      env,
      h.wire,
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(posts[0]?.id).toBe(eventId);
    expect(JSON.parse(posts[0]!.body).id).toBe(eventId);
    expect(h.state.receipts[0]).toEqual([
      "RETRY",
      503,
      "HTTP_RESPONSE",
      null,
      null,
    ]);
  } finally {
    await h.server.close();
  }
});

it("sends the frozen fixture event to an injected loopback server", async () => {
  const received: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const h = await harness("WEBHOOK", async (_url, body, headers, signal) => {
    const response = await fetch(`http://127.0.0.1:${port}/fixture`, {
      method: "POST",
      body,
      headers,
      signal,
    });
    return { status: response.status, body: await response.text() };
  });
  try {
    expect(
      (
        await h.bridge.command(
          runtimePaths[3],
          { version: 1, workId, generation: 1 },
          Date.now() + 10000,
        )
      ).disposition,
    ).toBe("COMPLETED");
    expect(received).toEqual([binding("WEBHOOK").body]);
  } finally {
    await h.server.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
