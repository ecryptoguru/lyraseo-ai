import { createHash } from "node:crypto";
import type { Ga4Provider, Ga4Property, Ga4Row } from "@lyraseo/db/ga4";
import { secretBox } from "./provider";
export const ANALYTICS_SCOPE =
  "https://www.googleapis.com/auth/analytics.readonly";
const dimensions = [
  "date",
  "landingPagePlusQueryString",
  "hostName",
  "streamId",
  "sessionDefaultChannelGroup",
];
const metrics = ["sessions", "engagedSessions", "sessionKeyEventRate"];
const admin = "https://analyticsadmin.googleapis.com/v1beta/";
const data = "https://analyticsdata.googleapis.com/v1beta/";
const invalid = () => new Error("INVALID_ANALYTICS_RESPONSE");
export function analyticsProvider(
  config: { clientId: string; clientSecret: string; redirectUri: string },
  transport: typeof fetch = fetch,
): Ga4Provider {
  type Budget = { deadline: number; calls: number };
  async function json(url: string, init: RequestInit = {}, budget?: Budget) {
    if (budget && (Date.now() >= budget.deadline || ++budget.calls > 48))
      throw new Error("ANALYTICS_REQUEST_LIMIT");
    let response: Response;
    try {
      response = await transport(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.max(
            1,
            Math.min(20000, budget ? budget.deadline - Date.now() : 20000),
          ),
        ),
      });
    } catch {
      throw new Error("ANALYTICS_TEMPORARILY_UNAVAILABLE");
    }
    if (!response.ok) {
      if ([400, 401].includes(response.status))
        throw new Error("ANALYTICS_RECONNECT_REQUIRED");
      if (response.status === 403) throw new Error("ANALYTICS_SCOPE_ERROR");
      throw new Error("ANALYTICS_TEMPORARILY_UNAVAILABLE");
    }
    const reader = response.body?.getReader();
    if (!reader) throw invalid();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 16 * 1024 * 1024)
          throw new Error("ANALYTICS_RESPONSE_LIMIT");
        chunks.push(part.value);
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "ANALYTICS_RESPONSE_LIMIT"
      )
        throw error;
      throw invalid();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function token(values: Record<string, string>, budget?: Budget) {
    const result = await json(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...values,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      },
      budget,
    );
    if (typeof result.access_token !== "string") throw invalid();
    return result;
  }
  async function access(refresh: string, budget?: Budget) {
    return (
      await token(
        { grant_type: "refresh_token", refresh_token: refresh },
        budget,
      )
    ).access_token as string;
  }
  function headers(t: string) {
    return { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
  }
  async function pages(url: string, t: string, field: string, budget?: Budget) {
    const results: unknown[] = [];
    let next = "";
    for (let page = 0; page < 10; page++) {
      const u = new URL(url);
      u.searchParams.set("pageSize", "200");
      if (next) u.searchParams.set("pageToken", next);
      const r = await json(u.href, { headers: headers(t) }, budget);
      if (r[field] !== undefined && !Array.isArray(r[field])) throw invalid();
      results.push(...(r[field] ?? []));
      if (results.length > 2000) throw new Error("ANALYTICS_CATALOG_LIMIT");
      if (!r.nextPageToken) return results;
      if (typeof r.nextPageToken !== "string" || r.nextPageToken === next)
        throw invalid();
      next = r.nextPageToken;
    }
    throw new Error("ANALYTICS_CATALOG_LIMIT");
  }
  return {
    authorize(state, verifier) {
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: ANALYTICS_SCOPE,
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      return u.href;
    },
    async exchange(code, verifier) {
      const t = await token({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: config.redirectUri,
      });
      if (
        typeof t.refresh_token !== "string" ||
        !t.refresh_token ||
        typeof t.scope !== "string" ||
        !t.scope.split(" ").includes(ANALYTICS_SCOPE)
      )
        throw new Error("ANALYTICS_RECONNECT_REQUIRED");
      return t.refresh_token;
    },
    async properties(refresh) {
      const budget = { deadline: Date.now() + 45000, calls: 0 };
      const t = await access(refresh, budget),
        accounts = await pages(
          admin + "accountSummaries",
          t,
          "accountSummaries",
          budget,
        ),
        names = new Set<string>();
      for (const value of accounts) {
        const a = value as { propertySummaries?: { property: string }[] };
        if (
          a.propertySummaries !== undefined &&
          !Array.isArray(a.propertySummaries)
        )
          throw invalid();
        for (const p of a.propertySummaries ?? []) {
          if (!/^properties\/\d+$/.test(p.property)) throw invalid();
          names.add(p.property);
        }
      }
      if (names.size > 20) throw new Error("ANALYTICS_CATALOG_LIMIT");
      const properties: Ga4Property[] = [];
      for (const property of names) {
        const p = await json(admin + property, { headers: headers(t) }, budget);
        if (
          p.name !== property ||
          typeof p.timeZone !== "string" ||
          typeof p.displayName !== "string"
        )
          throw invalid();
        try {
          new Intl.DateTimeFormat("en", { timeZone: p.timeZone });
        } catch {
          throw invalid();
        }
        const streams = await pages(
          admin + property + "/dataStreams",
          t,
          "dataStreams",
          budget,
        );
        const web: Ga4Property["streams"] = [];
        for (const value of streams) {
          const s = value as {
            type?: string;
            name?: string;
            displayName?: string;
            webStreamData?: { defaultUri?: string };
          };
          if (s.type !== "WEB_DATA_STREAM") continue;
          if (
            !s.name?.startsWith(property + "/dataStreams/") ||
            !/^\d+$/.test(s.name.split("/").at(-1) ?? "") ||
            typeof s.webStreamData?.defaultUri !== "string"
          )
            throw invalid();
          web.push({
            streamId: s.name.split("/").at(-1)!,
            displayName: s.displayName ?? s.name,
            defaultUri: s.webStreamData.defaultUri,
          });
        }
        properties.push({
          property,
          displayName: p.displayName,
          timeZone: p.timeZone,
          streams: web,
        });
      }
      return properties;
    },
    async report(refresh, property, input) {
      if (!/^properties\/\d+$/.test(property) || !/^\d+$/.test(input.streamId))
        throw invalid();
      const budget = { deadline: Date.now() + 60000, calls: 0 };
      const t = await access(refresh, budget),
        h = headers(t),
        metadata = await json(
          data + property + "/metadata",
          { headers: h },
          budget,
        );
      if (
        !dimensions.every((name) =>
          metadata.dimensions?.some(
            (x: { apiName: string }) => x.apiName === name,
          ),
        ) ||
        !metrics.every((name) =>
          metadata.metrics?.some(
            (x: { apiName: string }) => x.apiName === name,
          ),
        )
      )
        throw new Error("ANALYTICS_INCOMPATIBLE_REPORT");
      const dimensionFilter = {
        andGroup: {
          expressions: [
            {
              filter: {
                fieldName: "streamId",
                stringFilter: {
                  matchType: "EXACT",
                  value: input.streamId,
                  caseSensitive: true,
                },
              },
            },
            {
              filter: {
                fieldName: "hostName",
                stringFilter: {
                  matchType: "EXACT",
                  value: input.hostName,
                  caseSensitive: true,
                },
              },
            },
            {
              filter: {
                fieldName: "sessionDefaultChannelGroup",
                stringFilter: {
                  matchType: "EXACT",
                  value: "Organic Search",
                  caseSensitive: true,
                },
              },
            },
          ],
        },
      };
      const shape = {
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
        dimensionFilter,
      };
      const compatibility = await json(
        data + property + ":checkCompatibility",
        { method: "POST", headers: h, body: JSON.stringify(shape) },
        budget,
      );
      for (const [field, names, key] of [
        ["dimensionCompatibilities", dimensions, "dimensionMetadata"],
        ["metricCompatibilities", metrics, "metricMetadata"],
      ] as const) {
        if (
          !names.every((name) =>
            compatibility[field]?.some(
              (x: Record<string, unknown>) =>
                x.compatibility === "COMPATIBLE" &&
                (x[key] as { apiName?: string })?.apiName === name,
            ),
          )
        )
          throw new Error("ANALYTICS_INCOMPATIBLE_REPORT");
      }
      const keyEvents = await pages(
        admin + property + "/keyEvents",
        t,
        "keyEvents",
        budget,
      );
      const r = await json(
        data + property + ":runReport",
        {
          method: "POST",
          headers: h,
          body: JSON.stringify({
            ...shape,
            dateRanges: [
              { startDate: input.startDate, endDate: input.endDate },
            ],
            limit: "10000",
            offset: "0",
            keepEmptyRows: false,
            returnPropertyQuota: true,
            orderBys: [
              { dimension: { dimensionName: "date" } },
              { dimension: { dimensionName: "landingPagePlusQueryString" } },
            ],
          }),
        },
        budget,
      );
      if (
        !dimensions.every(
          (name, i) => r.dimensionHeaders?.[i]?.name === name,
        ) ||
        r.dimensionHeaders.length !== dimensions.length ||
        !metrics.every((name, i) => r.metricHeaders?.[i]?.name === name) ||
        r.metricHeaders.length !== metrics.length ||
        (r.rows !== undefined && !Array.isArray(r.rows))
      )
        throw invalid();
      const number = (v: unknown, rate = false) => {
        if (
          typeof v !== "string" ||
          !v.trim() ||
          !Number.isFinite(Number(v)) ||
          Number(v) < 0 ||
          (!rate && !Number.isSafeInteger(Number(v))) ||
          (rate && Number(v) > 1)
        )
          throw invalid();
        return Number(v);
      };
      const rows: Ga4Row[] = (r.rows ?? []).map(
        (x: {
          dimensionValues: { value: string }[];
          metricValues: { value: string }[];
        }) => {
          if (
            x.dimensionValues?.length !== dimensions.length ||
            x.metricValues?.length !== metrics.length ||
            x.dimensionValues.some(
              (d) => typeof d.value !== "string" || d.value.length > 8192,
            )
          )
            throw invalid();
          const [date, rawLandingPage, hostName, streamId, channel] =
            x.dimensionValues.map((d) => d.value) as [
              string,
              string,
              string,
              string,
              string,
            ];
          if (!/^\d{8}$/.test(date)) throw invalid();
          return {
            date:
              date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6),
            rawLandingPage,
            hostName,
            streamId,
            channel,
            sessions: number(x.metricValues[0]!.value),
            engagedSessions: number(x.metricValues[1]!.value),
            sessionKeyEventRate: number(x.metricValues[2]!.value, true),
          };
        },
      );
      if (!keyEvents.length)
        for (const row of rows) row.sessionKeyEventRate = null;
      const m = r.metadata ?? {},
        restrictions =
          m.schemaRestrictionResponse?.activeMetricRestrictions ?? [],
        sampling = m.samplingMetadatas ?? [],
        restricted = restrictions.length > 0;
      if (typeof m.timeZone !== "string") throw invalid();
      return {
        rows,
        rowCount: r.rowCount ?? 0,
        timeZone: m.timeZone,
        diagnostics: {
          metadata: m,
          restricted,
          partial:
            restricted ||
            m.subjectToThresholding === true ||
            m.dataLossFromOtherRow === true ||
            sampling.length > 0,
          thresholded: m.subjectToThresholding === true,
          sampled: sampling.length > 0,
          otherLoss: m.dataLossFromOtherRow === true,
          emptyReason: m.emptyReason ?? null,
          metricDefinitions: metrics.map((name) =>
            metadata.metrics.find(
              (x: { apiName: string }) => x.apiName === name,
            ),
          ),
          qualifiedCompatibility: true,
          keyEventsConfigured: keyEvents.length > 0,
        },
      };
    },
  };
}
export function analyticsConfigured() {
  try {
    if (
      !process.env.GOOGLE_CLIENT_ID ||
      !process.env.GOOGLE_CLIENT_SECRET ||
      !process.env.INTEGRATION_ENCRYPTION_KEY
    )
      return false;
    secretBox(process.env.INTEGRATION_ENCRYPTION_KEY);
    return true;
  } catch {
    return false;
  }
}
export function configuredAnalytics(origin: string) {
  const {
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    INTEGRATION_ENCRYPTION_KEY: key,
  } = process.env;
  if (!clientId || !clientSecret || !key || !analyticsConfigured())
    throw new Error("ANALYTICS_UNAVAILABLE");
  return {
    provider: analyticsProvider({
      clientId,
      clientSecret,
      redirectUri: origin + "/api/integrations/analytics/callback",
    }),
    box: secretBox(key),
  };
}
