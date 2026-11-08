import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const state = vi.hoisted(() => ({
  addresses: [{ address: "93.184.216.34", family: 4 }],
  options: null as Record<string, unknown> | null,
  url: "",
  requests: 0,
  status: 201,
  body: '{"id":1,"status":"draft"}',
}));
vi.mock("node:dns/promises", () => ({ lookup: async () => state.addresses }));
vi.mock("node:https", () => ({
  request: (
    url: URL,
    options: Record<string, unknown>,
    callback: (stream: unknown) => void,
  ) => {
    state.requests++;
    state.options = options;
    state.url = url.href;
    const req = new EventEmitter() as EventEmitter & {
      end: (body: string) => void;
    };
    req.end = () => {
      const response = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: Record<string, string>;
      };
      response.statusCode = state.status;
      response.headers = {};
      callback(response);
      queueMicrotask(() => response.end(state.body));
    };
    return req;
  },
}));
import {
  signedWebhookPost,
  wordpressDraftPost,
} from "../../apps/lyraseo-web/src/server/handoffs/transport";
import { webhookEnvelope } from "../../packages/db/src/handoff-codecs";
beforeEach(() => {
  state.addresses = [{ address: "93.184.216.34", family: 4 }];
  state.requests = 0;
  state.status = 201;
  state.body = '{"id":1,"status":"draft"}';
});
const input = {
  installation: "https://example.com/blog/",
  origin: "https://example.com",
  title: "A",
  body: "B",
  username: "dedicated",
  applicationPassword: "fixture",
};
describe("pinned private JSON egress", () => {
  it("resolves all addresses then rechecks authority before opening a credential socket", async () => {
    let checks = 0;
    await expect(
      wordpressDraftPost(input, async () => {
        if (++checks === 2) throw Error("REVOKED_AFTER_DNS");
      }),
    ).rejects.toThrow("REVOKED_AFTER_DNS");
    expect(state.requests).toBe(0);
    state.addresses.push({ address: "127.0.0.1", family: 4 });
    await expect(wordpressDraftPost(input, async () => {})).rejects.toThrow(
      "DESTINATION_BLOCKED",
    );
    expect(state.requests).toBe(0);
  });
  it("pins the address and keeps original hostname/TLS with fixed Basic headers and no redirect follow", async () => {
    state.status = 302;
    expect(await wordpressDraftPost(input, async () => {})).toEqual({
      status: 302,
      body: "",
    });
    expect(state.requests).toBe(1);
    expect(state.url).toBe(
      "https://example.com/blog/wp-json/wp/v2/posts?_fields=id,status,link",
    );
    expect(state.options!.agent).toBe(false);
    expect(state.options!.maxHeaderSize).toBe(16384);
    const lookup = state.options!.lookup as (
      h: string,
      o: unknown,
      c: (e: null, a: string, f: number) => void,
    ) => void;
    lookup("example.com", {}, (_err, address, family) => {
      expect(address).toBe("93.184.216.34");
      expect(family).toBe(4);
    });
    expect(
      (state.options!.headers as Record<string, string>).Authorization,
    ).toBe(`Basic ${Buffer.from("dedicated:fixture").toString("base64")}`);
  });
  it("caps streamed response bytes independent of Content-Length", async () => {
    state.body = "x".repeat(65537);
    await expect(wordpressDraftPost(input, async () => {})).rejects.toThrow(
      "RESPONSE_TOO_LARGE",
    );
  });
  it("signs only a bounded matching authenticated event and never permits destination query secrets", async () => {
    const body = webhookEnvelope({
      id: "event-1",
      type: "test",
      workspaceId: "w",
      siteId: "s",
      occurredAt: new Date().toISOString(),
      resource: { kind: "test", id: "sample" },
    });
    await signedWebhookPost(
      {
        url: "https://receiver.example.com/events",
        body,
        key: Buffer.alloc(32, 1).toString("base64url"),
        keyId: "v1",
        eventId: "event-1",
      },
      async () => {},
    );
    const headers = state.options!.headers as Record<string, string>;
    expect(headers["X-Lyraseo-Event-Id"]).toBe("event-1");
    expect(headers["X-Lyraseo-Signature"]).toMatch(/^v1=[a-f0-9]{64}$/);
    expect(headers.Authorization).toBeUndefined();
    await expect(
      signedWebhookPost(
        {
          url: "https://receiver.example.com/events?secret=foo",
          body,
          key: "",
          keyId: "x",
          eventId: "event-1",
        },
        async () => {},
      ),
    ).rejects.toThrow();
  });
});
it("caller cancellation bounds a stalled authorization barrier before DNS or any socket", async () => {
  const controller = new AbortController();
  const work = wordpressDraftPost(
    input,
    () => new Promise<void>(() => {}),
    controller.signal,
  );
  controller.abort();
  await expect(work).rejects.toThrow("HANDOFF_ABORTED");
  expect(state.requests).toBe(0);
});
