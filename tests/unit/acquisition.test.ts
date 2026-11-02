import { afterAll, beforeAll, expect, it } from "vitest";
import {
  acquireRawPage,
  replayGoogleRobots,
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

it.each([
  [
    "specific group overrides wildcard",
    "User-agent: *\nDisallow: /private\nUser-agent: Googlebot\nAllow: /private\nUser-agent: LyraseoAudit\nAllow: /",
    "private",
    true,
  ],
  [
    "longest path",
    "User-agent: Googlebot\nAllow: /\nDisallow: /private",
    "private",
    false,
  ],
  [
    "allow wins tie",
    "User-agent: Googlebot\nDisallow: /private\nAllow: /private",
    "private",
    true,
  ],
  [
    "encoded unreserved path",
    "User-agent: Googlebot\nDisallow: /%70rivate",
    "private",
    false,
  ],
  [
    "encoded reserved slash",
    "User-agent: Googlebot\nDisallow: /a%2fb",
    "a%2Fb",
    false,
  ],
  [
    "literal slash stays distinct",
    "User-agent: Googlebot\nDisallow: /a%2fb",
    "a/b",
    true,
  ],
] as const)("robots policy: %s", async (_, policy, path, allowed) => {
  const receipt = await acquireRawPage(origin + path, origin, async (url) =>
    url.endsWith("robots.txt")
      ? new Response(policy)
      : new Response("<p>Fixture</p>", {
          headers: { "content-type": "text/html" },
        }),
  );
  expect(receipt.evidence).toMatchObject({
    acquired: true,
    robotsGoogleAllowed: allowed,
    requestedRobotsGoogleAllowed: allowed,
  });
});
it.each([
  [404, true],
  [401, false],
  [403, false],
  [503, false],
] as const)("robots status %i", async (status, acquired) => {
  const requests: string[] = [];
  const receipt = await acquireRawPage(origin, origin, async (url) => {
    requests.push(url);
    return url.endsWith("robots.txt")
      ? new Response("", { status })
      : new Response("<p>Fixture</p>", {
          headers: { "content-type": "text/html" },
        });
  });
  expect(receipt.evidence.acquired).toBe(acquired);
  expect(requests).toHaveLength(acquired ? 2 : 1);
  expect(receipt.provenance.robotsPolicy).toMatchObject({
    status,
    state: acquired ? "no-file" : "unavailable",
  });
  expect(receipt.provenance.robotsPolicy.sha256).toBeUndefined();
  expect(replayGoogleRobots(receipt.provenance.robotsPolicy, origin)).toBe(
    acquired ? true : undefined,
  );

  expect(receipt.evidence.robotsGoogleAllowed).toBe(
    acquired ? true : undefined,
  );
});
it("retains requested and final Google observations across redirects; crawler policy applies at every hop", async () => {
  for (const forbidCrawler of [false, true]) {
    const requests: string[] = [];
    const receipt = await acquireRawPage(
      origin + "start",
      origin,
      async (url) => {
        requests.push(url);
        if (url.endsWith("robots.txt"))
          return new Response(
            "User-agent: Googlebot\nDisallow: /private\nUser-agent: LyraseoAudit\n" +
              (forbidCrawler ? "Disallow: /private" : "Allow: /"),
          );
        if (url.endsWith("start"))
          return new Response(null, {
            status: 302,
            headers: { location: "/private" },
          });
        return new Response("<p>Fixture</p>", {
          headers: { "content-type": "text/html" },
        });
      },
    );
    expect(receipt.evidence.requestedRobotsGoogleAllowed).toBe(true);
    if (forbidCrawler) {
      expect(receipt.provenance.error).toBe("ROBOTS_DISALLOWED");
      expect(requests).not.toContain(origin + "private");
    } else {
      expect(receipt.evidence.robotsGoogleAllowed).toBe(false);
      expect(receipt.evidence.finalUrl).toBe(origin + "private");
      const run = evaluateAudit({
        siteOrigin: origin,
        manifest: [origin, origin + "start"],
        pages: [receipt.evidence],
        pageDeclarations: [
          { requestedUrl: origin + "start", indexingIntent: "indexable" },
        ],
        methodologyVersion: "readiness-v2",
      });
      expect(
        run.rules.find(
          (r) => r.ruleId === "D04" && r.scopeKey === origin + "start",
        ),
      ).toMatchObject({
        outcome: "WARNING",
        reasonCode: "GOOGLEBOT_DISALLOWED",
      });
    }
  }
});
it("indeterminate robots source cannot admit a fetch", async () => {
  const receipt = await acquireRawPage(origin, origin, async (url) => {
    expect(url).toBe(origin + "robots.txt");
    return new Response("<html>login</html>");
  });
  expect(receipt.provenance.error).toBe("ROBOTS_INDETERMINATE");
  expect(receipt.provenance.robotsPolicy).toMatchObject({
    state: "indeterminate",
    status: 200,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(receipt.evidence.robotsGoogleAllowed).toBeUndefined();
});
it("keeps a conclusive header directive when the HTML body is unreadable", async () => {
  const receipt = await acquireRawPage(origin, origin, async (url) =>
    url.endsWith("robots.txt")
      ? new Response("", { status: 404 })
      : new Response("", {
          headers: {
            "content-type": "text/html",
            "x-robots-tag": "googlebot: noindex",
          },
        }),
  );
  const run = evaluateAudit({
    siteOrigin: origin,
    manifest: [origin],
    pages: [receipt.evidence],
    pageDeclarations: [{ requestedUrl: origin, indexingIntent: "indexable" }],
    methodologyVersion: "readiness-v2",
  });
  expect(run.rules.find((r) => r.ruleId === "D02")).toMatchObject({
    outcome: "FAIL",
    reasonCode: "NOINDEX_ON_INTENDED_PAGE",
  });
  expect(run.score).toBeNull();
});

it("captures the redirected policy's byte digest, applicable Google group and requested/final decisions", async () => {
  const { createHash } = await import("node:crypto");
  const policy =
    "User-agent: *\r\nAllow: /\r\nUser-agent: Googlebot\r\nDisallow: /private\r\nAllow: /private/public\r\n# original bytes é\r\n";
  const receipt = await acquireRawPage(
    origin + "start",
    origin,
    async (url) => {
      if (url.endsWith("robots.txt"))
        return new Response(null, {
          status: 302,
          headers: { location: "/policy.txt" },
        });
      if (url.endsWith("policy.txt")) return new Response(policy);
      if (url.endsWith("/start"))
        return new Response(null, {
          status: 302,
          headers: { location: "/private" },
        });
      return new Response("<p>fixture</p>", {
        headers: { "content-type": "text/html" },
      });
    },
  );
  const source = receipt.provenance.robotsPolicy;
  expect(source).toMatchObject({
    requestedUrl: origin + "robots.txt",
    finalUrl: origin + "policy.txt",
    status: 200,
    state: "available",
    sha256: createHash("sha256").update(policy).digest("hex"),
    googleGroup: {
      agent: "googlebot",
      rules: [
        { directive: "disallow", pattern: "/private" },
        { directive: "allow", pattern: "/private/public" },
      ],
    },
    requested: { url: origin + "start", allowed: true },
    final: { url: origin + "private", allowed: false },
  });
  expect(source.sha256).not.toBe(receipt.provenance.sha256);
  expect(Number.isFinite(Date.parse(source.acquiredAt))).toBe(true);
  const run = evaluateAudit({
    siteOrigin: origin,
    manifest: [origin, origin + "start"],
    pages: [receipt.evidence],
    pageDeclarations: [
      { requestedUrl: origin + "start", indexingIntent: "indexable" },
    ],
    methodologyVersion: "readiness-v2",
  });
  expect(
    run.rules.find((r) => r.ruleId === "D04" && r.scopeKey.endsWith("/start"))
      ?.evidenceRefs,
  ).toContainEqual({
    source: "receipt",
    requestedUrl: origin + "start",
    fields: ["robotsPolicy"],
  });
});

it("over-budget effective policies preserve crawler enforcement but withhold a D04 verdict", async () => {
  for (const policy of [
    "User-agent: Googlebot\n" +
      Array.from({ length: 129 }, (_, i) => "Disallow: /p" + i).join("\n"),
    "User-agent: Googlebot\nDisallow: /" + "x".repeat(10000),
  ]) {
    const receipt = await acquireRawPage(origin, origin, async (url) =>
      url.endsWith("robots.txt")
        ? new Response(policy)
        : new Response("<p>fixture</p>", {
            headers: { "content-type": "text/html" },
          }),
    );
    expect(receipt.evidence.acquired).toBe(true);
    expect(receipt.evidence.robotsGoogleAllowed).toBeUndefined();
    expect(receipt.provenance.robotsPolicy).toMatchObject({
      state: "evidence-limited",
      final: { url: origin, allowed: true },
    });
    expect(receipt.provenance.robotsPolicy.googleGroup).toBeUndefined();
    expect(
      replayGoogleRobots(receipt.provenance.robotsPolicy, origin),
    ).toBeUndefined();
    expect(JSON.stringify(receipt.provenance.robotsPolicy).length).toBeLessThan(
      1500,
    );
  }
});
it("archives only the effective group, preserves encoded rules, and replays with the same parser", async () => {
  const text =
    "User-agent: *\nDisallow: /" +
    "x".repeat(9000) +
    "\nUser-agent: Googlebot\nDisallow: /%70rivate\nUser-agent: other\nDisallow: /unrelated-secret\nUser-agent: Googlebot\nAllow: /private/public";
  const receipt = await acquireRawPage(
    origin + "private",
    origin,
    async (url) =>
      url.endsWith("robots.txt")
        ? new Response(text)
        : new Response("<p>fixture</p>", {
            headers: { "content-type": "text/html" },
          }),
  );
  expect(receipt.provenance.robotsPolicy).toMatchObject({
    state: "available",
    googleGroup: {
      agent: "googlebot",
      rules: [
        { directive: "disallow", pattern: "/%70rivate" },
        { directive: "allow", pattern: "/private/public" },
      ],
    },
  });
  const frozen = JSON.parse(JSON.stringify(receipt.provenance.robotsPolicy));
  expect(replayGoogleRobots(frozen, origin + "private")).toBe(false);
  expect(replayGoogleRobots(frozen, origin + "private/public")).toBe(true);
  expect(JSON.stringify(frozen)).not.toContain("unrelated-secret");
});
it("malformed UTF-8 policy keeps its byte digest and cannot grant permission", async () => {
  const { createHash } = await import("node:crypto");
  const bytes = new Uint8Array([255]);
  const receipt = await acquireRawPage(origin, origin, async (url) => {
    expect(url).toBe(origin + "robots.txt");
    return new Response(bytes);
  });
  expect(receipt.evidence.acquired).toBe(false);
  expect(receipt.provenance.robotsPolicy).toMatchObject({
    state: "indeterminate",
    status: 200,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(
    replayGoogleRobots(receipt.provenance.robotsPolicy, origin),
  ).toBeUndefined();
});
