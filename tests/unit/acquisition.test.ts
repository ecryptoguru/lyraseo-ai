import { afterAll, beforeAll, expect, it } from "vitest";
import {
  acquireRawPage,
  boundedRawAnchorText,
  extractRawHtml,
  type PublicTransport,
} from "../../packages/visibility/src/acquisition";
import { compareAudits, evaluateAudit } from "../../packages/visibility/src";
import { crawlerSite } from "../fixtures/crawler-site";

let site: Awaited<ReturnType<typeof crawlerSite>>;
beforeAll(async () => {
  site = await crawlerSite();
});
afterAll(async () => {
  await site.close();
});
const origin = "https://example.com/";

it("compares a raw-observable HTTP fix while rendered head verdicts stay unknown", async () => {
  const controlled = await crawlerSite();
  try {
    const url = `${origin}missing`;
    const before = await acquireRawPage(url, origin, controlled.transport);
    controlled.fix();
    const after = await acquireRawPage(url, origin, controlled.transport);
    const evaluate = (page: typeof before.evidence) =>
      evaluateAudit({
        siteOrigin: origin,
        manifest: [origin, url],
        pages: [page],
        methodologyVersion: "readiness-v1",
      });
    expect(
      compareAudits(
        evaluate(before.evidence),
        evaluate(after.evidence),
      ).resolved.map((r) => r.ruleId),
    ).toContain("D01");
    expect(
      evaluate(after.evidence).rules.find((r) => r.ruleId === "E02")?.outcome,
    ).toBe("UNKNOWN");
    expect(after.evidence.headComplete).toBe(false);
    expect(after.provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      controlled.requests.some(
        (url) => url.includes("secret") || url.includes("tracker"),
      ),
    ).toBe(false);
  } finally {
    await controlled.close();
  }
});

it.each([
  ["outside", "REDIRECT_OUTSIDE_ORIGIN"],
  ["loop", "REDIRECT_LOOP"],
  ["text", "UNSUPPORTED_CONTENT_TYPE"],
  ["blocked", "ROBOTS_DISALLOWED"],
])("retains unavailable evidence for %s", async (path, error) => {
  const result = await acquireRawPage(
    new URL(path!, origin).href,
    origin,
    site.transport,
  );
  expect(result.evidence.acquired).toBe(false);
  expect(result.provenance.error).toBe(error);
  if (path === "blocked") expect(site.requests).not.toContain("/blocked");
});

it("retains an observed HTTP error without manufacturing a successful page", async () => {
  const result = await acquireRawPage(
    `${origin}missing`,
    origin,
    site.transport,
  );
  expect(result.evidence.status).toBe(404);
  expect(result.evidence.acquired).toBe(false);
  expect(result.provenance.error).toBe("HTTP_ERROR");
});

it("follows a bounded same-origin redirect and preserves both URL identities", async () => {
  const result = await acquireRawPage(
    `${origin}redirect`,
    origin,
    site.transport,
  );
  expect(result.evidence.requestedUrl).toBe(`${origin}redirect`);
  expect(result.evidence.finalUrl).toBe(origin);
  expect(result.provenance.redirects).toEqual([`${origin}redirect`]);
});

it("refuses acquisition when robots cannot be read", async () => {
  const requests: string[] = [];
  const result = await acquireRawPage(origin, origin, async (url) => {
    requests.push(url);
    return new Response("", { status: 503 });
  });
  expect(result.provenance.error).toBe("ROBOTS_UNAVAILABLE");
  expect(requests).toEqual([`${origin}robots.txt`]);
});

it("bounds streamed bytes even when content-length lies", async () => {
  const transport: PublicTransport = async (url) =>
    url.endsWith("robots.txt")
      ? new Response("", { status: 404 })
      : new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/html", "content-length": "1" } },
        );
  const result = await acquireRawPage(origin, origin, transport);
  expect(result.provenance.error).toBe("BODY_TOO_LARGE");
  expect(result.provenance.rawHtml).toBeUndefined();
});

it("keeps raw source distinct from computed visibility and applies Google noindex", () => {
  const html =
    '<html><head><title>Example</title><meta name="robots" content="noindex"><script type="application/ld+json">{broken}</script></head><body hidden>Example</body></html>';
  const page = extractRawHtml(html, origin, origin, new Headers());
  expect(page.explicitNoindex).toBe(true);
  expect(page.jsonLd).toEqual(["{broken}"]);
  expect(page.bodyComplete).toBe(false);
  expect(page.visibleText).toBeUndefined();
});

it("does not misread another crawler's noindex as a Google directive", () => {
  expect(
    extractRawHtml(
      "<title>Example</title>",
      origin,
      origin,
      new Headers({ "x-robots-tag": "otherbot: noindex" }),
    ).explicitNoindex,
  ).toBe(false);
});

it.each(["x".repeat(300000), "界".repeat(100000)])(
  "checkpoints an unavailable receipt for oversized extracted evidence %#",
  async (title) => {
    const html = `<html><head><title>${title}</title></head><body></body></html>`;
    const receipt = await acquireRawPage(origin, origin, async (url) =>
      url.endsWith("robots.txt")
        ? new Response("", { status: 404 })
        : new Response(html, { headers: { "content-type": "text/html" } }),
    );
    expect(receipt.provenance.error).toBe("EVIDENCE_TOO_LARGE");
    expect(receipt.provenance.rawHtml).toBe(html);
    expect(receipt.evidence.acquired).toBe(false);
    expect(receipt.evidence.titleElements).toEqual([]);
  },
);

it("restricts document head diagnostics and records conflicting HTTP/DOM canonicals without rendered conclusions", () => {
  const page = extractRawHtml(
    '<html><head><title>Document</title><template><title>Template</title></template><link rel="canonical" href="/"><base href="/docs/"></head><body><svg><title>Icon</title></svg><title>Body</title><template><a href="/bad">bad</a></template><a href="guide"><span>Read guide</span><script>ignore</script><template>ignore</template></a><a href="https://other.example/">external</a></body></html>',
    origin,
    origin,
    new Headers({
      link: '<https://example.com/other>; type="text/html"; rel="canonical"',
    }),
  );
  expect(page.titleElements).toEqual(["Document"]);
  expect(page.canonicalUrls).toEqual([origin, `${origin}other`]);
  expect(page.headComplete).toBe(false);
  expect(page.linkNames).toEqual([
    { href: `${origin}docs/guide`, name: "Read guide" },
  ]);
  const result = evaluateAudit({
    siteOrigin: origin,
    manifest: [origin],
    pages: [
      {
        ...page,
        status: 200,
        contentType: "text/html",
        robotsGoogleAllowed: true,
      },
    ],
    methodologyVersion: "readiness-v1",
  });
  expect(
    result.rules
      .filter((r) => ["D03", "E02"].includes(r.ruleId))
      .every((r) => r.outcome === "UNKNOWN"),
  ).toBe(true);
});

it.each([
  ["a".repeat(499) + "😀", "a".repeat(499)],
  ["a".repeat(498) + "😀extra", "a".repeat(498) + "😀"],
  ["😀".repeat(251), "😀".repeat(250)],
])(
  "preserves Unicode boundaries under the raw anchor text cap %#",
  (source, expected) => {
    const bounded = boundedRawAnchorText(source);
    expect(bounded).toBe(expected);
    expect(bounded.length).toBeLessThanOrEqual(500);
    expect(bounded.isWellFormed()).toBe(true);
  },
);
