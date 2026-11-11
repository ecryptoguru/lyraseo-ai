import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  acquireRawPage,
  runAuditPage,
  type AcquisitionReceipt,
} from "../../packages/visibility/src/acquisition";
import { compareAudits, evaluateAudit } from "../../packages/visibility/src";
import {
  crawlerContractSite,
  fixtureOrigin as origin,
} from "../fixtures/crawler-contract-site";

let fixture: Awaited<ReturnType<typeof crawlerContractSite>>;
beforeAll(async () => {
  fixture = await crawlerContractSite();
});
afterAll(async () => {
  await fixture.close();
});
const evaluate = (receipts: AcquisitionReceipt[]) => {
  const manifest = [
    ...new Set([origin, ...receipts.map((r) => r.evidence.requestedUrl)]),
  ];
  return evaluateAudit({
    siteOrigin: origin,
    manifest,
    pages: receipts.map((r) => r.evidence),
    pageDeclarations: manifest.map((requestedUrl) => ({
      requestedUrl,
      indexingIntent: "indexable" as const,
    })),
    methodologyVersion: "readiness-v2",
  });
};
// Exact negative sets catch unexpected findings as well as the intended case.
const negatives = (receipt: AcquisitionReceipt) =>
  evaluate([receipt])
    .rules.filter((r) => r.outcome === "FAIL" || r.outcome === "WARNING")
    .map((r) => `${r.ruleId}:${r.outcome}:${r.reasonCode}`)
    .sort();

it.each(["/", "/healthy", "/malformed", "/js-shell"])(
  "keeps healthy/raw-only control %s free of invented rendered findings",
  async (path) => {
    const receipt = await acquireRawPage(
      new URL(path, origin).href,
      origin,
      fixture.transport,
    );
    expect(receipt.provenance.error).toBeUndefined();
    expect(receipt.evidence).toMatchObject({
      acquired: true,
      headComplete: false,
      bodyComplete: false,
    });
    expect(receipt.evidence).not.toHaveProperty("visibleText");
    expect(receipt.evidence).not.toHaveProperty("mainText");
    expect(negatives(receipt)).toEqual([]);
    const evaluation = evaluate([receipt]);
    expect(evaluation.score).toBeNull();
    expect(
      evaluation.rules.find(
        (r) =>
          r.ruleId === "D01" && r.scopeKey === receipt.evidence.requestedUrl,
      ),
    ).toMatchObject({ outcome: "PASS", reasonCode: "HTML_ACQUIRED" });
    for (const id of ["E01", "E02", "E03", "E04", "E05", "A01"])
      expect(
        evaluation.rules.find(
          (r) =>
            r.ruleId === id && r.scopeKey === receipt.evidence.requestedUrl,
        )?.outcome,
      ).toBe("UNKNOWN");
    expect(fixture.requests.some((p) => /canary/.test(p))).toBe(false);
  },
);

it.each([403, 404, 429, 500, 503])(
  "retains HTTP %i as the only expected failure",
  async (status) => {
    const receipt = await acquireRawPage(
      `${origin}status/${status}`,
      origin,
      fixture.transport,
    );
    expect(receipt.provenance).toMatchObject({ error: "HTTP_ERROR", status });
    expect(receipt.evidence).toMatchObject({ status, acquired: false });
    expect(receipt.provenance.rawHtml).toBeUndefined();
    expect(negatives(receipt)).toEqual(["D01:FAIL:HTTP_ERROR"]);
  },
);

it.each([
  ["outside", "REDIRECT_OUTSIDE_ORIGIN"],
  ["downgrade", "REDIRECT_OUTSIDE_ORIGIN"],
  ["metadata", "REDIRECT_OUTSIDE_ORIGIN"],
  ["invalid-target", "REDIRECT_INVALID_LOCATION"],
  ["credential-target", "REDIRECT_INVALID_LOCATION"],
  ["loop-a", "REDIRECT_LOOP"],
  ["into-blocked", "ROBOTS_DISALLOWED"],
  ["chain/6", "REDIRECT_LIMIT"],
] as const)(
  "records %s without requesting a forbidden destination",
  async (path, error) => {
    const first = fixture.requests.length;
    const receipt = await acquireRawPage(
      origin + path,
      origin,
      fixture.transport,
    );
    expect(receipt.provenance.error).toBe(error);
    expect(receipt.provenance.redirects.length).toBeGreaterThan(0);
    expect(receipt.provenance.redirects.length).toBeLessThanOrEqual(5);
    expect(receipt.provenance.finalUrl).toBeUndefined();
    expect(receipt.evidence.acquired).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("fixture-pass");
    expect(negatives(receipt)).toEqual([]);
    expect(fixture.requests.slice(first)).not.toContain("/blocked");
    expect(fixture.requests.slice(first)).not.toContain("/chain/0");
    expect(
      fixture.requests.some((p) => /canary|meta-data|\/plain/.test(p)),
    ).toBe(false);
  },
);

it("allows exactly five redirects and preserves duplicate requested identities", async () => {
  const receipt = await acquireRawPage(
    `${origin}chain/5`,
    origin,
    fixture.transport,
  );
  expect(receipt.provenance.redirects).toEqual(
    Array.from({ length: 5 }, (_, i) => `${origin}chain/${5 - i}`),
  );
  expect(receipt.provenance.finalUrl).toBe(`${origin}chain/0`);
  expect(receipt.evidence.acquired).toBe(true);
  const duplicates = await Promise.all(
    ["duplicate-a", "duplicate-b"].map((path) =>
      acquireRawPage(origin + path, origin, fixture.transport),
    ),
  );
  expect(duplicates.map((r) => r.evidence.requestedUrl)).toEqual([
    `${origin}duplicate-a`,
    `${origin}duplicate-b`,
  ]);
  expect(duplicates.map((r) => r.evidence.finalUrl)).toEqual([
    `${origin}healthy`,
    `${origin}healthy`,
  ]);
  const expectedBody = `<!doctype html><html lang="en"><head><title>Controlled product</title><link rel="canonical" href="${origin}healthy"></head><body><main><h1>Controlled product</h1><p>Healthy source.</p><a href="/about">About</a></main></body></html>`;
  const expectedDigest = createHash("sha256")
    .update(expectedBody)
    .digest("hex");
  for (const duplicate of duplicates) {
    expect(duplicate.evidence.acquired).toBe(true);
    expect(duplicate.provenance.error).toBeUndefined();
    expect(duplicate.provenance.sha256).toBe(expectedDigest);
  }
});

it.each([
  ["unreadable", "BODY_INVALID_UTF8"],
  ["empty", "EMPTY_HTML_BODY"],
  ["encoded", "UNSUPPORTED_CONTENT_ENCODING"],
  ["truncated", "ACQUISITION_FAILED"],
  ["oversized", "BODY_TOO_LARGE"],
] as const)(
  "keeps real HTTP %s unavailable without manufacturing content",
  async (path, error) => {
    let chunked = false;
    const receipt = await acquireRawPage(
      origin + path,
      origin,
      async (url, signal) => {
        const response = await fixture.transport(url, signal);
        if (path === "oversized" && url.endsWith(path))
          chunked =
            response.headers.get("transfer-encoding") === "chunked" &&
            !response.headers.has("content-length");
        return response;
      },
    );
    expect(receipt.provenance.error).toBe(error);
    expect(receipt.evidence.acquired).toBe(false);
    expect(receipt.provenance.rawHtml).toBeUndefined();
    expect(negatives(receipt)).toEqual([]);
    if (path === "oversized") expect(chunked).toBe(true);
  },
);

it("retains conclusive header evidence while withholding rendered canonical conclusions", async () => {
  const receipt = await acquireRawPage(
    `${origin}header-conflict`,
    origin,
    fixture.transport,
  );
  expect(receipt.evidence.canonicalUrls).toEqual([
    `${origin}header-conflict`,
    `${origin}different`,
  ]);
  expect(receipt.provenance.headers).toMatchObject({
    "x-robots-tag": "googlebot: noindex",
  });
  expect(negatives(receipt)).toEqual(["D02:FAIL:NOINDEX_ON_INTENDED_PAGE"]);
  expect(
    evaluate([receipt]).rules.find((r) => r.ruleId === "D03")?.outcome,
  ).toBe("UNKNOWN");
});

it("compares a fixed defect and a newly unreadable page without a false resolved finding", async () => {
  const controlled = await crawlerContractSite();
  try {
    const manifest = [
      origin,
      `${origin}repair`,
      `${origin}removed`,
      `${origin}unreadable`,
    ];
    const capture = async () => {
      const rows: AcquisitionReceipt[] = [];
      for (const url of manifest)
        rows.push(await acquireRawPage(url, origin, controlled.transport));
      return rows;
    };
    const before = await capture();
    controlled.fix();
    const after = await capture();
    const delta = compareAudits(evaluate(before), evaluate(after));
    expect(delta.resolved.map((r) => `${r.ruleId}:${r.scopeKey}`)).toEqual([
      `D01:${origin}repair`,
    ]);
    for (const path of ["removed", "unreadable"])
      expect(delta.unevaluated).toContainEqual(
        expect.objectContaining({
          ruleId: "D01",
          scopeKey: origin + path,
          outcome: "UNKNOWN",
        }),
      );
    const current = evaluate(after);
    for (const path of ["removed", "unreadable"])
      expect(
        current.rules.find(
          (r) => r.ruleId === "D01" && r.scopeKey === origin + path,
        ),
      ).toMatchObject({ outcome: "UNKNOWN", reasonCode: "BODY_UNAVAILABLE" });
    expect(
      current.rules.filter((r) => ["FAIL", "WARNING"].includes(r.outcome)),
    ).toEqual([]);
    expect(JSON.stringify(after)).not.toContain("mainText");
  } finally {
    await controlled.close();
  }
});

it("propagates sponsor cancellation before persistence and releases the pending socket", async () => {
  const controller = new AbortController();
  const persist = vi.fn();
  const running = runAuditPage(
    `${origin}hang`,
    origin,
    fixture.transport,
    persist,
    controller.signal,
  );
  const rejection = expect(running).rejects.toThrow("SPONSOR_REVOKED");
  await fixture.requested("/hang");
  controller.abort(new Error("SPONSOR_REVOKED"));
  await rejection;
  expect(persist).not.toHaveBeenCalled();
});

it("records an internal deadline through real HTTP without treating it as sponsor cancellation", async () => {
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValueOnce(deadline.signal);
  try {
    const controlled = await crawlerContractSite();
    try {
      const running = acquireRawPage(
        `${origin}hang`,
        origin,
        controlled.transport,
      );
      await controlled.requested("/hang");
      deadline.abort(new DOMException("deadline reached", "TimeoutError"));
      const receipt = await running;
      expect(receipt.provenance.error).toBe("ACQUISITION_TIMEOUT");
      expect(receipt.evidence.acquired).toBe(false);
      expect(receipt.provenance.rawHtml).toBeUndefined();
    } finally {
      await controlled.close();
    }
  } finally {
    timeout.mockRestore();
  }
});

it.each([
  [404, undefined, undefined],
  [410, undefined, undefined],
  [403, undefined, "ROBOTS_UNAVAILABLE"],
  [429, undefined, "ROBOTS_UNAVAILABLE"],
  [503, undefined, "ROBOTS_UNAVAILABLE"],
  [200, "<html>login required</html>", "ROBOTS_INDETERMINATE"],
  [
    200,
    "User-agent: *\nDisallow: /" + "x".repeat(2 * 1024 * 1024),
    "BODY_TOO_LARGE",
  ],
] as const)(
  "applies real robots status %i and policy case %# before page access",
  async (robotsStatus, robotsBody, error) => {
    const controlled = await crawlerContractSite({ robotsStatus, robotsBody });
    try {
      const receipt = await acquireRawPage(
        origin,
        origin,
        controlled.transport,
      );
      expect(receipt.provenance.error).toBe(error);
      expect(receipt.evidence.acquired).toBe(error === undefined);
      expect(controlled.requests).toEqual(
        error ? ["/robots.txt"] : ["/robots.txt", "/"],
      );
      expect(negatives(receipt)).toEqual([]);
    } finally {
      await controlled.close();
    }
  },
);
