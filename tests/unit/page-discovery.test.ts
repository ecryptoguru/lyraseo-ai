import { expect, it, vi } from "vitest";
import * as acquisition from "../../packages/visibility/src/acquisition";

type CandidateResult = {
  candidates: string[];
  state: "available" | "unavailable";
  sourceUrl: string;
  truncated: boolean;
  error?: string;
};
type Discovery = (
  origin: string,
  transport: (url: string, signal: AbortSignal) => Promise<Response>,
  assertAccess: () => Promise<void>,
) => Promise<CandidateResult>;
const discover = (acquisition as unknown as { discoverCandidates: Discovery })
  .discoverCandidates;

it("discovers only bounded same-origin homepage links without fetching candidate pages", async () => {
  expect(typeof discover).toBe("function");
  const requests: string[] = [];
  const html = `<a href="/about#team">About</a><a href="/about">dup</a><a href="/?lang=en">en</a><a href="https://evil.example/out">external</a><a href="https://user@example.com/secret">credentials</a>${Array.from({ length: 40 }, (_, i) => `<a href="/p${i}">p</a>`).join("")}`;
  const transport = async (url: string) => {
    requests.push(url);
    return url.endsWith("/robots.txt")
      ? new Response("User-agent: *\nAllow: /", {
          headers: { "content-type": "text/plain" },
        })
      : new Response(html, { headers: { "content-type": "text/html" } });
  };
  const assertAccess = vi.fn(async () => {});
  const result = await discover("https://example.com", transport, assertAccess);
  expect(requests).toEqual([
    "https://example.com/robots.txt",
    "https://example.com/",
  ]);
  expect(result).toMatchObject({
    state: "available",
    sourceUrl: "https://example.com/",
    truncated: true,
  });
  expect(result.candidates).toHaveLength(25);
  expect(result.candidates.slice(0, 3)).toEqual([
    "https://example.com/",
    "https://example.com/about",
    "https://example.com/?lang=en",
  ]);
  expect(
    result.candidates.every(
      (url) =>
        new URL(url).origin === "https://example.com" && !new URL(url).username,
    ),
  ).toBe(true);
  expect(assertAccess.mock.calls.length).toBeGreaterThanOrEqual(4);
});

it("keeps unavailable homepage evidence distinct and never suggests nonexistent page findings", async () => {
  expect(typeof discover).toBe("function");
  const result = await discover(
    "https://example.com",
    async (url) =>
      url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response("no", { status: 403 }),
    async () => {},
  );
  expect(result).toMatchObject({
    state: "unavailable",
    candidates: ["https://example.com/"],
    error: "HTTP_ERROR",
    truncated: false,
  });
});

it("checks access again after acquisition before exposing discovered URLs", async () => {
  expect(typeof discover).toBe("function");
  let calls = 0;
  await expect(
    discover(
      "https://example.com",
      async (url) =>
        url.endsWith("/robots.txt")
          ? new Response("", { status: 404 })
          : new Response('<a href="/private">link</a>', {
              headers: { "content-type": "text/html" },
            }),
      async () => {
        if (++calls === 4) throw Error("FORBIDDEN");
      },
    ),
  ).rejects.toThrow("FORBIDDEN");
});

it("does not follow a homepage redirect outside the verified origin", async () => {
  const requests: string[] = [];
  const result = await discover(
    "https://example.com",
    async (url) => {
      requests.push(url);
      return url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response(null, {
            status: 302,
            headers: { location: "https://other.example/private" },
          });
    },
    async () => {},
  );
  expect(requests).toEqual([
    "https://example.com/robots.txt",
    "https://example.com/",
  ]);
  expect(result).toMatchObject({
    state: "unavailable",
    candidates: ["https://example.com/"],
    error: "REDIRECT_OUTSIDE_ORIGIN",
  });
});

it("stops before the homepage when robots policy is unavailable", async () => {
  const requests: string[] = [];
  const result = await discover(
    "https://example.com",
    async (url) => {
      requests.push(url);
      return new Response("blocked", { status: 503 });
    },
    async () => {},
  );
  expect(requests).toEqual(["https://example.com/robots.txt"]);
  expect(result).toMatchObject({
    state: "unavailable",
    error: "ROBOTS_UNAVAILABLE",
  });
});
