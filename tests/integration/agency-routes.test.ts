import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";
const seam = vi.hoisted(() => ({
  actor: {} as typeof actor,
  email: "tester@example.com",
}));
const db = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl),
  origin = "http://127.0.0.1:3011";
vi.mock("@/server/auth/server", () => ({
  resolveActor: async () => seam.actor,
  resolveActorWithVerifiedEmail: async () => ({
    actor: seam.actor,
    email: seam.email,
  }),
  database: () => db,
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3011" }),
}));
import {
  GET as teamGet,
  POST as teamPost,
} from "../../apps/lyraseo-web/src/app/api/team/route";
import { POST as invitePost } from "../../apps/lyraseo-web/src/app/api/team/invitations/route";
import { POST as acceptPost } from "../../apps/lyraseo-web/src/app/api/team/accept/route";
import { POST as brandingPost } from "../../apps/lyraseo-web/src/app/api/branding/route";
import { POST as batchQuote } from "../../apps/lyraseo-web/src/app/api/agency/batches/quote/route";
import { POST as batchConfirm } from "../../apps/lyraseo-web/src/app/api/agency/batches/confirm/route";
import {
  GET as assignmentsGet,
  POST as assignmentsPost,
} from "../../apps/lyraseo-web/src/app/api/assignments/route";
function post(path: string, input: unknown, requestOrigin = origin) {
  return new Request(origin + path, {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  seam.actor = actor;
  seam.email = "tester@example.com";
  vi.stubEnv(
    "LYRA_INVITATION_HMAC_KEY",
    "fixture-only-test-secret-at-least32bytes",
  );
  vi.stubEnv("LYRA_ENABLED_CAPABILITIES", "agency,context");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await admin.$disconnect();
});
it("actual team handlers reject forged actor fields, foreign origins and viewer management", async () => {
  const body = {
    workspaceId: "a",
    action: "grant",
    siteId: "a-site",
    userId: "other",
    expectedAccessRevision: 0,
  };
  expect(
    (await teamPost(post("/api/team", { ...body, actor: { role: "OWNER" } })))
      .status,
  ).toBe(409);
  expect(
    (await teamPost(post("/api/team", body, "https://foreign.invalid"))).status,
  ).toBe(403);
  seam.actor = { ...actor, userId: "viewer" };
  expect(
    (await teamGet(new Request(origin + "/api/team?workspaceId=a"))).status,
  ).toBe(404);
  expect((await teamPost(post("/api/team", body))).status).toBe(404);
  seam.actor = actor;
  const response = await teamPost(post("/api/team", body));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("invitation acceptance ignores browser email and uses the server-verified recipient", async () => {
  const response = await invitePost(
    post("/api/team/invitations", {
      workspaceId: "a",
      action: "invite",
      email: seam.email,
      role: "VIEWER",
      siteIds: ["a-site"],
      expectedAccessRevision: 0,
    }),
  );
  expect(response.status).toBe(200);
  const invite = await response.json();
  await admin.productUser.create({ data: { id: "recipient" } });
  seam.actor = { ...actor, userId: "recipient" };
  const input = {
    workspaceId: "a",
    invitationId: invite.id,
    token: invite.token,
  };
  expect(
    (
      await acceptPost(
        post("/api/team/accept", { ...input, email: "browser@example.com" }),
      )
    ).status,
  ).toBe(409);
  seam.email = "wrong@example.com";
  expect((await acceptPost(post("/api/team/accept", input))).status).toBe(404);
  seam.email = "tester@example.com";
  expect((await acceptPost(post("/api/team/accept", input))).status).toBe(200);
});
it("branding rejects actual multipart overflow before decode and preserves current revision", async () => {
  const form = new FormData();
  form.set("workspaceId", "a");
  form.set("displayName", "Should not save");
  form.set("expectedRevision", "0");
  form.set(
    "logo",
    new File([new Uint8Array(600000)], "huge.png", { type: "image/png" }),
  );
  const encoded = new Request(origin + "/api/branding", {
    method: "POST",
    headers: { origin },
    body: form,
  });
  // Model bytes already sent over HTTP. Undici's synthetic multipart producer can
  // enqueue after cancellation; that is not the incoming server request stream.
  const bytes = await encoded.arrayBuffer();
  const response = await brandingPost(
    new Request(encoded.url, {
      method: "POST",
      headers: encoded.headers,
      body: bytes,
    }),
  );
  expect(response.status).toBe(409);
  expect(await admin.workspaceBrandingRevision.count()).toBe(0);
});
it("paused agency admissions stay unavailable while safe grant revocation works", async () => {
  vi.stubEnv("LYRA_ENABLED_CAPABILITIES", "");
  expect(
    (
      await batchQuote(
        post("/api/agency/batches/quote", {
          workspaceId: "a",
          items: [{ siteId: "a-site", kind: "GENERATION", input: {} }],
        }),
      )
    ).status,
  ).toBe(503);
  expect(
    (
      await invitePost(
        post("/api/team/invitations", {
          workspaceId: "a",
          action: "invite",
          email: seam.email,
          role: "VIEWER",
          siteIds: [],
          expectedAccessRevision: 0,
        }),
      )
    ).status,
  ).toBe(503);
  expect(
    (
      await teamPost(
        post("/api/team", {
          workspaceId: "a",
          action: "revoke",
          siteId: "a-site",
          userId: "viewer",
          expectedAccessRevision: 0,
        }),
      )
    ).status,
  ).toBe(200);
  expect(await admin.operation.count()).toBe(0);
});

it("batch handlers reject customer prices and return an actionable expired quote", async () => {
  const input = {
    workspaceId: "a",
    items: [{ siteId: "a-site", kind: "GENERATION", input: {} }],
  };
  expect(
    (
      await batchQuote(
        post("/api/agency/batches/quote", {
          ...input,
          maximumCost: "0",
          budgetOwnerId: "other",
        }),
      )
    ).status,
  ).toBe(409);
  const response = await batchQuote(post("/api/agency/batches/quote", input));
  expect(response.status).toBe(200);
  const quote = await response.json();
  await admin.agencyBatchQuote.update({
    where: { id: quote.batchQuoteId },
    data: {
      createdAt: new Date(Date.now() - 600000),
      expiresAt: new Date(Date.now() - 300000),
    },
  });
  const expired = await batchConfirm(
    post("/api/agency/batches/confirm", {
      batchQuoteId: quote.batchQuoteId,
      confirmationHash: quote.confirmationHash,
      idempotencyKey: "expired",
    }),
  );
  expect(expired.status).toBe(409);
  expect((await expired.json()).error).toContain(
    "Preview the selected scope again",
  );
  expect(await admin.operation.count()).toBe(0);
});

it("never invokes the logo decoder for viewers or foreign workspace callers", async () => {
  const sanitizer =
    await import("../../apps/lyraseo-web/src/server/branding/sanitize");
  const spy = vi
    .spyOn(sanitizer, "sanitizeBrandLogo")
    .mockRejectedValue(Error("DECODER_SHOULD_NOT_RUN"));
  const { default: sharp } =
    await import("../../apps/lyraseo-web/node_modules/sharp");
  const png = await sharp({
    create: { width: 1, height: 1, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  async function imagePost(workspaceId: string) {
    const form = new FormData();
    form.set("workspaceId", workspaceId);
    form.set("expectedRevision", "0");
    form.set("displayName", "Denied");
    form.set(
      "logo",
      new File([new Uint8Array(png)], "fixture.png", { type: "image/png" }),
    );
    const encoded = new Request(origin + "/api/branding", {
      method: "POST",
      headers: { origin },
      body: form,
    });
    return brandingPost(
      new Request(encoded.url, {
        method: "POST",
        headers: encoded.headers,
        body: await encoded.arrayBuffer(),
      }),
    );
  }
  try {
    seam.actor = { ...actor, userId: "viewer" };
    expect.soft((await imagePost("a")).status).toBe(404);
    expect.soft(spy).not.toHaveBeenCalled();
    await admin.workspace.create({
      data: {
        id: "foreign",
        name: "Foreign",
        memberships: { create: { userId: "other", role: "OWNER" } },
      },
    });
    seam.actor = actor;
    expect.soft((await imagePost("foreign")).status).toBe(404);
    expect.soft(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it("exact assignment handlers display and revise the oldest of101 saved identities", async () => {
  const scope = { workspaceId: "a", siteId: "a-site" };
  const rules = Array.from({ length: 101 }, (_, i) => ({
    ruleId: `rule-${i}`,
    scopeKey: `https://example.com/?page=${i}`,
    outcome: "FAIL",
  }));
  await admin.auditRun.create({
    data: {
      id: "handler-many",
      ...scope,
      userId: "owner",
      securityVersion: 0,
      idempotencyKey: "handler-many",
      inputHash: "fixture",
      manifest: [],
      profile: "raw-http",
      declarations: {},
      methodologyVersion: "fixture",
      status: "COMPLETED",
      evaluation: { rules },
    },
  });
  await admin.issueAssignment.createMany({
    data: rules.map((rule, i) => ({
      id: `handler-${i}`,
      ...scope,
      auditId: "handler-many",
      ruleId: rule.ruleId,
      scopeKey: rule.scopeKey,
      assigneeUserId: "other",
      revision: 1,
      updatedAt: new Date(Date.now() + i),
    })),
  });
  const identity = {
    ...scope,
    auditId: "handler-many",
    ruleId: rules[0].ruleId,
    scopeKey: rules[0].scopeKey,
  };
  const response = await assignmentsGet(
    new Request(origin + "/api/assignments?" + new URLSearchParams(identity)),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: "handler-0",
    revision: 1,
    assigneeUserId: "other",
  });
  expect(
    (
      await assignmentsGet(
        new Request(
          origin +
            "/api/assignments?workspaceId=a&siteId=a-site&auditId=handler-many&ruleId=rule-0",
        ),
      )
    ).status,
  ).toBe(409);
  const change = await assignmentsPost(
    post("/api/assignments", {
      ...identity,
      assigneeUserId: "owner",
      expectedRevision: 1,
      idempotencyKey: "oldest-handler",
    }),
  );
  expect(change.status).toBe(200);
  expect(await change.json()).toMatchObject({
    revision: 2,
    assigneeUserId: "owner",
  });
  seam.actor = { ...actor, userId: "viewer" };
  expect(
    (
      await assignmentsGet(
        new Request(
          origin + "/api/assignments?" + new URLSearchParams(identity),
        ),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await assignmentsPost(
        post("/api/assignments", {
          ...identity,
          assigneeUserId: "other",
          expectedRevision: 2,
          idempotencyKey: "viewer-denied",
        }),
      )
    ).status,
  ).toBe(404);
});

it("rechecks manager access after decode before saving a branding revision", async () => {
  const sanitizer =
      await import("../../apps/lyraseo-web/src/server/branding/sanitize"),
    { default: sharp } =
      await import("../../apps/lyraseo-web/node_modules/sharp"),
    { createHash } = await import("node:crypto");
  const png = await sharp({
    create: { width: 1, height: 1, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const spy = vi
    .spyOn(sanitizer, "sanitizeBrandLogo")
    .mockImplementation(async () => {
      await admin.membership.delete({
        where: { workspaceId_userId: { workspaceId: "a", userId: "owner" } },
      });
      return {
        bytes: png,
        mime: "image/png",
        width: 1,
        height: 1,
        sha256: createHash("sha256").update(png).digest("hex"),
      };
    });
  try {
    const form = new FormData();
    form.set("workspaceId", "a");
    form.set("expectedRevision", "0");
    form.set("displayName", "Revoked while decoding");
    form.set(
      "logo",
      new File([new Uint8Array(png)], "fixture.png", { type: "image/png" }),
    );
    const encoded = new Request(origin + "/api/branding", {
      method: "POST",
      headers: { origin },
      body: form,
    });
    const response = await brandingPost(
      new Request(encoded.url, {
        method: "POST",
        headers: encoded.headers,
        body: await encoded.arrayBuffer(),
      }),
    );
    expect(response.status).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await admin.workspaceBrandingRevision.count()).toBe(0);
  } finally {
    spy.mockRestore();
  }
});
