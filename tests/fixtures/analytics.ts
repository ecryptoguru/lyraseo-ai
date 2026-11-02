import { vi } from "vitest";
import { ANALYTICS_SCOPE } from "../../apps/lyraseo-web/src/server/google/analytics";
const dimensions = [
    "date",
    "landingPagePlusQueryString",
    "hostName",
    "streamId",
    "sessionDefaultChannelGroup",
  ],
  metrics = ["sessions", "engagedSessions", "sessionKeyEventRate"];
export const primaryReport = {
  dimensionHeaders: dimensions.map((name) => ({ name })),
  metricHeaders: metrics.map((name) => ({ name, type: "TYPE_FLOAT" })),
  rows: [
    {
      dimensionValues: [
        "20260101",
        "/products?plan=pro",
        "example.com",
        "456",
        "Organic Search",
      ].map((value) => ({ value })),
      metricValues: ["12", "8", "0.333333"].map((value) => ({ value })),
    },
  ],
  rowCount: 1,
  metadata: {
    timeZone: "America/Los_Angeles",
    subjectToThresholding: true,
    samplingMetadatas: [{ samplesReadCount: "100", samplingSpaceSize: "200" }],
    schemaRestrictionResponse: {
      activeMetricRestrictions: [
        { metricName: "sessions", restrictedMetricTypes: ["REVENUE_DATA"] },
      ],
    },
    dataLossFromOtherRow: true,
  },
};
export function fixtureTransport(report = primaryReport) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis"))
      return Response.json({
        access_token: "access",
        refresh_token: "analytics-refresh",
        scope: ANALYTICS_SCOPE,
      });
    if (u.includes("accountSummaries"))
      return Response.json({
        accountSummaries: [
          {
            account: "accounts/1",
            propertySummaries: [
              { property: "properties/123", displayName: "Property" },
            ],
          },
        ],
      });
    if (u.endsWith("/dataStreams?pageSize=200"))
      return Response.json({
        dataStreams: [
          {
            name: "properties/123/dataStreams/456",
            type: "WEB_DATA_STREAM",
            displayName: "Web",
            webStreamData: { defaultUri: "https://example.com" },
          },
        ],
      });
    if (u.endsWith("/keyEvents?pageSize=200"))
      return Response.json({ keyEvents: [{ eventName: "purchase" }] });
    if (u.endsWith("/metadata"))
      return Response.json({
        dimensions: dimensions.map((apiName) => ({ apiName })),
        metrics: metrics.map((apiName) => ({ apiName, description: apiName })),
      });
    if (u.endsWith(":checkCompatibility"))
      return Response.json({
        dimensionCompatibilities: dimensions.map((apiName) => ({
          compatibility: "COMPATIBLE",
          dimensionMetadata: { apiName },
        })),
        metricCompatibilities: metrics.map((apiName) => ({
          compatibility: "COMPATIBLE",
          metricMetadata: { apiName },
        })),
      });
    if (u.endsWith(":runReport")) return Response.json(report);
    if (u.endsWith("properties/123"))
      return Response.json({
        name: "properties/123",
        displayName: "Property",
        timeZone: "America/Los_Angeles",
      });
    throw new Error("Unexpected fixture URL " + u + " " + init?.method);
  });
}
