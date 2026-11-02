import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
import { resolvePublicAddress } from "../../apps/lyraseo-web/src/server/acquisition/transport";
beforeEach(() => {
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});
it.each([
  "127.0.0.1",
  "10.0.0.1",
  "169.254.169.254",
  "100.64.0.1",
  "192.168.0.1",
  "::1",
  "fe80::1",
  "fc00::1",
  "::ffff:127.0.0.1",
  "2001:db8::1",
])("rejects non-public resolution %s", async (address) => {
  mocks.lookup.mockResolvedValue([
    { address, family: address.includes(":") ? 6 : 4 },
  ]);
  await expect(
    resolvePublicAddress("example.com", AbortSignal.timeout(1000)),
  ).rejects.toThrow("DESTINATION_BLOCKED");
});
it("rejects mixed public/private DNS rather than selecting a public subset", async () => {
  mocks.lookup.mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
    { address: "::1", family: 6 },
  ]);
  await expect(
    resolvePublicAddress("example.com", AbortSignal.timeout(1000)),
  ).rejects.toThrow("DESTINATION_BLOCKED");
});
it("returns the single approved socket address", async () => {
  expect(
    await resolvePublicAddress("example.com", AbortSignal.timeout(1000)),
  ).toEqual({ address: "93.184.216.34", family: 4 });
});

const httpsMocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: httpsMocks.request }));
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { publicHttpsTransport } from "../../apps/lyraseo-web/src/server/acquisition/transport";
function respond(status: number, headers: Record<string, string> = {}) {
  const incoming = Object.assign(new PassThrough(), {
    statusCode: status,
    headers,
  });
  const req = Object.assign(new EventEmitter(), {
    end: () => {
      queueMicrotask(() => {
        httpsMocks.request.mock.calls.at(-1)![2](incoming);
        incoming.end();
      });
    },
  });
  httpsMocks.request.mockReturnValue(req);
  return incoming;
}
it.each([204, 205, 304])(
  "normalizes null-body status %s through the actual Node response callback",
  async (status) => {
    respond(status);
    const result = await publicHttpsTransport(
      "https://example.com/",
      AbortSignal.timeout(1000),
    );
    expect(result.status).toBe(status);
    expect(result.body).toBeNull();
  },
);
it.each([0, 101, 600])(
  "rejects invalid upstream status %s inside the callback promise",
  async (status) => {
    respond(status);
    await expect(
      publicHttpsTransport("https://example.com/", AbortSignal.timeout(1000)),
    ).rejects.toThrow("INVALID_UPSTREAM_STATUS");
  },
);
it("contains response header construction failures inside the promise", async () => {
  respond(200, { "invalid header": "value" });
  await expect(
    publicHttpsTransport("https://example.com/", AbortSignal.timeout(1000)),
  ).rejects.toThrow();
});

it.each([200, 204, 205])(
  "keeps an empty HTML %s unavailable after the Node callback and acquisition",
  async (status) => {
    const { acquireRawPage } =
      await import("../../packages/visibility/src/acquisition");
    const { evaluateAudit } = await import("../../packages/visibility/src");
    respond(status, { "content-type": "text/html" });
    const origin = "https://example.com/";
    const receipt = await acquireRawPage(origin, origin, (url, signal) =>
      url.endsWith("robots.txt")
        ? Promise.resolve(new Response(null, { status: 404 }))
        : publicHttpsTransport(url, signal),
    );
    expect(receipt.provenance.status).toBe(status);
    expect(receipt.provenance.error).toBe("EMPTY_HTML_BODY");
    expect(receipt.evidence.acquired).toBe(false);
    const result = evaluateAudit({
      siteOrigin: origin,
      manifest: [origin],
      pages: [receipt.evidence],
      methodologyVersion: "readiness-v1",
    });
    expect(result.rules.find((r) => r.ruleId === "D01")?.outcome).toBe(
      "UNKNOWN",
    );
  },
);
it("checks authority after DNS resolution and before opening the pinned TLS socket", async () => {
  const signal = AbortSignal.timeout(1000);
  httpsMocks.request.mockClear();
  let resolved = false;
  mocks.lookup.mockImplementation(async () => {
    resolved = true;
    return [{ address: "93.184.216.34", family: 4 }];
  });
  await expect(
    publicHttpsTransport("https://example.com/", signal, async () => {
      expect(resolved).toBe(true);
      throw new Error("REVOKED");
    }),
  ).rejects.toThrow("REVOKED");
  expect(httpsMocks.request).not.toHaveBeenCalled();
});
it("keeps the TLS and Host URL intact and pins the first public lookup even if DNS changes", async () => {
  mocks.lookup
    .mockReset()
    .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
    .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
  respond(204);
  const gate = vi.fn(async () => {
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  await publicHttpsTransport(
    "https://example.com/page",
    AbortSignal.timeout(1000),
    gate,
  );
  const [target, options] = httpsMocks.request.mock.calls.at(-1)!;
  expect(target.href).toBe("https://example.com/page");
  expect(options.servername).toBeUndefined();
  expect(options.rejectUnauthorized).not.toBe(false);
  expect(options.headers.host).toBeUndefined();
  const resolved = vi.fn();
  options.lookup("example.com", {}, resolved);
  expect(resolved).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
  expect(gate).toHaveBeenCalledOnce();
});
