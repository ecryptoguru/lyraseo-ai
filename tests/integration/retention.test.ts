import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
import {
  addMonthsClamped,
  fixedDays,
  readable,
} from "../../packages/db/src/retention";
import {
  readAuditRun,
  readAuditSource,
  compareAuditRuns,
  listAuditRuns,
} from "../../packages/db/src/audits";
import {
  createContentDraft,
  readContentDrafts,
  previewEvidenceReport,
  captureEvidenceReport,
  storeEvidenceReport,
  saveContentDraft,
  setRevisionPin,
} from "../../packages/db/src/content";
import {
  registerPage,
  changePage,
  readPage,
} from "../../packages/db/src/pages";
import {
  createApiToken,
  resolveApiToken,
  tokenAccessPolicyHash,
} from "../../packages/db/src/tokens";
import { readGoogleSearch, disconnectGoogle } from "../../packages/db/src/gsc";
const admin = createDatabase(adminUrl),
  db = createDatabase(runtimeUrl),
  scope = { workspaceId: "a", siteId: "a-site" };
const url = "https://example.com/",
  marker = "RAW_JSON_LD_" + "private".repeat(900),
  authored = "A deliberately authored citation.";
const seams = vi.hoisted(() => ({
  actor: null as unknown,
  db: null as unknown,
}));
vi.mock("@/server/auth/server", () => ({
  resolveActor: async () => seams.actor,
  database: () => seams.db,
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://localhost:3000" }),
}));
import * as audits from "../../apps/lyraseo-web/src/app/api/audits/route";
import * as reports from "../../apps/lyraseo-web/src/app/api/reports/route";
import * as content from "../../apps/lyraseo-web/src/app/api/content/route";
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  seams.actor = actor;
  seams.db = db;
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
const get = (query: string) =>
  new Request("http://localhost:3000/api?workspaceId=a&siteId=a-site&" + query);
const post = (input: Record<string, unknown>) =>
  new Request("http://localhost:3000/api", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...scope, ...input }),
  });
function auditData(id: string, createdAt: Date) {
  return {
    id,
    ...scope,
    userId: actor.userId,
    securityVersion: 0,
    idempotencyKey: id,
    inputHash: "hash",
    manifest: [url],
    profile: "LOCAL_RAW_V1",
    declarations: {},
    methodologyVersion: "readiness-v2",
    status: "COMPLETED",
    createdAt,
    evaluation: {
      manifest: [url],
      methodologyVersion: "readiness-v2",
      eligible: false,
      score: null,
      coverage: 0,
      categoryScores: {},
      rules: [
        {
          ruleId: "D01",
          scopeKey: url,
          outcome: "UNKNOWN",
          category: "discovery",
          priority: "high",
          reasonCode: "MISSING_EVIDENCE",
          unsafe: { jsonLd: [marker] },
        },
      ],
    },
  };
}
it("matches PG generated UTC clocks across month ends, leap years and unrelated timezones", async () => {
  await admin.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/Los_Angeles'");
    for (const [i, iso] of [
      "2024-10-31T16:01:02.123Z",
      "2025-03-31T01:45:03.001Z",
      "2023-01-31T23:59:59.999Z",
      "2024-02-29T12:00:00.000Z",
    ].entries()) {
      const d = new Date(iso),
        run = await tx.auditRun.create({ data: auditData("clock-" + i, d) });
      expect(run.resultExpiresAt).toEqual(addMonthsClamped(d, 13));
      expect(
        [-1, 0, 1].map((ms) =>
          readable(new Date(+run.resultExpiresAt + ms), run.resultExpiresAt),
        ),
      ).toEqual([true, false, false]);
    }
    const status = {
      ...scope,
      property: "p",
      streamId: "s",
      timeZone: "UTC",
      origin: url,
      startDate: "2024-01-01",
      endDate: "2024-01-02",
      shape: "fixture",
      generation: 1,
      status: "failed",
      startedAt: new Date("2024-10-31T12:00:00Z"),
      importedAt: new Date("2025-10-31T12:00:00Z"),
      leaseUntil: new Date(),
      attempt: "fixture",
    };
    expect(
      (await tx.analyticsImport.create({ data: { ...status, id: "failed" } }))
        .resultExpiresAt,
    ).toEqual(addMonthsClamped(status.startedAt, 13));
    expect(
      (
        await tx.analyticsImport.create({
          data: { ...status, id: "terminal", status: "partial" },
        })
      ).resultExpiresAt,
    ).toEqual(addMonthsClamped(status.importedAt, 13));
    expect(
      (
        await tx.analyticsImport.create({
          data: {
            ...status,
            id: "missing",
            status: "complete",
            importedAt: null,
          },
        })
      ).resultExpiresAt,
    ).toBeNull();
  });
});
it("separates immutable compact audit facts from the single authorized original UTF8 attachment, through handlers and both comparison inputs", async () => {
  const now = new Date(),
    original = "\uFEFF<html>" + marker + "</html>";
  const current = await admin.auditRun.create({
    data: auditData("current", fixedDays(now, -40)),
  });
  const expired = await admin.auditRun.create({
    data: auditData("expired", new Date("2020-01-01Z")),
  });
  const scopeOf = (id: string) => ({ ...scope, auditId: id });
  for (const [id, clock] of [
    ["live", now.toISOString()],
    ["aged", fixedDays(now, -31).toISOString()],
    ["bad", "2024-02-30T00:00:00Z"],
    ["future", "2999-11-02T00:00:00Z"],
  ]) {
    await admin.auditPage.create({
      data: {
        id,
        workspaceId: "a",
        auditId: current.id,
        requestedUrl: url + id,
        evidence: { acquired: true, jsonLd: [marker], visibleText: marker },
        provenance: {
          acquiredAt: clock,
          rawHtml: original,
          headers: { unsafe: marker },
        },
      },
    });
  }
  const raw = await audits.GET(
    get(
      "auditId=current&format=source&url=" + encodeURIComponent(url + "live"),
    ),
  );
  expect(raw.status).toBe(200);
  expect(raw.headers.get("content-type")).toContain("text/plain");
  expect(raw.headers.get("content-disposition")).toContain("attachment");
  expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
  expect(raw.headers.get("cache-control")).toBe("private, no-store");
  expect(Buffer.from(await raw.arrayBuffer())).toEqual(Buffer.from(original));
  const bearerRequest = new Request(
    get(
      "auditId=current&format=source&url=" + encodeURIComponent(url + "live"),
    ),
    { headers: { Authorization: "Bearer inaccessible" } },
  );
  expect((await audits.GET(bearerRequest)).status).toBe(404);
  for (const id of ["aged", "bad", "future"]) {
    expect(
      (
        await audits.GET(
          get(
            "auditId=current&format=source&url=" + encodeURIComponent(url + id),
          ),
        )
      ).status,
    ).toBe(410);
  }
  const detail = await readAuditRun(db, actor, scopeOf(current.id));
  expect(JSON.stringify(detail)).not.toContain(marker);
  expect(detail.pages.map((p) => p.sourceAvailability).sort()).toEqual([
    "current",
    "expired",
    "unknown-clock",
    "unknown-clock",
  ]);
  const clock = await admin.auditPageRetention.findUniqueOrThrow({
    where: { pageId: "live" },
  });
  expect(clock.rawExpiresAt).toEqual(fixedDays(now, 30));
  expect((await listAuditRuns(db, actor, scope)).map((x) => x.id)).toEqual([
    "current",
  ]);
  for (const [a, b] of [
    [current, expired],
    [expired, current],
  ])
    await expect(
      compareAuditRuns(db, actor, scopeOf(a.id), b.id),
    ).rejects.toThrow("SOURCE_EXPIRED");
  await expect(
    readAuditRun(db, actor, {
      workspaceId: "b",
      siteId: "b-site",
      auditId: expired.id,
    }),
  ).rejects.toThrow("NOT_FOUND");
  const csv = await audits.GET(get("auditId=current&format=csv"));
  expect(await csv.text()).not.toContain(marker);
  const saved = await reports.POST(
    post({ title: "Compact audit", auditIds: [current.id] }),
  );
  expect(saved.status).toBe(201);
  const id = (await saved.json()).id;
  const report = await admin.evidenceReport.findUniqueOrThrow({
    where: { id },
  });
  expect(report.evidenceFormat).toBe("saved-evidence-v2");
  expect(JSON.stringify(report.snapshot)).not.toContain(marker);
  expect(report.csv).not.toContain(marker);
  const output = "output/build-2026-11-02";
  await mkdir(output, { recursive: true });
  await Promise.all([
    writeFile(output + "/retention-source-projection.pdf", report.pdf),
    writeFile(output + "/retention-source-projection.csv", report.csv),
  ]);
  const policy = tokenAccessPolicyHash(["pilot@example.com"]);
  const token = await createApiToken(
    db,
    actor,
    {
      workspaceId: "a",
      name: "reader",
      siteIds: ["a-site"],
      scopes: ["audits:read"],
      requestKey: crypto.randomUUID(),
    },
    policy,
  );
  await expect(
    readAuditSource(
      db,
      await resolveApiToken(db, token.secret, policy),
      scopeOf(current.id),
      url + "live",
      async () => actor,
    ),
  ).rejects.toThrow("FORBIDDEN");
});
it("retains an aged authored head and pinned revision, then closes its journal-linked body after unpin; legacy file bytes and digest stay untouched", async () => {
  const draft = await admin.contentDraft.create({
    data: {
      id: "legacy",
      ...scope,
      kind: "draft",
      snapshot: {
        format: "saved-evidence-v2",
        sources: [
          {
            sourceId: "gsc:source",
            kind: "google-search-console",
            data: {
              id: "source",
              rows: [{ keys: [marker] }],
              metrics: { clicks: 3 },
            },
          },
        ],
      },
    },
  });
  const body = {
    title: "First",
    body: authored,
    assumptions: [],
    citations: [{ sourceId: "gsc:source", note: authored }],
  };
  await admin.contentRevision.create({
    data: {
      workspaceId: "a",
      draftId: draft.id,
      revision: 1,
      userId: actor.userId,
      content: body,
      createdAt: fixedDays(new Date(), -180),
    },
  });
  const page = await registerPage(db, actor, scope, url);
  await changePage(db, actor, scope, {
    action: "change",
    pageId: page.id,
    expectedRevision: 1,
    idempotencyKey: "entry",
    note: "Journal remains",
    contentDraftId: draft.id,
  });
  const pin = (pinned: boolean) =>
    content.POST(
      post({ action: "pin", draftId: draft.id, revision: 1, pinned }),
    );
  expect((await pin(true)).status).toBe(200);
  const head = await saveContentDraft(db, actor, scope, {
    ...body,
    title: "Next",
    draftId: draft.id,
    expectedRevision: 1,
  });
  expect(head.revision).toBe(2);
  const read = () => readContentDrafts(db, actor, scope, draft.id);
  expect((await read())[0]?.history.map((r) => r.revision)).toEqual([2, 1]);
  expect(JSON.stringify(await read())).not.toContain(marker);
  expect(
    (await readPage(db, actor, scope, page.id)).drafts[0]?.history.map(
      (r) => r.revision,
    ),
  ).toEqual([1]);
  seams.actor = { ...actor, userId: "viewer" };
  expect((await pin(false)).status).toBe(404);
  seams.actor = actor;
  expect((await pin(false)).status).toBe(200);
  expect((await read())[0]?.history.map((r) => r.revision)).toEqual([2]);
  const detail = await readPage(db, actor, scope, page.id);
  expect(detail.drafts[0]?.history).toEqual([]);
  expect(detail.history[0]?.note).toBe("Journal remains");
  expect((await pin(true)).status).toBe(410);
  await expect(
    setRevisionPin(
      db,
      actor,
      { workspaceId: "b", siteId: "b-site" },
      draft.id,
      1,
      true,
    ),
  ).rejects.toThrow("NOT_FOUND");
  const old = await admin.evidenceReport.create({
    data: {
      ...scope,
      title: "Legacy",
      snapshot: {
        ...(draft.snapshot as object),
        rawLegacyPadding: "raw".repeat(460000),
      },
      pdf: Buffer.from(marker),
      csv: marker,
    },
  });
  const preview = await previewEvidenceReport(db, actor, scope, old.id);
  expect(JSON.stringify(preview)).not.toContain(marker);
  expect(preview.downloadStatus).toBe("pending-review");
  expect(preview.snapshot.sources[0]?.data).toMatchObject({
    metrics: { clicks: 3 },
  });
  for (const format of ["csv", "pdf"])
    expect(
      (await reports.GET(get("reportId=" + old.id + "&format=" + format)))
        .status,
    ).toBe(410);
  expect(
    (await admin.evidenceReport.findUniqueOrThrow({ where: { id: old.id } }))
      .pdf,
  ).toEqual(old.pdf);
});
it("retains deliberate GSC summaries and citations after disconnect, and rejects saving an artifact when its source disappears during rendering", async () => {
  const data = {
    id: "src",
    ...scope,
    property: url,
    startDate: "2025-01-01",
    endDate: "2025-01-02",
    shape: "query",
    status: "partial",
    rows: [{ keys: [marker], clicks: 2, impressions: 5 }],
    importedAt: fixedDays(new Date(), -45),
  };
  await admin.searchSnapshot.create({ data });
  const input = {
    kind: "draft" as const,
    title: "Cited",
    body: authored,
    assumptions: [],
    citations: [{ sourceId: "gsc:src", note: authored }],
    auditIds: [],
    searchSnapshotIds: ["src"],
  };
  const draft = await createContentDraft(db, actor, scope, input),
    capture = await captureEvidenceReport(db, actor, scope, input);
  await expect(
    storeEvidenceReport(db, actor, scope, {
      title: "Racing save",
      snapshot: capture,
      render: async () => {
        await disconnectGoogle(db, actor, scope);
        return { pdf: new Uint8Array(), csv: "test" };
      },
    }),
  ).rejects.toThrow("SOURCE_EXPIRED");
  expect(await admin.evidenceReport.count()).toBe(0);
  const read = () => readContentDrafts(db, actor, scope, draft.id);
  expect((await read())[0]?.sourceAvailability).toEqual([
    { sourceId: "gsc:src", status: "disconnected" },
  ]);
  await admin.searchSnapshot.create({
    data: { ...data, importedAt: new Date() },
  });
  const [saved] = await read();
  expect(saved.sourceAvailability?.[0]?.status).toBe("unavailable");
  expect(JSON.stringify(saved)).not.toContain(marker);
  expect(JSON.stringify(saved)).toContain(authored);
  expect(saved.snapshot?.sources[0]?.data).toMatchObject({
    metrics: { clicks: 2, impressions: 5 },
    importedAt: data.importedAt.toISOString(),
  });
  expect(await readGoogleSearch(db, actor, scope)).toMatchObject({
    snapshots: [{ id: "src" }],
  });
});

it("withholds compact results when the database site grant is revoked during the read", async () => {
  await admin.auditRun.create({ data: auditData("grant", new Date()) });
  const concurrent = db.$extends({
    query: {
      auditRun: {
        async findMany({ args, query }) {
          const rows = await query(args);
          await admin.siteGrant.deleteMany({
            where: { siteId: scope.siteId, userId: "viewer" },
          });
          return rows;
        },
      },
    },
  });
  await expect(
    listAuditRuns(
      concurrent as unknown as typeof db,
      { ...actor, userId: "viewer" },
      scope,
    ),
  ).rejects.toThrow("FORBIDDEN");
});

it.each(["draft-anchor", "report-anchor", "draft-result"])(
  "rolls back publication when %s expires during the final insert",
  async (boundary) => {
    const instant = new Date(),
      deadline = fixedDays(instant, 1);
    const parent = await admin.auditRun.create({
      data: auditData(
        "boundary",
        boundary === "draft-result" ? new Date(0) : instant,
      ),
    });
    const after =
      boundary === "draft-result" ? parent.resultExpiresAt : deadline;
    const observed =
      boundary === "draft-result"
        ? new Date(+after - 86400000)
        : fixedDays(deadline, -30);
    await admin.auditPage.createMany({
      data: [
        {
          id: "from",
          workspaceId: "a",
          auditId: parent.id,
          requestedUrl: url,
          evidence: {
            acquired: true,
            linkNames: [{ name: "Selected anchor", href: url + "b" }],
          },
          provenance: { acquiredAt: observed.toISOString() },
        },
        {
          id: "to",
          workspaceId: "a",
          auditId: parent.id,
          requestedUrl: url + "b",
          evidence: { acquired: true },
          provenance: { acquiredAt: observed.toISOString() },
        },
      ],
    });
    const extended = db.$extends({
      query: {
        $allModels: {
          $allOperations: async ({ model, operation, args, query }) => {
            const result = await query(args);
            if (
              operation === "create" &&
              model ===
                (boundary === "report-anchor"
                  ? "EvidenceReport"
                  : "ContentRevision")
            )
              vi.setSystemTime(after);
            return result;
          },
        },
      },
    }) as unknown as typeof db;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(+after - 1));
    try {
      const selection = { auditIds: [parent.id], searchSnapshotIds: [] };
      const capture = await captureEvidenceReport(
        extended,
        actor,
        scope,
        selection,
      );
      if (boundary !== "draft-result")
        expect(capture.internalLinks).toHaveLength(1);
      const save =
        boundary === "report-anchor"
          ? storeEvidenceReport(extended, actor, scope, {
              title: "Race",
              snapshot: capture,
              render: async () => ({ pdf: new Uint8Array(), csv: "fixture" }),
            })
          : createContentDraft(extended, actor, scope, {
              ...selection,
              kind: "draft",
              title: "Race",
              body: "Authored",
              assumptions: [],
              citations: [],
            });
      await expect(save).rejects.toThrow("SOURCE_EXPIRED");
      expect(
        (await admin.contentDraft.count()) +
          (await admin.contentRevision.count()) +
          (await admin.evidenceReport.count()),
      ).toBe(0);
      if (boundary === "report-anchor") {
        const facts = await captureEvidenceReport(db, actor, scope, selection);
        expect(facts.internalLinks).toEqual([]);
        expect(
          await storeEvidenceReport(db, actor, scope, {
            title: "Facts",
            snapshot: facts,
            render: async () => ({ pdf: new Uint8Array(), csv: "fixture" }),
          }),
        ).toHaveProperty("id");
      }
    } finally {
      vi.useRealTimers();
    }
  },
);
it("can read and unpin an aged oldest pin beyond 100 eligible revisions through the scoped HTTP handler", async () => {
  const d = await admin.contentDraft.create({
    data: { ...scope, id: "paged", kind: "draft", snapshot: {}, revision: 103 },
  });
  await admin.contentRevision.createMany({
    data: Array.from({ length: 103 }, (_, i) => ({
      workspaceId: "a",
      draftId: d.id,
      revision: i + 1,
      userId: "owner",
      content: { title: "Revision " + (i + 1), body: authored },
      createdAt: i ? new Date() : fixedDays(new Date(), -91),
    })),
  });
  await admin.contentRevisionPin.create({
    data: { workspaceId: "a", draftId: d.id, revision: 1, pinnedBy: "owner" },
  });
  const [first] = await (await content.GET(get("draftId=paged"))).json();
  expect(first.history).toHaveLength(100);
  expect(first.nextHistoryBefore).toBe(4);
  const [older] = await (
    await content.GET(
      get("draftId=paged&beforeRevision=" + first.nextHistoryBefore),
    )
  ).json();
  expect(older.history.map((r: { revision: number }) => r.revision)).toEqual([
    3, 2, 1,
  ]);
  expect(older.history[2].pin).toBeTruthy();
  expect(
    (
      await content.POST(
        post({ action: "pin", draftId: d.id, revision: 1, pinned: false }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await (await content.GET(get("draftId=paged&beforeRevision=4"))).json()
    )[0].history.map((r: { revision: number }) => r.revision),
  ).toEqual([3, 2]);
});
it("projects the SQL result before transfer while preserving legacy audit kinds and independent metrics", async () => {
  const now = new Date(),
    old = new Date(0);
  for (const [id, at] of [
    ["current", now],
    ["expired", old],
  ] as const)
    await admin.auditRun.create({ data: auditData(id, at) });
  const large = "opaque-large-member".repeat(90000),
    s = {
      scope,
      capturedAt: now.toISOString(),
      methodology: "historical",
      sources: [
        ...(
          [
            ["current", now],
            ["expired", old],
          ] as const
        ).map(([id, at]) => ({
          sourceId: "audit:" + id,
          kind: "raw-http",
          data: {
            id,
            createdAt: at.toISOString(),
            manifest: [url, { opaque: large }],
            evaluation: { score: 42, coverage: 0.5, rules: [] },
            pages: [
              {
                id: "page",
                url,
                receipt: {
                  status: 200,
                  opaque: large,
                  robotsPolicy: { state: "available", unknown: large },
                },
              },
              { url: url + "about" },
            ],
          },
        })),
        {
          sourceId: "gsc:missing",
          kind: "google-search-console",
          data: { metrics: { clicks: 2, impressions: { opaque: large } } },
        },
      ],
      internalLinks: [
        {
          sourceUrl: url,
          url: url + "about",
          anchorText: "Observed",
          basis: "audit:current; historical",
          opaque: large,
        },
      ],
    };
  const row = await admin.evidenceReport.create({
    data: {
      ...scope,
      title: "Original",
      snapshot: s,
      pdf: Buffer.from("original"),
      csv: "legacy",
    },
  });
  let sqlSize = 0;
  const restricted = db.$extends({
    query: {
      $queryRaw: async ({ args, query }) => {
        const result = await query(args);
        if (Array.isArray(result) && result[0]?.value) {
          sqlSize = Buffer.byteLength(JSON.stringify(result));
          expect(JSON.stringify(result)).not.toContain("opaque-large-member");
        }
        return result;
      },
    },
  }) as unknown as typeof db;
  const preview = await previewEvidenceReport(restricted, actor, scope, row.id);
  expect(sqlSize).toBeGreaterThan(0);
  expect(sqlSize).toBeLessThan(8192);
  expect(preview.sourceAvailability).toMatchObject([
    { status: "current" },
    { status: "expired" },
    { status: "disconnected" },
  ]);
  expect(preview.snapshot.sources[0]).toMatchObject({
    kind: "raw-http",
    data: {
      evaluation: { score: 42 },
      pages: [{ receipt: { status: 200 } }, {}],
    },
  });
  expect(preview.snapshot.sources[2].data).toMatchObject({
    metrics: { clicks: 2 },
  });
  expect(
    (await admin.evidenceReport.findUniqueOrThrow({ where: { id: row.id } }))
      .pdf,
  ).toEqual(row.pdf);
});
it("round trips canonical whitespace-clipped evidence through draft verification and immutable report capture", async () => {
  const data = auditData("budget", new Date());
  const rules = Array.from({ length: 5 }, (_, i) => ({
    ...data.evaluation.rules[0],
    ruleId: "D0" + (i + 1),
    evidence: i === 4 ? "y".repeat(47) + "\u2002more" : "😀".repeat(500),
  }));
  await admin.auditRun.create({
    data: { ...data, evaluation: { ...data.evaluation, rules } },
  });
  const selection = { auditIds: [data.id], searchSnapshotIds: [] },
    snapshot = await captureEvidenceReport(db, actor, scope, selection);
  const draft = await createContentDraft(db, actor, scope, {
    ...selection,
    kind: "draft",
    title: "Unicode",
    body: authored,
    assumptions: [],
    citations: [],
  });
  const [loaded] = await readContentDrafts(db, actor, scope, draft.id);
  expect(loaded.snapshot?.sources).toEqual(snapshot.sources);
  const stored = await storeEvidenceReport(db, actor, scope, {
    title: "Unicode",
    snapshot,
    render: async () => ({
      pdf: new Uint8Array([37, 80, 68, 70]),
      csv: "fixture",
    }),
  });
  expect(
    (await previewEvidenceReport(db, actor, scope, stored.id)).snapshot.sources,
  ).toEqual(snapshot.sources);
});

it("previews a genuine readiness-v1 D03 long canonical with a bounded excerpt and one recorded shortening", async () => {
  const { evaluateAuditV1 } =
    await import("../../packages/visibility/src/score-v1");
  const canonical = url + "c".repeat(600 - url.length);
  const evaluation = evaluateAuditV1({
    siteOrigin: url,
    methodologyVersion: "readiness-v1",
    manifest: [url],
    pages: [
      {
        requestedUrl: url,
        finalUrl: url,
        acquired: true,
        headComplete: true,
        bodyComplete: false,
        titleElements: [],
        headingLevels: [],
        h1Texts: [],
        canonicalUrls: [canonical],
        linkNames: [],
        jsonLd: [],
      },
    ],
  });
  const d03 = evaluation.rules.find((r) => r.ruleId === "D03")!;
  expect(d03).toMatchObject({
    reasonCode: "CANONICAL_NEEDS_REVIEW",
    evidence: canonical,
  });
  const makeSource = (id: string, measured: unknown) => ({
    kind: "raw-http-audit",
    sourceId: "audit:" + id,
    data: { id, methodologyVersion: "readiness-v1", evaluation: measured },
  });
  const oversized = "WITHHELD_DIAGNOSTIC_" + "🦉".repeat(3000);
  const snapshot = {
    scope,
    sources: [
      makeSource("genuine", evaluation),
      makeSource("mixed", {
        rules: [
          d03,
          { ...d03, evidence: oversized },
          { ...d03, evidence: { raw: "MALFORMED_FIELD" } },
        ],
      }),
    ],
  };
  const original = await admin.evidenceReport.create({
    data: {
      ...scope,
      title: "Legacy canonical",
      snapshot: JSON.parse(JSON.stringify(snapshot)),
      pdf: Buffer.from("immutable original"),
      csv: "historical bytes",
    },
  });
  let sqlBytes = 0;
  seams.db = db.$extends({
    query: {
      $queryRaw: async ({ args, query }) => {
        const result = await query(args);
        if (Array.isArray(result) && result[0]?.value) {
          const serialized = JSON.stringify(result);
          sqlBytes = Buffer.byteLength(serialized);
          expect(serialized).not.toContain("WITHHELD_DIAGNOSTIC_");
          expect(serialized).not.toContain("MALFORMED_FIELD");
        }
        return result;
      },
    },
  });
  const response = await reports.GET(
    get("reportId=" + original.id + "&format=preview"),
  );
  expect(response.status).toBe(200);
  const { snapshot: preview } = await response.json(),
    [genuine, mixed] = preview.sources;
  expect(sqlBytes).toBeGreaterThan(0);
  expect(sqlBytes).toBeLessThan(16000);
  expect(
    genuine.data.evaluation.rules.find(
      (r: { ruleId: string }) => r.ruleId === "D03",
    ),
  ).toMatchObject({ ...d03, evidence: canonical.slice(0, 512) });
  expect(genuine.data).toMatchObject({
    methodologyVersion: "readiness-v1",
    truncatedExcerpts: 1,
    evaluation: {
      truncatedExcerpts: 1,
      score: evaluation.score,
      coverage: evaluation.coverage,
    },
  });
  expect(mixed.data).toMatchObject({
    truncatedExcerpts: 3,
    evaluation: { truncatedExcerpts: 3 },
  });
  expect(mixed.data.evaluation.rules[1]).not.toHaveProperty("evidence");
  expect(mixed.data.evaluation.rules[2]).not.toHaveProperty("evidence");
  const stored = await admin.evidenceReport.findUniqueOrThrow({
    where: { id: original.id },
  });
  expect(stored.snapshot).toEqual(original.snapshot);
  expect(stored.pdf).toEqual(original.pdf);
  expect(stored.csv).toBe(original.csv);
});
it.each(["rule-limit", "summary-limit"])(
  "counts historical diagnostics excluded by the legacy SQL %s without inventing excerpts",
  async (limit) => {
    const summary = limit === "summary-limit",
      scopeKey = summary ? url + "s".repeat(1800) : url;
    const rules = Array.from({ length: 601 }, (_, i) => ({
      ruleId: "D03",
      scopeKey,
      outcome: "WARNING",
      priority: "medium",
      category: "discovery",
      reasonCode: "CANONICAL_NEEDS_REVIEW",
      ...([0, 600].includes(i) ? { evidence: "original diagnostic" } : {}),
    }));
    const row = await admin.evidenceReport.create({
      data: {
        ...scope,
        title: "Historical count",
        snapshot: {
          scope,
          sources: [
            {
              sourceId: "audit:old",
              kind: "raw-http",
              data: {
                id: "old",
                evaluation: { score: 42, rules, sqlWithheldExcerpts: 9999 },
              },
            },
          ],
        },
        pdf: Buffer.from("original"),
        csv: "test",
      },
    });
    const response = await reports.GET(
      get("reportId=" + row.id + "&format=preview"),
    );
    expect(response.status).toBe(200);
    const preview = await response.json(),
      data = preview.snapshot.sources[0].data;
    expect(data).toMatchObject({
      truncatedExcerpts: summary ? 2 : 1,
      evaluation: {
        truncatedExcerpts: summary ? 2 : 1,
        score: 42,
        ruleCount: 601,
        omittedRules: summary ? 601 : 1,
      },
    });
    expect(data.evaluation.rules).toHaveLength(summary ? 0 : 600);
  },
);
