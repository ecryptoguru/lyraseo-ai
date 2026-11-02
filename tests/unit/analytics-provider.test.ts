import { expect, it, vi } from "vitest";
import {
  analyticsProvider,
  ANALYTICS_SCOPE,
} from "../../apps/lyraseo-web/src/server/google/analytics";
import {
  GOOGLE_SCOPE,
  secretBox,
} from "../../apps/lyraseo-web/src/server/google/provider";
import { joinGa4Outcomes, normalizeGa4Rows } from "../../packages/db/src/ga4";
const config = {
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "https://app.example/api/integrations/analytics/callback",
};
import { fixtureTransport } from "../fixtures/analytics";
it("requests separate analytics readonly purpose with PKCE and refuses GSC-only tokens", async () => {
  const transport = fixtureTransport(),
    p = analyticsProvider(config, transport),
    u = new URL(p.authorize("state", "verifier"));
  expect(u.searchParams.get("scope")).toBe(ANALYTICS_SCOPE);
  expect(u.searchParams.get("scope")).not.toContain(GOOGLE_SCOPE);
  expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  expect(await p.exchange("code", "verifier")).toBe("analytics-refresh");
  const bad = analyticsProvider(config, async () =>
    Response.json({
      access_token: "a",
      refresh_token: "r",
      scope: GOOGLE_SCOPE,
    }),
  );
  await expect(bad.exchange("c", "v")).rejects.toThrow(
    "ANALYTICS_RECONNECT_REQUIRED",
  );
  const box = secretBox(Buffer.alloc(32, 7).toString("base64"));
  expect(() =>
    box.open(box.seal("r", "analytics.readonly:a:s"), "a:s"),
  ).toThrow();
});
it("discovers primary-shaped account summaries and web streams with authoritative timezone", async () => {
  const p = analyticsProvider(config, fixtureTransport());
  expect(await p.properties("refresh")).toEqual([
    {
      property: "properties/123",
      displayName: "Property",
      timeZone: "America/Los_Angeles",
      streams: [
        {
          streamId: "456",
          displayName: "Web",
          defaultUri: "https://example.com",
        },
      ],
    },
  ]);
});
it("qualifies exact metadata and compatibility before bounded filtered report; retains diagnostics", async () => {
  const transport = fixtureTransport(),
    p = analyticsProvider(config, transport),
    r = await p.report("refresh", "properties/123", {
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      streamId: "456",
      hostName: "example.com",
    });
  expect(r).toMatchObject({
    rowCount: 1,
    timeZone: "America/Los_Angeles",
    diagnostics: {
      partial: true,
      restricted: true,
      sampled: true,
      thresholded: true,
      otherLoss: true,
      keyEventsConfigured: true,
    },
  });
  expect(r.rows[0]).toMatchObject({
    date: "2026-01-01",
    rawLandingPage: "/products?plan=pro",
    sessions: 12,
    sessionKeyEventRate: 0.333333,
  });
  const calls = transport.mock.calls;
  const index = calls.findIndex((x) => String(x[0]).endsWith(":runReport"));
  expect(
    calls.findIndex((x) => String(x[0]).endsWith(":checkCompatibility")),
  ).toBeLessThan(index);
  const body = JSON.parse(String(calls[index]![1]?.body));
  expect(body).toMatchObject({
    limit: "10000",
    offset: "0",
    dimensionFilter: {
      andGroup: {
        expressions: [
          { filter: { fieldName: "streamId", stringFilter: { value: "456" } } },
          {
            filter: {
              fieldName: "hostName",
              stringFilter: { value: "example.com" },
            },
          },
          {
            filter: {
              fieldName: "sessionDefaultChannelGroup",
              stringFilter: { value: "Organic Search" },
            },
          },
        ],
      },
    },
  });
});
it("rejects incompatible schema before report and classifies revoked authorization safely", async () => {
  let reports = 0;
  const p = analyticsProvider(config, async (url, init) => {
    if (String(url).endsWith("/metadata"))
      return Response.json({ dimensions: [], metrics: [] });
    if (String(url).endsWith(":runReport")) reports++;
    return fixtureTransport()(url, init);
  });
  await expect(
    p.report("r", "properties/123", {
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      streamId: "456",
      hostName: "example.com",
    }),
  ).rejects.toThrow("ANALYTICS_INCOMPATIBLE_REPORT");
  expect(reports).toBe(0);
  const revoked = analyticsProvider(config, async () =>
    Response.json(
      { error: "invalid_grant", secret: "never output" },
      { status: 400 },
    ),
  );
  await expect(revoked.properties("r")).rejects.toThrow(
    "ANALYTICS_RECONNECT_REQUIRED",
  );
});
it("never substitutes homepage metrics, drops meaningful query or blends timezone windows", () => {
  const row = {
    date: "2026-01-01",
    rawLandingPage: "/products?plan=pro",
    hostName: "example.com",
    streamId: "456",
    channel: "Organic Search",
    sessions: 12,
    engagedSessions: 8,
    sessionKeyEventRate: 0.333333,
  };
  const report = {
    rows: [
      row,
      { ...row, rawLandingPage: "" },
      { ...row, rawLandingPage: "(not set)" },
      { ...row, hostName: "other.com" },
    ],
    rowCount: 4,
    timeZone: "America/Los_Angeles",
    diagnostics: {},
  };
  const rows = normalizeGa4Rows(
    report,
    "https://example.com",
    "456",
    "2026-01-01",
    "2026-01-02",
  );
  expect(rows[0]!.normalizedUrl).toBe("https://example.com/products?plan=pro");
  expect(rows[1]!.normalizedUrl).toBeNull();
  expect(rows[2]!.unavailableReason).toBe("missing_landing_page");
  expect(rows[3]!.unavailableReason).toBe("scope_mismatch");
  const scope = {
      origin: "https://example.com",
      property: "properties/123",
      streamId: "456",
      startDate: "2026-01-01",
      endDate: "2026-01-02",
    },
    snapshot = {
      ...scope,
      rows: [rows[0]],
      timeZone: "America/Los_Angeles",
      status: "complete",
      diagnostics: {},
    };
  const opportunities = [
    { page: "https://example.com/products?plan=pro" },
    { page: "https://example.com/" },
    { page: "https://example.com/products?plan=free" },
  ];
  expect(
    joinGa4Outcomes(opportunities, snapshot, scope).map(
      (x) => x.conversionEvidence.status,
    ),
  ).toEqual(["available", "unavailable", "unavailable"]);
  expect(
    joinGa4Outcomes(
      opportunities,
      { ...snapshot, timeZone: "Asia/Kolkata" },
      scope,
    )[0]!.conversionEvidence,
  ).toMatchObject({ status: "unavailable", reason: "incompatible_window" });
  expect(
    joinGa4Outcomes(
      opportunities,
      { ...snapshot, diagnostics: { keyEventsConfigured: false } },
      scope,
    )[0]!.conversionEvidence,
  ).toMatchObject({ reason: "missing_key_event_setup" });
});
it("paginates primary account summaries and refuses oversized catalogs without choosing a property", async () => {
  const base = fixtureTransport(),
    seen: string[] = [];
  const p = analyticsProvider(config, async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("accountSummaries")) {
      seen.push(u.searchParams.get("pageToken") ?? "");
      return Response.json({
        accountSummaries: [
          { propertySummaries: [{ property: "properties/123" }] },
        ],
        ...(u.searchParams.has("pageToken") ? {} : { nextPageToken: "next" }),
      });
    }
    return base(url, init);
  });
  expect(await p.properties("r")).toHaveLength(1);
  expect(seen).toEqual(["", "next"]);
  const large = analyticsProvider(config, async (url, init) =>
    String(url).includes("accountSummaries")
      ? Response.json({
          accountSummaries: [
            {
              propertySummaries: Array.from({ length: 21 }, (_, i) => ({
                property: "properties/" + (i + 1),
              })),
            },
          ],
        })
      : base(url, init),
  );
  await expect(large.properties("r")).rejects.toThrow(
    "ANALYTICS_CATALOG_LIMIT",
  );
});
it("bounds streamed UTF8 JSON bytes and wall-clock budget before extra catalog calls", async () => {
  let canceled = false;
  const p = analyticsProvider(
    config,
    async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            canceled = true;
          },
        }),
      ),
  );
  await expect(p.properties("r")).rejects.toThrow("ANALYTICS_RESPONSE_LIMIT");
  expect(canceled).toBe(true);
  const base = fixtureTransport();
  let now = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const timed = analyticsProvider(config, async (url, init) => {
    const r = await base(url, init);
    now += 46000;
    return r;
  });
  try {
    await expect(timed.properties("r")).rejects.toThrow(
      "ANALYTICS_REQUEST_LIMIT",
    );
  } finally {
    clock.mockRestore();
  }
});
