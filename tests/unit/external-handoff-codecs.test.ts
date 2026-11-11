import { describe, expect, it } from "vitest";
import {
  outboundUrl,
  wordpressRequest,
  wordpressReceipt,
  webhookEnvelope,
  signWebhook,
  verifyWebhook,
  webhookOutcome,
} from "../../packages/db/src/handoff-codecs";

describe("private external handoff contracts", () => {
  it("rejects destination secrets, fragments, local IPs and alternate WordPress origins", () => {
    for (const url of [
      "http://example.com",
      "https://user:pw@example.com",
      "https://example.com:444",
      "https://127.0.0.1",
      "https://[::1]",
      "https://example.com/a#x",
      "https://example.com/a?token=x",
    ])
      expect(() => outboundUrl(url)).toThrow();
    expect(() =>
      wordpressRequest("https://other.com/blog/", "https://example.com", {
        title: "A",
        body: "B",
      }),
    ).toThrow();
  });
  it("creates only an escaped literal draft with a fixed endpoint", () => {
    const value = wordpressRequest(
      "https://example.com/blog/",
      "https://example.com",
      { title: "Title", body: "<script>alert(1)</script>\n\nHello & world" },
    );
    expect(value.url).toBe(
      "https://example.com/blog/wp-json/wp/v2/posts?_fields=id,status,link",
    );
    expect(JSON.parse(value.body)).toEqual({
      title: "Title",
      content:
        "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p>Hello &amp; world</p>",
      status: "draft",
    });
    expect(
      wordpressReceipt(
        201,
        '{"id":42,"status":"draft","link":"https://evil.com"}',
        value.url,
      ),
    ).toEqual({
      state: "CONFIRMED_DRAFT",
      remotePostId: 42,
      editorUrl:
        "https://example.com/blog/wp-admin/post.php?post=42&action=edit",
    });
    for (const body of [
      '{"id":42,"status":"publish"}',
      '{"id":0,"status":"draft"}',
      "bad json",
    ])
      expect(wordpressReceipt(201, body, value.url).state).toBe("UNRESOLVED");
    expect(wordpressReceipt(500, "", value.url).state).toBe("UNRESOLVED");
    expect(wordpressReceipt(401, "", value.url).state).toBe("REJECTED");
  });
  it("signs exact bytes and checks strict symmetric freshness before parsing", () => {
    const body = webhookEnvelope({
      id: "evt-1",
      type: "test",
      workspaceId: "a",
      siteId: "s",
      resource: { kind: "test", id: "sample" },
      occurredAt: "2026-11-03T00:00:00.000Z",
    });
    const key = Buffer.alloc(32, 7).toString("base64url"),
      timestamp = 1793664000;
    const headers = signWebhook(body, key, "key-1", timestamp);
    expect(verifyWebhook(body, headers, { "key-1": key }, timestamp).id).toBe(
      "evt-1",
    );
    expect(() =>
      verifyWebhook(body + " ", headers, { "key-1": key }, timestamp),
    ).toThrow();
    expect(() =>
      verifyWebhook(body, headers, { "key-1": key }, timestamp + 301),
    ).toThrow();
    expect(() =>
      verifyWebhook(body, headers, { "key-1": key }, timestamp - 301),
    ).toThrow();
    expect(() =>
      verifyWebhook(
        body,
        {
          ...headers,
          "X-Lyraseo-Signature": headers["X-Lyraseo-Signature"] + ",v1=aa",
        },
        { "key-1": key },
        timestamp,
      ),
    ).toThrow();
  });
  it("bounds retries to the approved schedule and never follows redirects", () => {
    const now = new Date("2026-11-03T00:00:00Z");
    for (const [index, seconds] of [60, 300, 1800, 7200, 43200].entries())
      expect(webhookOutcome(503, index + 1, now)).toEqual({
        state: "RETRY",
        nextDueAt: new Date(now.getTime() + seconds * 1000),
      });
    expect(webhookOutcome(undefined, 6, now)).toEqual({
      state: "FAILED",
      nextDueAt: null,
    });
    for (const status of [301, 400, 401, 404, 600, 0])
      expect(webhookOutcome(status, 1, now).state).toBe("FAILED");
    expect(webhookOutcome(429, 1, now).state).toBe("RETRY");
    expect(webhookOutcome(204, 1, now).state).toBe("DELIVERED");
  });
});
