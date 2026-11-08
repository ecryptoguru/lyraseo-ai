import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { previewVisibilityRun } from "../../packages/db/src/visibility";
import type { Actor } from "../../packages/db/src/context";

const name = process.env.LYRA_OBSERVATION_DB;
if (!name || !/^lyraseo_ledger_[a-f0-9]{12}$/.test(name))
  throw Error("OWNED_OBSERVATION_DATABASE_REQUIRED");
const url = (u: string, p: string) =>
  `postgresql://${u}:${p}@127.0.0.1:54329/${name}`;
const admin = createDatabase(url("postgres", "lyraseo_local_only"));
const runtime = createDatabase(url("lyraseo_runtime", "local_runtime_only"));
const now = new Date("2026-11-03T12:00:00.000Z");
const scope = { workspaceId: "preview-w", siteId: "preview-s" };
const actor = (userId: string): Actor => ({
  userId,
  sessionId: `${userId}-session`,
  securityVersion: 0,
  authenticatedAt: now.toISOString(),
  mfaVerified: false,
  authProvider: "supabase",
});
const owner = actor("preview-owner"),
  editor = actor("preview-editor"),
  viewer = actor("preview-viewer"),
  foreign = actor("preview-foreign");
const foreignScope = {
  workspaceId: "preview-other-w",
  siteId: "preview-other-s",
};

beforeAll(async () => {
  await admin.productUser.createMany({
    data: [owner, editor, viewer, foreign].map(({ userId }) => ({
      id: userId,
    })),
  });
  await admin.workspace.create({
    data: { id: scope.workspaceId, name: "Preview" },
  });
  await admin.membership.createMany({
    data: [
      { workspaceId: scope.workspaceId, userId: owner.userId, role: "OWNER" },
      { workspaceId: scope.workspaceId, userId: editor.userId, role: "EDITOR" },
      { workspaceId: scope.workspaceId, userId: viewer.userId, role: "VIEWER" },
    ],
  });
  await admin.site.create({
    data: {
      id: scope.siteId,
      workspaceId: scope.workspaceId,
      origin: "https://preview.invalid",
      verifiedAt: now,
    },
  });
  await admin.siteGrant.create({ data: { ...scope, userId: editor.userId } });
  await admin.workspace.create({
    data: { id: foreignScope.workspaceId, name: "Other" },
  });
  await admin.membership.create({
    data: {
      workspaceId: foreignScope.workspaceId,
      userId: foreign.userId,
      role: "OWNER",
    },
  });
  await admin.site.create({
    data: {
      id: foreignScope.siteId,
      workspaceId: foreignScope.workspaceId,
      origin: "https://other.invalid",
      verifiedAt: now,
    },
  });
  await admin.visibilityPanel.create({
    data: {
      id: "preview-other-panel",
      ...foreignScope,
      version: 1,
      createdBy: foreign.userId,
      reviewedBy: foreign.userId,
      reviewedAt: now,
      prompts: [{ id: "p", text: "Question?", label: "neutral" }],
      brands: [{ id: "b", name: "Beta", aliases: ["Beta"], domains: [] }],
    },
  });
  await admin.visibilityPanel.create({
    data: {
      id: "preview-panel",
      ...scope,
      version: 1,
      createdBy: owner.userId,
      reviewedBy: owner.userId,
      reviewedAt: now,
      prompts: [
        { id: "p1", text: "Which tools?", label: "neutral" },
        { id: "p2", text: "x".repeat(2001), label: "neutral" },
      ],
      brands: [{ id: "brand", name: "Alpha", aliases: ["Alpha"], domains: [] }],
    },
  });
  await admin.budgetPeriod.createMany({
    data: [
      {
        userId: owner.userId,
        period: "2026-11",
        bucket: "COMBINED",
        limit: "10",
        spent: "1",
        reserved: "2",
      },
      {
        userId: owner.userId,
        period: "2026-11",
        bucket: "DATAFORSEO",
        limit: "1",
        spent: "0.2",
        reserved: "0.1",
      },
      {
        userId: owner.userId,
        period: "2026-11",
        bucket: "CHATGPT_OBSERVATION",
        limit: "100",
        spent: "10",
        reserved: "3",
      },
      {
        userId: foreign.userId,
        period: "2026-11",
        bucket: "AZURE",
        limit: "8",
        spent: "9",
        reserved: "0",
      },
    ],
  });
});

it("separates tenants and exposes a recorded allowance overrun without borrowing", async () => {
  await expect(
    previewVisibilityRun(
      runtime,
      owner,
      foreignScope,
      "preview-other-panel",
      "azure-sol-api",
      now,
    ),
  ).rejects.toThrow();
  await expect(
    previewVisibilityRun(
      runtime,
      foreign,
      scope,
      "preview-panel",
      "azure-sol-api",
      now,
    ),
  ).rejects.toThrow();
  const own = await previewVisibilityRun(
    runtime,
    foreign,
    foreignScope,
    "preview-other-panel",
    "azure-sol-api",
    now,
  );
  expect(own.allowance.provider).toMatchObject({
    bucket: "AZURE",
    limit: "8",
    spent: "9",
    remaining: "0",
    overLimit: true,
  });
  expect(own.allowance.combined).toMatchObject({
    bucket: "COMBINED",
    remaining: "10",
    overLimit: false,
  });
});
afterAll(async () => {
  await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
});

it("returns reviewed scope, current personal allowance and no executable quote or dispatch", async () => {
  const network = vi.spyOn(globalThis, "fetch");
  const before = await Promise.all([
    admin.operation.count(),
    admin.operationQuote.count(),
    admin.outboxEvent.count(),
    admin.budgetPeriod.count(),
  ]);
  try {
    const value = await previewVisibilityRun(
      runtime,
      owner,
      scope,
      "preview-panel",
      "consumer-chatgpt",
      now,
    );
    expect(value).toMatchObject({
      available: false,
      panel: { id: "preview-panel", version: 1, promptCount: 2 },
      requested: { profile: "consumer-chatgpt", language: "en", market: "IN" },
      quote: null,
      maximumCost: null,
      cacheStatus: "not-checked",
      verification: "current",
      incompatiblePromptIds: ["p2"],
      allowance: {
        period: "2026-11",
        combined: { limit: "10", spent: "1", reserved: "2", remaining: "7" },
        provider: { bucket: "DATAFORSEO", remaining: "0.7" },
        observations: { bucket: "CHATGPT_OBSERVATION", remaining: "87" },
      },
    });
    expect(network).not.toHaveBeenCalled();
    expect(
      await Promise.all([
        admin.operation.count(),
        admin.operationQuote.count(),
        admin.outboxEvent.count(),
        admin.budgetPeriod.count(),
      ]),
    ).toEqual(before);
  } finally {
    network.mockRestore();
  }
});

it("uses separate profile buckets and reports verification and period boundaries", async () => {
  const azure = await previewVisibilityRun(
    runtime,
    owner,
    scope,
    "preview-panel",
    "azure-sol-api",
    now,
  );
  expect(azure.allowance.provider).toMatchObject({
    bucket: "AZURE",
    limit: "8",
    remaining: "8",
  });
  expect(azure.allowance.observations).toMatchObject({
    bucket: "API_OBSERVATION",
    remaining: "25",
  });
  expect(azure.incompatiblePromptIds).toEqual([]);
  const gemini = await previewVisibilityRun(
    runtime,
    owner,
    scope,
    "preview-panel",
    "consumer-gemini",
    new Date("2026-12-01T00:00:00Z"),
  );
  expect(gemini.verification).toBe("required");
  expect(gemini.allowance).toMatchObject({
    period: "2026-12",
    provider: { bucket: "DATAFORSEO", remaining: "1" },
    observations: { bucket: "GEMINI_OBSERVATION", remaining: "100" },
  });
});

it("matches the site-verification admission boundaries exactly", async () => {
  try {
    for (const [offset, expected] of [
      [-86400000, "current"],
      [-86400001, "required"],
      [30000, "current"],
      [30001, "required"],
    ] as const) {
      await admin.site.update({
        where: { id: scope.siteId },
        data: { verifiedAt: new Date(now.getTime() + offset) },
      });
      expect(
        (
          await previewVisibilityRun(
            runtime,
            owner,
            scope,
            "preview-panel",
            "azure-sol-api",
            now,
          )
        ).verification,
      ).toBe(expected);
    }
  } finally {
    await admin.site.update({
      where: { id: scope.siteId },
      data: { verifiedAt: now },
    });
  }
});

it("rechecks an editor grant when revocation commits during the scope lock wait", async () => {
  let result: Promise<unknown> | undefined;
  await admin.$transaction(
    async (tx) => {
      const [{ pid }] = await tx.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM "Site" WHERE "workspaceId"=${scope.workspaceId} AND id=${scope.siteId} FOR UPDATE`;
      result = previewVisibilityRun(
        runtime,
        editor,
        scope,
        "preview-panel",
        "azure-sol-api",
        now,
      ).then(
        () => "unexpected success",
        (error: Error) => error.message,
      );
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const [row] = await tx.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.datname=current_database() AND ${pid}=ANY(pg_blocking_pids(a.pid))) AS waiting`;
        waiting = row!.waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      await tx.siteGrant.delete({
        where: {
          workspaceId_siteId_userId: { ...scope, userId: editor.userId },
        },
      });
    },
    { timeout: 10000 },
  );
  expect(await result).toBe("FORBIDDEN");
  await admin.siteGrant.create({ data: { ...scope, userId: editor.userId } });
});

it("enforces site scope, editor grant, current epoch, review and revocation", async () => {
  await expect(
    previewVisibilityRun(
      runtime,
      editor,
      scope,
      "preview-panel",
      "azure-sol-api",
      now,
    ),
  ).resolves.toMatchObject({ available: false });
  await expect(
    previewVisibilityRun(
      runtime,
      viewer,
      scope,
      "preview-panel",
      "azure-sol-api",
      now,
    ),
  ).rejects.toThrow();
  await expect(
    previewVisibilityRun(
      runtime,
      { ...owner, securityVersion: 99 },
      scope,
      "preview-panel",
      "azure-sol-api",
      now,
    ),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    previewVisibilityRun(
      runtime,
      owner,
      { ...scope, siteId: "forged" },
      "preview-panel",
      "azure-sol-api",
      now,
    ),
  ).rejects.toThrow();
  await expect(
    previewVisibilityRun(
      runtime,
      owner,
      scope,
      "missing",
      "azure-sol-api",
      now,
    ),
  ).rejects.toThrow("REVIEWED_PANEL_REQUIRED");
  await admin.siteGrant.delete({
    where: { workspaceId_siteId_userId: { ...scope, userId: editor.userId } },
  });
  await expect(
    previewVisibilityRun(
      runtime,
      editor,
      scope,
      "preview-panel",
      "azure-sol-api",
      now,
    ),
  ).rejects.toThrow("FORBIDDEN");
});
