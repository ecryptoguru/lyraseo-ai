import { afterAll, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src";
import {
  admin,
  staff,
  recon,
  intake,
  q,
  fixture,
  snapshot,
  apply,
} from "../helpers/sandbox-billing-review";
let current: unknown;
const name = process.env.LYRA_SANDBOX_BILLING_TEST_DB!;
const client = createDatabase(
  `postgresql://lyraseo_staff_executor:local_staff_executor_only@127.0.0.1:54329/${name}`,
);
vi.mock("@/server/admin/staff", () => ({
  requireStaffFor: async () => current,
  staffDatabase: () => client,
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3013" }),
}));
import { GET, POST } from "../../apps/lyraseo-web/src/app/api/admin/route";
afterAll(() => client.$disconnect());
it("R2 actual Deliveries endpoint authorizes, redacts and observes unresolved→routed evidence", async () => {
  const f = await fixture();
  await admin.query(
    'INSERT INTO "StaffGrant"("userId",enabled) VALUES($1,true)',
    [f.id],
  );
  current = f.a;
  const receipt = await q(intake, "record_event", [
    {
      mode: "SANDBOX",
      provider: "RAZORPAY",
      merchantId: f.id,
      externalId: crypto.randomUUID(),
      payloadHash: "d".repeat(64),
      keyVersion: "fixture",
      contract: "fixture",
      type: "refund.processed",
      resourceId: `delivery_${f.id}`,
      customerId: f.customer,
      references: { paymentId: `later_${f.id}` },
      occurredAt: new Date().toISOString(),
    },
  ]);
  let hex = (BigInt("0x" + receipt.id.replaceAll("-", "")) - 1n)
    .toString(16)
    .padStart(32, "0");
  const cursor = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
  const request = () =>
    new Request(
      `http://127.0.0.1:3013/api/admin?view=deliveries&cursor=${cursor}`,
    );
  const first = await GET(request());
  expect(first.status).toBe(200);
  const view = await first.json();
  expect(view.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: receipt.id,
        state: "PENDING",
        last_error: "ACCOUNT_BOUND_REFERENCE_DISCOVERY_REQUIRED",
      }),
    ]),
  );
  expect(JSON.stringify(view)).not.toMatch(
    /payload_hash|references_json|Authorization|token_hash|encrypted/,
  );
  const canonical = snapshot(f);
  canonical.paymentReference = `later_${f.id}`;
  canonical.effects[0].reference = canonical.paymentReference;
  await apply(f, canonical);
  expect(await q(recon, "resolve_pending", [receipt.id])).toMatchObject({
    state: "ROUTED",
  });
  const second = await GET(request());
  expect(second.status).toBe(200);
  expect((await second.json()).rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: receipt.id,
        state: "ROUTED",
        last_error: null,
      }),
    ]),
  );
  await admin.query('UPDATE "StaffGrant" SET enabled=false WHERE "userId"=$1', [
    f.id,
  ]);
  const denied = await GET(request());
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain(receipt.id);
});

const legacyPost = (body: unknown) =>
  POST(
    new Request("http://127.0.0.1:3013/api/admin", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3013",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
async function legacyFixture() {
  const f = await fixture();
  await admin.query(
    'INSERT INTO "StaffGrant"("userId",enabled) VALUES($1,true)',
    [f.id],
  );
  await admin.query(
    "INSERT INTO lyraseo_billing.staff_capability(user_id,action) VALUES($1,'recovery:manage')",
    [f.id],
  );
  current = f.a;
  return f;
}
it("R3 actual old-client API cannot bypass a lost committed request even after session replacement", async () => {
  const f = await legacyFixture();
  const requestId = crypto.randomUUID();
  const oldToken = "R3-preissued-old-client-token-route-valid";
  await q(staff, "issue_step_up", [f.a, "recovery:open", f.id, oldToken]);
  await q(staff, "prepare_request", [
    f.a,
    requestId,
    "recovery:open",
    f.id,
    "{}",
    "R3 lost committed response",
  ]);
  const oldBody = {
    kind: "action",
    action: "recovery:open",
    target: f.id,
    token: oldToken,
    args: {},
    reason: "preissued token must not bypass pending",
  };
  expect((await legacyPost(oldBody)).status).toBe(403);
  await expect(
    q(staff, "staff_action", [
      f.a,
      "recovery:open",
      f.id,
      oldToken,
      "{}",
      oldBody.reason,
    ]),
  ).rejects.toThrow("UNRESOLVED_STAFF_REQUEST");
  await q(staff, "execute_request", [f.a, requestId]);
  const rotated = { ...f.a, sessionId: "rotated_" + f.id };
  await admin.query(
    'INSERT INTO "ProductSession"("sessionId","userId","securityVersion","createdAt","refreshedAt") VALUES($1,$2,0,now(),now())',
    [rotated.sessionId, f.id],
  );
  current = rotated;
  expect((await legacyPost(oldBody)).status).toBe(403);
  const step = await legacyPost({
    kind: "step-up",
    action: "recovery:open",
    target: f.id,
  });
  expect(step.status).toBe(403);
  await expect(
    q(staff, "issue_step_up", [
      rotated,
      "recovery:open",
      f.id,
      "R3-direct-old-client-token",
    ]),
  ).rejects.toThrow("UNRESOLVED_STAFF_REQUEST");
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.recovery_case WHERE opened_by=$1",
        [f.id],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("R3 parallel old-client actions share lifecycle and recover one original result after lost ACK", async () => {
  const f = await legacyFixture();
  const one = await legacyPost({
      kind: "step-up",
      action: "recovery:open",
      target: f.id,
    }),
    two = await legacyPost({
      kind: "step-up",
      action: "recovery:open",
      target: f.id,
    });
  const tokens = [(await one.json()).token, (await two.json()).token];
  const bodies = tokens.map((token) => ({
    kind: "action",
    action: "recovery:open",
    target: f.id,
    token,
    args: {},
    reason: "R3 old client lost acknowledgement",
  }));
  const replies = await Promise.all(bodies.map(legacyPost));
  expect(replies.map((x) => x.status).sort()).toEqual([200, 403]);
  const winning = replies.findIndex((x) => x.status === 200),
    result = await replies[winning].json();
  expect(result.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(result.resultHash).toMatch(/^[a-f0-9]{64}$/);
  const retried = await legacyPost(bodies[winning]);
  expect(await retried.json()).toEqual(result);
  await expect(
    q(staff, "prepare_request", [
      f.a,
      crypto.randomUUID(),
      "recovery:open",
      f.id,
      "{}",
      "parallel new client",
    ]),
  ).rejects.toThrow("UNRESOLVED_STAFF_REQUEST");
  const acknowledged = await legacyPost({
    kind: "ack-request",
    requestId: result.requestId,
    resultHash: result.resultHash,
  });
  expect(acknowledged.status).toBe(200);
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.recovery_case WHERE opened_by=$1",
        [f.id],
      )
    ).rows[0].n,
  ).toBe(1);
});

it.each([0, 1])(
  "R4 lost legacy result with invalid raw digest %i resolves and acknowledges through the replacement session API",
  async (index) => {
    const f = await legacyFixture();
    // SHA-256 prefixes have version/variant 9/b and 5/7 respectively.
    const token = "R4-controlled-legacy-step-up-token-" + index;
    await q(staff, "issue_step_up", [f.a, "recovery:open", f.id, token]);
    const body = {
      kind: "action",
      action: "recovery:open",
      target: f.id,
      args: {},
      token,
      reason: "Recover the original legacy action",
    };
    expect((await legacyPost(body)).status).toBe(200); // Discard the committed response.
    const rotated = { ...f.a, sessionId: "replacement_" + f.id };
    await admin.query(
      'INSERT INTO "ProductSession"("sessionId","userId","securityVersion","createdAt","refreshedAt") VALUES($1,$2,0,now(),now())',
      [rotated.sessionId, f.id],
    );
    current = rotated;
    const pending = await GET(
      new Request("http://127.0.0.1:3013/api/admin?view=recovery"),
    );
    expect(pending.status).toBe(200);
    const { pendingRequests } = await pending.json();
    expect(pendingRequests).toHaveLength(1);
    const { requestId } = pendingRequests[0];
    const resolve = await legacyPost({
      kind: "resolve-request",
      requestId,
      choice: "STATUS",
    });
    expect(resolve.status).toBe(200);
    const resolved = await resolve.json();
    expect(resolved).toMatchObject({
      requestId,
      requestState: "COMMITTED",
      committed: true,
      result: { state: "VERIFYING" },
    });
    expect(
      (await legacyPost({ ...body, reason: "This changes the frozen payload" }))
        .status,
    ).toBe(403);
    const retry = await legacyPost(body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      ...resolved.result,
      requestId,
      resultHash: resolved.resultHash,
    });
    const step = { kind: "step-up", action: "recovery:open", target: f.id };
    expect((await legacyPost(step)).status).toBe(403);
    const ack = await legacyPost({
      kind: "ack-request",
      requestId,
      resultHash: resolved.resultHash,
    });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({
      requestState: "ACKNOWLEDGED",
      requestId,
    });
    expect((await legacyPost(step)).status).toBe(200);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM lyraseo_billing.recovery_case WHERE opened_by=$1",
          [f.id],
        )
      ).rows[0].n,
    ).toBe(1);
  },
);

it("R4 legacy POST reports stale revision, keeps the guard until abandonment and rejects replay of the abandoned action", async () => {
  const f = await legacyFixture();
  const open = { action: "recovery:open", target: f.id };
  const step = await legacyPost({ kind: "step-up", ...open });
  const opened = await legacyPost({
    kind: "action",
    ...open,
    token: (await step.json()).token,
    args: {},
    reason: "Open controlled revision fixture",
  });
  expect(opened.status).toBe(200);
  const row = await opened.json();
  // Prepare a case for this conflict test independently of the separate UUID route regression.
  await q(staff, "ack_request", [f.a, row.requestId, row.resultHash]);
  const deny = { action: "recovery:deny", target: row.id };
  const up = await legacyPost({ kind: "step-up", ...deny });
  const body = {
    kind: "action",
    ...deny,
    token: (await up.json()).token,
    args: { expectedRevision: row.revision + 1 },
    reason: "Attempt stale revision decision",
  };
  const rejected = await legacyPost(body);
  expect(rejected.status).toBe(409);
  const outcome = await rejected.json();
  expect(outcome).toMatchObject({
    requestState: "REJECTED",
    committed: false,
    canAbandon: true,
    reason: "TARGET_CONFLICT",
  });
  expect((await legacyPost({ kind: "step-up", ...deny })).status).toBe(403);
  const abandoned = await legacyPost({
    kind: "resolve-request",
    requestId: outcome.requestId,
    choice: "ABANDON",
  });
  expect(abandoned.status).toBe(200);
  const repeated = await legacyPost(body);
  expect(repeated.status).toBe(409);
  expect(await repeated.json()).toMatchObject({
    requestId: outcome.requestId,
    requestState: "ABANDONED",
    committed: false,
    canAbandon: false,
  });
  expect(
    (
      await admin.query(
        "SELECT state,revision FROM lyraseo_billing.recovery_case WHERE id=$1",
        [row.id],
      )
    ).rows[0],
  ).toEqual({ state: "VERIFYING", revision: row.revision });
  expect((await legacyPost({ kind: "step-up", ...deny })).status).toBe(200);
});

it("R4 legacy POST reports authorization expiry after waiting for the token lock", async () => {
  const f = await legacyFixture();
  const action = { action: "recovery:open", target: f.id };
  const up = await legacyPost({ kind: "step-up", ...action });
  const { token } = await up.json();
  const blocker = await admin.connect();
  let post: Promise<Response> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "UPDATE lyraseo_billing.step_up SET expires_at=clock_timestamp() WHERE user_id=$1",
      [f.id],
    );
    post = legacyPost({
      kind: "action",
      ...action,
      token,
      args: {},
      reason: "Expire during controlled lock wait",
    });
    await vi.waitFor(async () => {
      const { rows } = await blocker.query(
        "SELECT EXISTS(SELECT FROM pg_stat_activity a WHERE a.datname=current_database() AND a.usename='lyraseo_staff_executor' AND pg_backend_pid()=ANY(pg_blocking_pids(a.pid))) blocked",
      );
      expect(rows[0].blocked).toBe(true);
    });
    await blocker.query("COMMIT");
    const expired = await post;
    expect(expired.status).toBe(409);
    const result = await expired.json();
    expect(result).toMatchObject({
      requestState: "AUTHORIZATION_EXPIRED",
      committed: false,
      canAbandon: true,
    });
    expect(
      (
        await legacyPost({
          kind: "resolve-request",
          requestId: result.requestId,
          choice: "ABANDON",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM lyraseo_billing.recovery_case WHERE opened_by=$1",
          [f.id],
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await post;
  }
});
