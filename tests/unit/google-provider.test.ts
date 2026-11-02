import { expect, it, vi } from "vitest";
import {
  googleProvider,
  secretBox,
  GOOGLE_SCOPE,
} from "../../apps/lyraseo-web/src/server/google/provider";
import { validateSearchWindow } from "../../packages/db/src/gsc";
const key = Buffer.alloc(32, 7).toString("base64");
it("authenticates randomized site-bound encrypted credentials and detects tampering", () => {
  const box = secretBox(key),
    a = box.seal("refresh-secret", "a:site"),
    b = box.seal("refresh-secret", "a:site");
  expect(a).not.toBe(b);
  expect(a).not.toContain("refresh-secret");
  expect(box.open(a, "a:site")).toBe("refresh-secret");
  expect(() => box.open(a, "b:site")).toThrow();
  expect(() => box.open(a.slice(0, -3) + "xxx", "a:site")).toThrow();
  expect(() => secretBox("bad")).toThrow("GOOGLE_UNAVAILABLE");
});
it("uses readonly offline S256 PKCE and validates exchange scopes and refresh credentials", async () => {
  const f = vi.fn(async () =>
      Response.json({
        access_token: "access",
        refresh_token: "refresh",
        scope: GOOGLE_SCOPE,
      }),
    ),
    p = googleProvider(
      {
        clientId: "id",
        clientSecret: "secret",
        redirectUri: "https://app.example/callback",
      },
      f,
    );
  const url = new URL(p.authorize("state", "verifier"));
  expect(url.searchParams.get("scope")).toBe(GOOGLE_SCOPE);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(await p.exchange("code", "verifier")).toBe("refresh");
  expect(String(f.mock.calls[0][1]?.body)).toContain("code_verifier=verifier");
});
it("normalizes zero denominators and sends final paginated web shape", async () => {
  const requests: RequestInit[] = [];
  const p = googleProvider(
    {
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "https://app.example/callback",
    },
    async (_url, init) => {
      requests.push(init!);
      return Response.json(
        requests.length === 1
          ? { access_token: "access" }
          : {
              rows: [
                { keys: ["page"], clicks: 0, impressions: 0, position: 0 },
              ],
            },
      );
    },
  );
  const rows = await p.query("refresh", "https://example.com/", {
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    shape: "page",
    startRow: 25000,
  });
  expect(rows[0]).toMatchObject({ ctr: null, position: null });
  expect(JSON.parse(String(requests[1].body))).toMatchObject({
    rowLimit: 25000,
    startRow: 25000,
    dataState: "final",
    type: "web",
  });
});
it("classifies revoked OAuth without returning provider bodies or secrets", async () => {
  const p = googleProvider(
    {
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "https://app.example/callback",
    },
    async () =>
      Response.json(
        { error: "invalid_grant", secret: "sensitive" },
        { status: 400 },
      ),
  );
  await expect(p.properties("refresh")).rejects.toThrow(
    "GOOGLE_RECONNECT_REQUIRED",
  );
});
it("bounds date windows and rejects normalized invalid calendar dates", () => {
  expect(() => validateSearchWindow("2026-02-30", "2026-03-01")).toThrow();
  expect(() => validateSearchWindow("2026-01-01", "2026-05-01")).toThrow();
  expect(() => validateSearchWindow("2026-01-01", "2026-01-28")).not.toThrow();
});
