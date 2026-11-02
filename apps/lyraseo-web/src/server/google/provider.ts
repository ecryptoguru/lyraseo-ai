import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { GoogleProvider, SecretBox, SearchRow } from "@lyraseo/db/gsc";
export const GOOGLE_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";
export function secretBox(key: string): SecretBox {
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== key)
    throw new Error("GOOGLE_UNAVAILABLE");
  return {
    seal(value, aad) {
      const nonce = randomBytes(12),
        c = createCipheriv("aes-256-gcm", bytes, nonce);
      c.setAAD(Buffer.from(aad));
      return [
        "v1",
        nonce.toString("base64url"),
        Buffer.concat([c.update(value, "utf8"), c.final()]).toString(
          "base64url",
        ),
        c.getAuthTag().toString("base64url"),
      ].join(".");
    },
    open(value, aad) {
      const [version, n, cipher, tag] = value.split(".");
      if (version !== "v1" || !n || !cipher || !tag)
        throw new Error("INVALID_SECRET");
      const d = createDecipheriv(
        "aes-256-gcm",
        bytes,
        Buffer.from(n, "base64url"),
      );
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        d.update(Buffer.from(cipher, "base64url")),
        d.final(),
      ]).toString("utf8");
    },
  };
}
export function googleProvider(
  config: { clientId: string; clientSecret: string; redirectUri: string },
  transport: typeof fetch = fetch,
): GoogleProvider {
  async function json(url: string, init: RequestInit) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await transport(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        });
      } catch {
        throw new Error("GOOGLE_TEMPORARILY_UNAVAILABLE");
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
        continue;
      }
      break;
    }
    if (!response?.ok) {
      if (response?.status === 400 || response?.status === 401)
        throw new Error("GOOGLE_RECONNECT_REQUIRED");
      if (response?.status === 403)
        throw new Error("GOOGLE_PERMISSION_REQUIRED");
      throw new Error("GOOGLE_TEMPORARILY_UNAVAILABLE");
    }
    try {
      return await response.json();
    } catch {
      throw new Error("INVALID_GOOGLE_RESPONSE");
    }
  }
  async function token(values: Record<string, string>) {
    const result = await json("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...values,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });
    if (typeof result.access_token !== "string")
      throw new Error("INVALID_GOOGLE_RESPONSE");
    return result;
  }
  async function access(refresh: string) {
    return (
      await token({ grant_type: "refresh_token", refresh_token: refresh })
    ).access_token as string;
  }
  return {
    authorize(state, verifier) {
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPE,
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
        !t.scope.split(" ").includes(GOOGLE_SCOPE)
      )
        throw new Error("GOOGLE_RECONNECT_REQUIRED");
      return t.refresh_token;
    },
    async properties(refresh) {
      const t = await access(refresh),
        r = await json("https://www.googleapis.com/webmasters/v3/sites", {
          headers: { Authorization: `Bearer ${t}` },
        });
      if (!Array.isArray(r.siteEntry) && r.siteEntry !== undefined)
        throw new Error("INVALID_GOOGLE_RESPONSE");
      return (r.siteEntry ?? []).map(
        (x: { siteUrl?: unknown; permissionLevel?: unknown }) => {
          if (
            typeof x.siteUrl !== "string" ||
            typeof x.permissionLevel !== "string"
          )
            throw new Error("INVALID_GOOGLE_RESPONSE");
          return { siteUrl: x.siteUrl, permissionLevel: x.permissionLevel };
        },
      );
    },
    async query(refresh, property, input) {
      const t = await access(refresh),
        r = await json(
          `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${t}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              startDate: input.startDate,
              endDate: input.endDate,
              dimensions: input.shape.split(","),
              type: "web",
              dataState: "final",
              rowLimit: 25000,
              startRow: input.startRow,
            }),
          },
        );
      if (r.rows !== undefined && !Array.isArray(r.rows))
        throw new Error("INVALID_GOOGLE_RESPONSE");
      return (r.rows ?? []).map((x: SearchRow) => {
        if (
          !Array.isArray(x.keys) ||
          x.keys.length !== input.shape.split(",").length ||
          x.keys.some((k) => typeof k !== "string" || k.length > 8192) ||
          ![x.clicks, x.impressions, x.position].every(
            (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
          ) ||
          x.clicks > x.impressions
        )
          throw new Error("INVALID_GOOGLE_RESPONSE");
        return {
          keys: x.keys,
          clicks: x.clicks,
          impressions: x.impressions,
          position: x.impressions ? x.position : null,
          ctr: x.impressions ? x.clicks / x.impressions : null,
        };
      });
    },
  };
}
export function configuredGoogle(origin: string) {
  const {
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    INTEGRATION_ENCRYPTION_KEY: key,
  } = process.env;
  if (!clientId || !clientSecret || !key) throw new Error("GOOGLE_UNAVAILABLE");
  return {
    provider: googleProvider({
      clientId,
      clientSecret,
      redirectUri: origin + "/api/integrations/google/callback",
    }),
    box: secretBox(key),
  };
}
