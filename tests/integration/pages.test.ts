import { afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  registerPage,
  listPages,
  readPage,
  changePage,
} from "../../packages/db/src/pages";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl),
  scope = { workspaceId: "a", siteId: "a-site" };
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$disconnect();
});
it("registers stable exact URL identities without merging regional, query or trailing-slash pages; GET is read-only", async () => {
  expect((await listPages(db, actor, scope)).pages).toEqual([]);
  const page = await registerPage(
    db,
    actor,
    scope,
    "https://example.com/en?region=us#intro",
  );
  expect(
    (
      await registerPage(
        db,
        actor,
        scope,
        "https://example.com/en?region=us#other",
      )
    ).id,
  ).toBe(page.id);
  expect(page.originalUrl).toContain("#intro");
  for (const url of [
    "https://example.com/en?region=uk",
    "https://example.com/fr?region=us",
    "https://example.com/en/?region=us",
  ])
    expect((await registerPage(db, actor, scope, url)).id).not.toBe(page.id);
  expect((await listPages(db, actor, scope)).pages).toHaveLength(4);
  expect((await readPage(db, actor, scope, page.id)).page.normalizedUrl).toBe(
    "https://example.com/en?region=us",
  );
  await expect(
    registerPage(db, actor, scope, "https://other.com/en"),
  ).rejects.toThrow("INVALID_URL");
  await expect(
    registerPage(db, actor, scope, "http://example.com/en"),
  ).rejects.toThrow("INVALID_URL");
});
it("reopens immutable journal entries, deduplicates retries, fences stale writes and freezes linked draft revision", async () => {
  const page = await registerPage(db, actor, scope, "https://example.com/");
  await admin.contentDraft.create({
    data: { id: "draft", ...scope, kind: "draft", snapshot: {} },
  });
  await admin.contentRevision.create({
    data: {
      workspaceId: "a",
      draftId: "draft",
      revision: 1,
      userId: "owner",
      content: { title: "frozen", body: "text" },
    },
  });
  const change = {
    action: "change" as const,
    pageId: page.id,
    expectedRevision: 1,
    idempotencyKey: "once",
    note: "Keep this entered text",
    contentDraftId: "draft",
  };
  const saved = await changePage(db, actor, scope, change);
  expect((await changePage(db, actor, scope, change)).entry.id).toBe(
    saved.entry.id,
  );
  await expect(
    changePage(db, actor, scope, { ...change, idempotencyKey: "new" }),
  ).rejects.toThrow("REVISION_CONFLICT");
  await expect(
    changePage(db, actor, scope, { ...change, note: "forged retry" }),
  ).rejects.toThrow("REVISION_CONFLICT");
  await admin.contentDraft.update({
    where: { id: "draft" },
    data: { revision: 2 },
  });
  await admin.contentRevision.create({
    data: {
      workspaceId: "a",
      draftId: "draft",
      revision: 2,
      userId: "owner",
      content: { title: "new" },
    },
  });
  const reopened = await readPage(db, actor, scope, page.id);
  expect(reopened.history).toHaveLength(1);
  expect(reopened.history[0]).toMatchObject({
    note: change.note,
    userId: "owner",
    contentDraftRevision: 1,
    revision: 2,
  });
  expect(reopened.drafts[0].history.map((h) => h.revision)).toEqual([1]);
  await expect(
    db.pageJournal.update({
      where: { id: saved.entry.id },
      data: { note: "rewrite" },
    }),
  ).rejects.toThrow();
  await expect(
    db.pageIdentity.update({
      where: { id: page.id },
      data: { normalizedUrl: "https://example.com/forged" },
    }),
  ).rejects.toThrow();
  expect(await db.pageIdentity.findMany()).toEqual([]);
});
it("checks two tenants, same-tenant site grants, viewer writes, forged draft linkage and assignment revocation", async () => {
  const page = await registerPage(db, actor, scope, "https://example.com/");
  const input = {
    action: "change" as const,
    pageId: page.id,
    expectedRevision: 1,
    idempotencyKey: "x",
    note: "note",
    contentDraftId: "forged",
  };
  await expect(changePage(db, actor, scope, input)).rejects.toThrow(
    "INVALID_DRAFT",
  );
  await admin.contentDraft.create({
    data: {
      id: "foreign",
      workspaceId: "b",
      siteId: "b-site",
      kind: "draft",
      snapshot: {},
    },
  });
  await expect(
    changePage(db, actor, scope, { ...input, contentDraftId: "foreign" }),
  ).rejects.toThrow("INVALID_DRAFT");
  await expect(
    readPage(
      db,
      { ...actor, userId: "other" },
      { workspaceId: "b", siteId: "b-site" },
      page.id,
    ),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    readPage(db, actor, { workspaceId: "b", siteId: "b-site" }, page.id),
  ).rejects.toThrow("NOT_FOUND");
  const viewer = { ...actor, userId: "viewer" };
  expect((await readPage(db, viewer, scope, page.id)).actor.canEdit).toBe(
    false,
  );
  await expect(
    registerPage(db, viewer, scope, "https://example.com/new"),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    changePage(db, viewer, scope, {
      action: "claim",
      pageId: page.id,
      expectedRevision: 1,
      idempotencyKey: "claim",
    }),
  ).rejects.toThrow("FORBIDDEN");
  await admin.membership.update({
    where: { workspaceId_userId: { workspaceId: "a", userId: "viewer" } },
    data: { role: "EDITOR" },
  });
  const claim = await changePage(db, viewer, scope, {
    action: "claim",
    pageId: page.id,
    expectedRevision: 1,
    idempotencyKey: "claim",
  });
  expect(claim.page.assignedTo).toBe("viewer");
  await expect(
    changePage(db, actor, scope, {
      action: "unassign",
      pageId: page.id,
      expectedRevision: 2,
      idempotencyKey: "steal",
    }),
  ).rejects.toThrow("REVISION_CONFLICT");
  await admin.siteGrant.deleteMany({ where: { userId: "viewer" } });
  await expect(readPage(db, viewer, scope, page.id)).rejects.toThrow(
    "FORBIDDEN",
  );
  await expect(
    changePage(db, viewer, scope, {
      action: "unassign",
      pageId: page.id,
      expectedRevision: 2,
      idempotencyKey: "unassign",
    }),
  ).rejects.toThrow("FORBIDDEN");
  await admin.siteGrant.create({ data: { ...scope, userId: "viewer" } });
  expect(
    (
      await changePage(db, viewer, scope, {
        action: "unassign",
        pageId: page.id,
        expectedRevision: 2,
        idempotencyKey: "unassign",
      })
    ).page.assignedTo,
  ).toBeNull();
  await admin.membership.update({
    where: { workspaceId_userId: { workspaceId: "a", userId: "other" } },
    data: { role: "EDITOR" },
  });
  await expect(
    listPages(db, { ...actor, userId: "other" }, scope),
  ).rejects.toThrow("FORBIDDEN");
});
it("returns at most five exact requested-page audits, retained UNKNOWN evidence without raw HTML, matching reports and bounded Search Console rows", async () => {
  const url = "https://example.com/en?region=us",
    page = await registerPage(db, actor, scope, url);
  for (let i = 0; i < 7; i++) {
    const id = `audit-${i}`;
    await admin.auditRun.create({
      data: {
        id,
        ...scope,
        userId: "owner",
        securityVersion: 0,
        idempotencyKey: id,
        inputHash: "hash",
        manifest: [url, "https://example.com/fr"],
        profile: "raw-http",
        declarations: {},
        methodologyVersion: "readiness-v1",
        status: "COMPLETED",
        evaluation: {
          rules: [
            {
              ruleId: "D01",
              reasonCode: "HTTP_UNAVAILABLE",
              scopeKey: url,
              outcome: "UNKNOWN",
            },
            { scopeKey: "https://example.com/fr", outcome: "FAIL" },
          ],
        },
        createdAt: new Date(Date.now() + i),
      },
    });
    await admin.auditPage.create({
      data: {
        workspaceId: "a",
        auditId: id,
        requestedUrl: url,
        evidence: {
          requestedUrl: url,
          acquired: false,
          rawHtml: "never expose",
        },
        provenance: { rawHtml: "expired", nested: { rawHtml: "secret" } },
        createdAt: new Date(Date.now() - 31 * 86400000),
      },
    });
  }
  await admin.evidenceReport.create({
    data: {
      ...scope,
      id: "matching",
      title: "Matching",
      snapshot: {
        sources: [{ kind: "raw-http-audit", data: { pages: [{ url }] } }],
      },
      pdf: Buffer.from("x"),
      csv: "",
    },
  });
  await admin.evidenceReport.create({
    data: {
      ...scope,
      id: "unrelated",
      title: "Unrelated",
      snapshot: {
        sources: [
          {
            kind: "raw-http-audit",
            data: { pages: [{ url: "https://example.com/fr" }] },
          },
        ],
      },
      pdf: Buffer.from("x"),
      csv: "",
    },
  });
  await admin.searchSnapshot.create({
    data: {
      ...scope,
      property: "https://example.com/",
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      shape: "page",
      status: "complete",
      rows: [
        { keys: [url], clicks: 1, impressions: 200, position: 5, ctr: 0.005 },
        {
          keys: [url + "&other=1"],
          clicks: 1,
          impressions: 200,
          position: 5,
          ctr: 0.005,
        },
      ],
    },
  });
  const result = await readPage(db, actor, scope, page.id);
  expect(result.audits).toHaveLength(5);
  expect(result.audits[0].findings).toEqual([
    {
      ruleId: "D01",
      reasonCode: "HTTP_UNAVAILABLE",
      scopeKey: url,
      outcome: "UNKNOWN",
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("rawHtml");
  expect(result.reports.map((r) => r.id)).toEqual(["matching"]);
  expect(result.search.opportunities).toHaveLength(1);
  expect(result.search.opportunities[0].page).toBe(url);
  expect(result.search.snapshots[0].rows).toHaveLength(1);
  expect(result.ai.scope).toBe("site");
});
it("bounds registration and history while rejecting oversized UTF-8 journal input", async () => {
  const page = await registerPage(db, actor, scope, "https://example.com/");
  await expect(
    changePage(db, actor, scope, {
      action: "change",
      pageId: page.id,
      expectedRevision: 1,
      idempotencyKey: "oversize",
      note: "a".repeat(4001),
    }),
  ).rejects.toThrow("INVALID_CHANGE");
  await admin.pageIdentity.createMany({
    data: Array.from({ length: 499 }, (_, i) => ({
      ...scope,
      normalizedUrl: `https://example.com/${i}`,
      originalUrl: `https://example.com/${i}`,
      createdBy: "owner",
    })),
  });
  expect((await listPages(db, actor, scope)).pages).toHaveLength(100);
  await expect(
    registerPage(db, actor, scope, "https://example.com/over-limit"),
  ).rejects.toThrow("PAGE_LIMIT");
  expect(
    (await registerPage(db, actor, scope, "https://example.com/")).id,
  ).toBe(page.id);
  await admin.pageJournal.createMany({
    data: Array.from({ length: 105 }, (_, i) => ({
      ...scope,
      pageId: page.id,
      revision: i + 2,
      action: "change",
      note: `change ${i}`,
      userId: "owner",
      idempotencyKey: `key-${i}`,
      inputHash: "hash",
    })),
  });
  const read = await readPage(db, actor, scope, page.id);
  expect(read.history).toHaveLength(100);
  expect(read.history[0].revision).toBe(106);
});
