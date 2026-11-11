import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const { Pool } = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
)("pg") as typeof import("../../packages/db/node_modules/@types/pg");
const name = process.env.LYRA_SANDBOX_BILLING_TEST_DB;
if (!name || !/^lyraseo_billing_[a-f0-9]{12}$/.test(name))
  throw new Error("OWNED_BILLING_DATABASE_REQUIRED");
const pool = (user: string, password: string) =>
  new Pool({
    connectionString: `postgresql://${user}:${password}@127.0.0.1:54329/${name}`,
    max: 5,
  });
const admin = pool("postgres", "lyraseo_local_only"),
  intake = pool("lyraseo_billing_intake", "local_billing_intake_only"),
  reconciler = pool(
    "lyraseo_billing_reconciler",
    "local_billing_reconciler_only",
  ),
  runtime = pool("lyraseo_runtime", "local_runtime_only"),
  staff = pool("lyraseo_staff_executor", "local_staff_executor_only"),
  operator = pool("lyraseo_operator", "local_operator_only");
const actor = (userId = "owner") => ({
  userId,
  sessionId: `session-${userId}`,
  securityVersion: 0,
  authenticatedAt: new Date().toISOString(),
  mfaVerified: true,
  mfaAuthenticatedAt: new Date().toISOString(),
  authProvider: "supabase",
});
// Positive legacy fixtures now supply explicit synthetic canonical proof; raw review
// regressions intentionally bypass this builder to test missing/false/stale evidence.
const query = async (db: Pool, fn: string, args: unknown[]) => {
  if (fn === "record_event") {
    const event = args[0] as Record<string, unknown>;
    const known = (
      await admin.query(
        "SELECT EXISTS(SELECT FROM lyraseo_billing.binding WHERE provider=$1 AND merchant_id=$2 AND resource_id=$3) yes",
        [event.provider, event.merchantId, event.resourceId],
      )
    ).rows[0].yes;
    if (known)
      args[0] = { ...event, references: { subscriptionId: event.resourceId } };
  }
  if (fn === "apply_snapshot") {
    const [job, , , , raw] = args as [
      string,
      number,
      number,
      string,
      Record<string, any>,
    ];
    const row = (
      await admin.query(
        "SELECT i.provider,i.merchant_id,i.resource_id,b.customer_id,b.account_id,s.id intent_id,s.resource_id slot_resource,s.price_id,s.price_version,coalesce(p.source_version,0)::text prior_version FROM lyraseo_billing.inbox i JOIN lyraseo_billing.binding b USING(provider,merchant_id,resource_id) LEFT JOIN lyraseo_billing.base_slot s ON s.account_id=b.account_id LEFT JOIN lyraseo_billing.subscription p ON p.provider=i.provider AND p.merchant_id=i.merchant_id AND p.resource_id=i.resource_id WHERE i.id=$1",
        [job],
      )
    ).rows[0];
    if (
      row.intent_id &&
      !row.slot_resource &&
      row.provider ===
        (
          await admin.query(
            "SELECT provider FROM lyraseo_billing.base_slot WHERE id=$1",
            [row.intent_id],
          )
        ).rows[0]?.provider
    )
      await db.query(
        "SELECT lyraseo_billing.bind_subscription($1::uuid,$2,$3,'SYNTHETIC_EXTERNAL_BINDING_V2',repeat('a',64))",
        [row.intent_id, row.resource_id, row.customer_id],
      );
    const start = raw.periodStart,
      end = raw.periodEnd;
    const syntheticPayment = `fixturepay_${createHash("sha256")
      .update(JSON.stringify([row.resource_id, start, end]))
      .digest("hex")
      .slice(0, 24)}`;
    const effects = (raw.effects as any[]).map((effect) => ({
      ...effect,
      status: "SUCCEEDED",
      resourceId: row.resource_id,
      periodStart: start,
      periodEnd: end,
      evidenceHash: "b".repeat(64),
      sourceContract: "SYNTHETIC_CANONICAL_V2",
    }));
    if (
      raw.paid === true &&
      !effects.some((effect) => effect.kind === "PAYMENT")
    )
      effects.unshift({
        kind: "PAYMENT",
        reference: syntheticPayment,
        parentReference: null,
        amountMinor: "1000",
        currency: raw.currency,
        exponent: raw.exponent,
        status: "SUCCEEDED",
        resourceId: row.resource_id,
        periodStart: start,
        periodEnd: end,
        evidenceHash: "b".repeat(64),
        sourceContract: "SYNTHETIC_CANONICAL_V2",
      });
    // Existing refund fixtures preserve their original successful payment and amount.
    const payment = effects.find((effect) => effect.kind === "PAYMENT");
    args[4] = {
      ...raw,
      externalPriceId: "fixture_price",
      priceMappingVersion: "fixture-v1",
      sourceIdentity: {
        provider: row.provider,
        merchantId: row.merchant_id,
        resourceId: row.resource_id,
        customerId: row.customer_id,
      },
      sourceVersion: {
        qualification: "SYNTHETIC_COMPARABLE_V2",
        value: String(BigInt(row.prior_version) + 1n),
      },
      paymentReference: raw.paid ? payment?.reference : null,
      effects,
    };
  }
  const result = (
    await db.query(
      `SELECT lyraseo_billing.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) AS result`,
      args.map((x) =>
        typeof x === "object" && x !== null ? JSON.stringify(x) : x,
      ),
    )
  ).rows[0].result;
  // Sequential baseline scenarios explicitly acknowledge each observed legacy
  // result. R3 actual-endpoint regressions intentionally omit this client step.
  if (fn === "staff_action" && result.requestId && result.resultHash) {
    await db.query(
      "SELECT lyraseo_billing.ack_request($1::jsonb,$2::uuid,$3::text)",
      [JSON.stringify(args[0]), result.requestId, result.resultHash],
    );
  }
  return result;
};
beforeAll(async () => {
  await admin.query(
    `INSERT INTO "ProductUser"(id) VALUES('owner'),('other'),('staff'),('staff2'); INSERT INTO "Workspace"(id,name) VALUES('billing-a','A'),('billing-b','B'); INSERT INTO "Membership"("workspaceId","userId",role) VALUES('billing-a','owner','OWNER'),('billing-b','other','OWNER'); INSERT INTO "ProductSession"("sessionId","userId","securityVersion","createdAt","refreshedAt") SELECT 'session-'||id,id,0,now(),now() FROM "ProductUser"; INSERT INTO "StaffGrant"("userId",enabled) VALUES('staff',true),('staff2',true); INSERT INTO lyraseo_billing.staff_capability(user_id,action) VALUES('staff','billing:reconcile'),('staff','policy:pause'),('staff','recovery:manage'),('staff2','recovery:manage'); INSERT INTO lyraseo_billing.merchant(provider,merchant_id,mode) VALUES('RAZORPAY','fixture_merchant','SANDBOX'),('POLAR','fixture_org','SANDBOX'); INSERT INTO lyraseo_billing.price_mapping(provider,merchant_id,external_price,version,plan_id,currency,exponent,amount_minor) VALUES('RAZORPAY','fixture_merchant','fixture_price','fixture-v1','fixture-plan','USD',2,1000),('POLAR','fixture_org','fixture_price','fixture-v1','fixture-plan','USD',2,1000);`,
  );
});
afterAll(async () => {
  await Promise.all(
    [admin, intake, reconciler, runtime, staff, operator].map((p) => p.end()),
  );
});
it("reserves one base slot across providers concurrently and checks current owner", async () => {
  const results = await Promise.allSettled([
    query(runtime, "reserve_slot", [
      actor(),
      "billing-a",
      "RAZORPAY",
      "fixture_merchant",
      "fixture_price",
      "fixture-v1",
      "intent-a",
    ]),
    query(runtime, "reserve_slot", [
      actor(),
      "billing-a",
      "POLAR",
      "fixture_org",
      "fixture_price",
      "fixture-v1",
      "intent-b",
    ]),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM lyraseo_billing.base_slot WHERE account_id=(SELECT id FROM lyraseo_billing.account WHERE workspace_id='billing-a')",
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    query(runtime, "reserve_slot", [
      actor("other"),
      "billing-a",
      "POLAR",
      "fixture_org",
      "fixture_price",
      "fixture-v1",
      "intent-bad",
    ]),
  ).rejects.toThrow("FORBIDDEN");
  const slot = (
    await admin.query(
      "SELECT * FROM lyraseo_billing.base_slot WHERE account_id=(SELECT id FROM lyraseo_billing.account WHERE workspace_id='billing-a')",
    )
  ).rows[0];
  await expect(
    query(runtime, "reserve_slot", [
      actor(),
      "billing-a",
      slot.provider,
      slot.merchant_id,
      "fixture_price",
      "fixture-v1",
      slot.idempotency_key,
    ]),
  ).resolves.toMatchObject({ id: slot.id });
});
it("intake retains collisions and new delivery IDs without duplicating economic effects", async () => {
  const account = (
    await admin.query(
      "SELECT id FROM lyraseo_billing.account WHERE workspace_id='billing-a'",
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO lyraseo_billing.binding(provider,merchant_id,resource_id,customer_id,account_id) VALUES('RAZORPAY','fixture_merchant','sub_fixture','cust_fixture',$1)",
    [account],
  );
  const event = {
    mode: "SANDBOX",
    provider: "RAZORPAY",
    merchantId: "fixture_merchant",
    externalId: "evt_fixture",
    payloadHash: "a".repeat(64),
    keyVersion: "fixture-v1",
    type: "subscription.activated",
    resourceId: "sub_fixture",
    customerId: "cust_fixture",
    occurredAt: new Date().toISOString(),
    contract: "fixture-v1",
  };
  expect(await query(intake, "record_event", [event])).toMatchObject({
    outcome: "ACCEPTED",
  });
  expect(await query(intake, "record_event", [event])).toMatchObject({
    outcome: "EXACT_REPLAY",
  });
  expect(
    await query(intake, "record_event", [
      { ...event, payloadHash: "b".repeat(64) },
    ]),
  ).toMatchObject({ outcome: "COLLISION" });
  const receipt = await query(reconciler, "claim", [
    "RAZORPAY",
    "fixture_merchant",
    "sub_fixture",
  ]);
  const snapshot = {
    nativeState: "active",
    state: "ACTIVE",
    planId: "fixture-plan",
    currency: "USD",
    exponent: 2,
    periodStart: new Date(Date.now() - 1000).toISOString(),
    periodEnd: new Date(Date.now() + 86400000).toISOString(),
    paid: true,
    disputed: false,
    effects: [
      {
        kind: "PAYMENT",
        reference: "pay_fixture",
        parentReference: null,
        amountMinor: "123",
        currency: "USD",
        exponent: 2,
      },
    ],
  };
  expect(
    await query(reconciler, "apply_snapshot", [
      receipt.id,
      receipt.fence,
      receipt.generation,
      receipt.token,
      snapshot,
    ]),
  ).toMatchObject({ state: "ACTIVE", productionEntitled: false });
  await query(intake, "record_event", [{ ...event, externalId: "evt_second" }]);
  const second = await query(reconciler, "claim", [
    "RAZORPAY",
    "fixture_merchant",
    "sub_fixture",
  ]);
  await query(reconciler, "apply_snapshot", [
    second.id,
    second.fence,
    second.generation,
    second.token,
    snapshot,
  ]);
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.money_fact WHERE reference='pay_fixture'",
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (await admin.query('SELECT count(*)::int n FROM "UsageReceipt"')).rows[0].n,
  ).toBe(0);
  expect(
    (await admin.query('SELECT count(*)::int n FROM "BudgetPeriod"')).rows[0].n,
  ).toBe(0);
});
it("new arrivals fence an in-flight canonical read and tombstones cannot reopen access", async () => {
  const event = {
    mode: "SANDBOX",
    provider: "RAZORPAY",
    merchantId: "fixture_merchant",
    externalId: "evt_delay",
    payloadHash: "c".repeat(64),
    keyVersion: "fixture-v1",
    type: "subscription.updated",
    resourceId: "sub_fixture",
    customerId: "cust_fixture",
    occurredAt: new Date().toISOString(),
    contract: "fixture-v1",
  };
  await query(intake, "record_event", [event]);
  const old = await query(reconciler, "claim", [
    "RAZORPAY",
    "fixture_merchant",
    "sub_fixture",
  ]);
  await query(intake, "record_event", [{ ...event, externalId: "evt_new" }]);
  const snapshot = {
    nativeState: "active",
    state: "ACTIVE",
    planId: "fixture-plan",
    currency: "USD",
    exponent: 2,
    periodStart: new Date(Date.now() - 1000).toISOString(),
    periodEnd: new Date(Date.now() + 86400000).toISOString(),
    paid: true,
    disputed: false,
    effects: [],
  };
  await expect(
    query(reconciler, "apply_snapshot", [
      old.id,
      old.fence,
      old.generation,
      old.token,
      snapshot,
    ]),
  ).rejects.toThrow("STALE_RECONCILIATION");
  await admin.query(
    'UPDATE "Workspace" SET "deletedAt"=now() WHERE id=\'billing-a\'',
  );
  const fresh = await query(reconciler, "claim", [
    "RAZORPAY",
    "fixture_merchant",
    "sub_fixture",
  ]);
  expect(
    await query(reconciler, "apply_snapshot", [
      fresh.id,
      fresh.fence,
      fresh.generation,
      fresh.token,
      snapshot,
    ]),
  ).toMatchObject({ sandboxEntitled: false });
});
it("restricts table access, write authority, forged customer staff claims and stale MFA", async () => {
  for (const db of [intake, reconciler, runtime, staff])
    await expect(
      db.query("SELECT * FROM lyraseo_billing.event"),
    ).rejects.toThrow();
  await expect(
    query(staff, "staff_view", [actor("owner"), "billing", null, 25]),
  ).rejects.toThrow("STAFF_REQUIRED");
  await expect(
    query(staff, "staff_view", [
      { ...actor("staff"), mfaVerified: false },
      "billing",
      null,
      25,
    ]),
  ).rejects.toThrow("STAFF_REQUIRED");
  const view = await query(staff, "staff_view", [
    actor("staff"),
    "billing",
    null,
    25,
  ]);
  expect(view.mode).toBe("SANDBOX");
  await expect(
    query(runtime, "staff_view", [actor("staff"), "billing", null, 25]),
  ).rejects.toThrow();
});
it("records recovery evidence and enforces independent decisions and minimum72h without factor reset", async () => {
  const create = async (
    who: string,
    action: string,
    target: string,
    args: unknown,
  ) => {
    const a = actor(who),
      token = "fixture-test-" + Math.random();
    await query(staff, "issue_step_up", [a, action, target, token]);
    return query(staff, "staff_action", [
      a,
      action,
      target,
      token,
      JSON.stringify(args),
      "reasoned_fixture_evidence",
    ]);
  };
  const recovery = await create("staff", "recovery:open", "owner", {
    workspaceId: "billing-b",
  });
  const hold = await create("staff", "recovery:hold", recovery.id, {
    expectedRevision: 0,
    evidenceHash: "d".repeat(64),
    noticeReceiptHash: "e".repeat(64),
  });
  expect(hold.state).toBe("HOLD");
  await expect(
    create("staff2", "recovery:approve", recovery.id, { expectedRevision: 1 }),
  ).rejects.toThrow("RECOVERY_HOLD_ACTIVE");
  await expect(
    create("staff", "recovery:approve", recovery.id, { expectedRevision: 1 }),
  ).rejects.toThrow();
  expect(
    (
      await admin.query(
        'SELECT "securityVersion" FROM "ProductUser" WHERE id=\'owner\'',
      )
    ).rows[0].securityVersion,
  ).toBe(0);
  await expect(
    create("staff2", "recovery:complete", recovery.id, { expectedRevision: 1 }),
  ).rejects.toThrow("RECOVERY_PROVIDER_UNAVAILABLE");
});
it("applies a requested pause through the existing kernel exactly once and exposes effective revision", async () => {
  const a = actor("staff"),
    token = "fixture-policy-token-" + Math.random();
  const before = (
    await admin.query(
      "SELECT revision FROM \"RuntimePolicy\" WHERE key='content'",
    )
  ).rows[0].revision;
  await query(staff, "issue_step_up", [a, "policy:pause", "content", token]);
  const args = JSON.stringify({ expectedRevision: before });
  const intent = await query(staff, "staff_action", [
    a,
    "policy:pause",
    "content",
    token,
    args,
    "controlled_fixture_pause",
  ]);
  expect(intent).toMatchObject({ state: "PENDING", effective: false });
  expect(
    await query(staff, "staff_action", [
      a,
      "policy:pause",
      "content",
      token,
      args,
      "controlled_fixture_pause",
    ]),
  ).toEqual(intent);
  await expect(
    query(staff, "staff_action", [
      a,
      "policy:pause",
      "content",
      token,
      JSON.stringify({ expectedRevision: 999 }),
      "controlled_fixture_pause",
    ]),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await expect(query(runtime, "execute_pause", [intent.id])).rejects.toThrow();
  const applied = await Promise.all([
    query(operator, "execute_pause", [intent.id]),
    query(operator, "execute_pause", [intent.id]),
  ]);
  expect(applied.every((row) => row.state === "UNAVAILABLE")).toBe(true);
  expect(
    (
      await admin.query(
        "SELECT revision,enabled FROM \"RuntimePolicy\" WHERE key='content'",
      )
    ).rows[0],
  ).toEqual({ revision: before, enabled: false });
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM \"RuntimePolicyChange\" WHERE key='content'",
      )
    ).rows[0].n,
  ).toBe(0);
});
it("denies a pause if staff is revoked after admission and enforces fresh factor time", async () => {
  const a = actor("staff"),
    token = "fixture-revoked-token-" + Math.random();
  await query(staff, "issue_step_up", [a, "policy:pause", "visibility", token]);
  const intent = await query(staff, "staff_action", [
    a,
    "policy:pause",
    "visibility",
    token,
    JSON.stringify({ expectedRevision: 0 }),
    "controlled_fixture_pause",
  ]);
  await admin.query(
    'UPDATE "StaffGrant" SET enabled=false WHERE "userId"=\'staff\'',
  );
  await expect(query(operator, "execute_pause", [intent.id])).rejects.toThrow(
    "STAFF_REQUIRED",
  );
  await admin.query(
    'UPDATE "StaffGrant" SET enabled=true WHERE "userId"=\'staff\'',
  );
  await expect(
    query(staff, "issue_step_up", [
      { ...a, mfaAuthenticatedAt: new Date(Date.now() - 660000).toISOString() },
      "policy:pause",
      "visibility",
      "fixture-stale-factor-token",
    ]),
  ).rejects.toThrow("FRESH_AUTH_REQUIRED");
});
it("permits a second independent recovery decision after the hold and refuses completion without provider proof", async () => {
  const rows = await admin.query(
    "SELECT id FROM lyraseo_billing.recovery_case WHERE state='HOLD'",
  );
  const id = rows.rows[0].id;
  // Advance the persisted accepted-evidence clock only in the administrator-owned fixture.
  await admin.query(
    "UPDATE lyraseo_billing.recovery_case SET accepted_at=clock_timestamp()-interval '73 hours',hold_until=clock_timestamp()-interval '1 hour' WHERE id=$1",
    [id],
  );
  const a = actor("staff2"),
    token = "fixture-approved-token-" + Math.random();
  await query(staff, "issue_step_up", [a, "recovery:approve", id, token]);
  expect(
    await query(staff, "staff_action", [
      a,
      "recovery:approve",
      id,
      token,
      JSON.stringify({ expectedRevision: 1 }),
      "independent_fixture_decision",
    ]),
  ).toMatchObject({
    state: "APPROVED",
    revision: 2,
    providerState: "UNAVAILABLE",
  });
  expect(
    (
      await admin.query(
        'SELECT "securityVersion" FROM "ProductUser" WHERE id=\'owner\'',
      )
    ).rows[0].securityVersion,
  ).toBe(0);
});
it("keeps exactly one local entitlement when a second external subscription is confirmed", async () => {
  await query(runtime, "reserve_slot", [
    actor("other"),
    "billing-b",
    "POLAR",
    "fixture_org",
    "fixture_price",
    "fixture-v1",
    "intent-b-independent",
  ]);
  const account = (
    await admin.query(
      "SELECT id FROM lyraseo_billing.account WHERE workspace_id='billing-b'",
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO lyraseo_billing.binding(provider,merchant_id,resource_id,customer_id,account_id) VALUES('POLAR','fixture_org','polar_sub_one','polar_customer',$1),('POLAR','fixture_org','polar_sub_two','polar_customer',$1)",
    [account],
  );
  const snapshot = {
    nativeState: "active",
    state: "ACTIVE",
    planId: "fixture-plan",
    currency: "USD",
    exponent: 2,
    periodStart: new Date(Date.now() - 1000).toISOString(),
    periodEnd: new Date(Date.now() + 86400000).toISOString(),
    paid: true,
    disputed: false,
    effects: [],
  };
  const apply = async (resourceId: string) => {
    await query(intake, "record_event", [
      {
        mode: "SANDBOX",
        provider: "POLAR",
        merchantId: "fixture_org",
        externalId: `evt_${resourceId}`,
        payloadHash: "f".repeat(64),
        keyVersion: "fixture-v1",
        type: "subscription.active",
        resourceId,
        customerId: "polar_customer",
        occurredAt: new Date().toISOString(),
        contract: "fixture-v1",
      },
    ]);
    const claim = await query(reconciler, "claim", [
      "POLAR",
      "fixture_org",
      resourceId,
    ]);
    return query(reconciler, "apply_snapshot", [
      claim.id,
      claim.fence,
      claim.generation,
      claim.token,
      snapshot,
    ]);
  };
  expect(await apply("polar_sub_one")).toMatchObject({
    sandboxEntitled: true,
    productionEntitled: false,
  });
  expect(await apply("polar_sub_two")).toMatchObject({
    sandboxEntitled: false,
    reason: "BASE_SLOT_CONFLICT",
  });
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.subscription WHERE account_id=$1 AND sandbox_entitled",
        [account],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("reconciles refunds once without canceling active subscription or touching usage budgets", async () => {
  const resourceId = "polar_sub_one";
  const snapshot = {
    nativeState: "active",
    state: "ACTIVE",
    planId: "fixture-plan",
    currency: "USD",
    exponent: 2,
    periodStart: new Date(Date.now() - 1000).toISOString(),
    periodEnd: new Date(Date.now() + 86400000).toISOString(),
    paid: true,
    disputed: false,
    effects: [
      {
        kind: "PAYMENT",
        reference: "order_polar_one",
        parentReference: null,
        amountMinor: "1250",
        currency: "USD",
        exponent: 2,
      },
      {
        kind: "REFUND",
        reference: "refund_polar_one",
        parentReference: "order_polar_one",
        amountMinor: "250",
        currency: "USD",
        exponent: 2,
      },
    ],
  };
  for (let i = 0; i < 2; i++) {
    await query(intake, "record_event", [
      {
        mode: "SANDBOX",
        provider: "POLAR",
        merchantId: "fixture_org",
        externalId: `evt_refund_${i}`,
        payloadHash: "1".repeat(64),
        keyVersion: "fixture-v1",
        type: "refund.created",
        resourceId,
        customerId: "polar_customer",
        occurredAt: new Date().toISOString(),
        contract: "fixture-v1",
      },
    ]);
    const claim = await query(reconciler, "claim", [
      "POLAR",
      "fixture_org",
      resourceId,
    ]);
    expect(
      await query(reconciler, "apply_snapshot", [
        claim.id,
        claim.fence,
        claim.generation,
        claim.token,
        snapshot,
      ]),
    ).toMatchObject({ state: "ACTIVE", sandboxEntitled: true });
  }
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.money_fact WHERE reference='refund_polar_one' AND kind='REFUND'",
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    admin.query(
      "UPDATE lyraseo_billing.money_fact SET amount_minor=1 WHERE kind='REFUND'",
    ),
  ).rejects.toThrow("IMMUTABLE_BILLING_EVIDENCE");
  expect(
    (await admin.query('SELECT count(*)::int n FROM "UsageReceipt"')).rows[0].n,
  ).toBe(0);
});
it("invalidates pre-revocation intents even after the same staff grant is enabled again", async () => {
  const pending = (
    await admin.query(
      "SELECT id FROM lyraseo_billing.policy_intent WHERE policy_key='visibility' AND state='PENDING'",
    )
  ).rows[0];
  await expect(query(operator, "execute_pause", [pending.id])).rejects.toThrow(
    "STAFF_AUTHORITY_CHANGED",
  );
  expect(
    (
      await admin.query(
        "SELECT revision FROM \"RuntimePolicy\" WHERE key='visibility'",
      )
    ).rows[0].revision,
  ).toBe(0);
});
it("loses neither staff authority nor the pause revision when a revoked grant wins a lock wait", async () => {
  const a = actor("staff"),
    token = "fixture-wait-token-" + Math.random();
  await query(staff, "issue_step_up", [a, "policy:pause", "analytics", token]);
  const intent = await query(staff, "staff_action", [
    a,
    "policy:pause",
    "analytics",
    token,
    JSON.stringify({ expectedRevision: 0 }),
    "controlled_lock_race_pause",
  ]);
  const client = await admin.connect();
  await client.query("BEGIN");
  try {
    await client.query(
      'UPDATE "StaffGrant" SET enabled=false WHERE "userId"=\'staff\'',
    );
    const applying = query(operator, "execute_pause", [intent.id]);
    const observed = applying.then(
      () => "APPLIED",
      (error) => String(error.message),
    );
    await client.query("COMMIT");
    expect(await observed).toMatch(/STAFF_REQUIRED|STAFF_AUTHORITY_CHANGED/);
    expect(
      (
        await admin.query(
          "SELECT revision FROM \"RuntimePolicy\" WHERE key='analytics'",
        )
      ).rows[0].revision,
    ).toBe(0);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await admin.query(
      'UPDATE "StaffGrant" SET enabled=true WHERE "userId"=\'staff\'',
    );
  }
});
it("projects ordered canonical cancellation, arrears, dispute and recovery independently of notice order", async () => {
  const states = [
    {
      state: "CANCEL_AT_PERIOD_END",
      nativeState: "active",
      paid: true,
      disputed: false,
      expected: true,
    },
    {
      state: "PAST_DUE",
      nativeState: "past_due",
      paid: false,
      disputed: false,
      expected: false,
    },
    {
      state: "ACTIVE",
      nativeState: "active",
      paid: true,
      disputed: true,
      expected: false,
    },
    {
      state: "ACTIVE",
      nativeState: "active",
      paid: true,
      disputed: false,
      expected: true,
    },
  ];
  for (const [index, state] of states.entries()) {
    await query(intake, "record_event", [
      {
        mode: "SANDBOX",
        provider: "POLAR",
        merchantId: "fixture_org",
        externalId: `evt_permutation_${index}`,
        payloadHash: String(index + 2).repeat(64),
        keyVersion: "fixture-v1",
        type: "subscription.updated",
        resourceId: "polar_sub_one",
        customerId: "polar_customer",
        occurredAt: new Date(Date.now() - index * 60000).toISOString(),
        contract: "fixture-v1",
      },
    ]);
    const claim = await query(reconciler, "claim", [
      "POLAR",
      "fixture_org",
      "polar_sub_one",
    ]);
    const snapshot = {
      ...state,
      planId: "fixture-plan",
      currency: "USD",
      exponent: 2,
      periodStart: new Date(Date.now() - 1000).toISOString(),
      periodEnd: new Date(Date.now() + 86400000).toISOString(),
      effects: [],
    };
    expect(
      await query(reconciler, "apply_snapshot", [
        claim.id,
        claim.fence,
        claim.generation,
        claim.token,
        snapshot,
      ]),
    ).toMatchObject({
      state: state.disputed ? "DISPUTED" : state.state,
      sandboxEntitled: state.expected,
      productionEntitled: false,
    });
  }
  await expect(
    query(runtime, "owner_status", [actor(), "billing-b"]),
  ).rejects.toThrow("FORBIDDEN");
  expect(
    await query(runtime, "owner_status", [actor("other"), "billing-b"]),
  ).toMatchObject({
    pilotAccess: "FREE",
    checkoutAvailable: false,
    productionEntitled: false,
  });
  await expect(
    query(runtime, "owner_status", [
      { ...actor("other"), credential: "api-token" },
      "billing-b",
    ]),
  ).rejects.toThrow();
});
it("protects functions, immutable mapping versions and audited read projections", async () => {
  for (const role of [runtime, intake, reconciler, staff])
    await expect(
      role.query("SET ROLE lyraseo_billing_owner"),
    ).rejects.toThrow();
  await expect(
    intake.query(
      "UPDATE lyraseo_billing.subscription SET production_entitled=true",
    ),
  ).rejects.toThrow();
  await expect(
    admin.query("UPDATE lyraseo_billing.price_mapping SET plan_id='changed'"),
  ).rejects.toThrow("IMMUTABLE_BILLING_EVIDENCE");
  const view = await query(staff, "staff_view", [
    actor("staff"),
    "operations",
    null,
    25,
  ]);
  expect(view.rows).toHaveLength(0);
  const usage = await query(staff, "staff_view", [
    actor("staff"),
    "usage",
    null,
    25,
  ]);
  expect(usage.rows).toHaveLength(0);
  expect(JSON.stringify(view)).not.toMatch(
    /rawAnswers|Authorization|requestInput|secret/,
  );
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.staff_receipt WHERE action='read:operations'",
      )
    ).rows[0].n,
  ).toBe(1);
});

it("reads all eight actual kernel controls through the restricted staff projection", async () => {
  const view = await query(staff, "staff_view", [
    actor("staff"),
    "controls",
    null,
    25,
  ]);
  expect(view.rows).toHaveLength(8);
  expect(
    view.rows.every((row: { enabled: boolean }) => row.enabled === false),
  ).toBe(true);
});
it("bounds exact and prefix support search, escapes literal underscores and never returns PII/content", async () => {
  await admin.query(
    `INSERT INTO "ProductUser"(id) VALUES('support_fixture_user_alpha'),('supportXfixtureYuser_decoy'); INSERT INTO "Workspace"(id,name) VALUES('support_fixture_workspace','PRIVATE_NAME_NOT_EXPOSED'); INSERT INTO "Site"(id,"workspaceId",origin,"verifiedAt") VALUES('support_fixture_site','support_fixture_workspace','https://private-path.example',now()); INSERT INTO lyraseo_billing.staff_capability(user_id,action) VALUES('staff','support:search');`,
  );
  await expect(
    query(staff, "staff_search", [
      actor("staff"),
      "short",
      "PREFIX",
      null,
      null,
      25,
    ]),
  ).rejects.toThrow("INVALID_SUPPORT_QUERY");
  await expect(
    query(staff, "staff_search", [
      actor("staff"),
      "support_%",
      "PREFIX",
      null,
      null,
      25,
    ]),
  ).rejects.toThrow("INVALID_SUPPORT_QUERY");
  const found = await query(staff, "staff_search", [
    actor("staff"),
    "support_fixture_",
    "PREFIX",
    null,
    null,
    25,
  ]);
  expect(found.rows).toHaveLength(3);
  expect(
    found.rows.some((row: { id: string }) => row.id.includes("decoy")),
  ).toBe(false);
  expect(JSON.stringify(found)).not.toMatch(
    /PRIVATE_NAME|private-path|email|subject|origin|rawAnswers|content/,
  );
  const exact = await query(staff, "staff_search", [
    actor("staff"),
    "support_fixture_site",
    "EXACT",
    null,
    null,
    25,
  ]);
  expect(exact.rows).toMatchObject([
    {
      kind: "SITE",
      id: "support_fixture_site",
      workspace_id: "support_fixture_workspace",
      verified: true,
    },
  ]);
  await expect(
    query(staff, "staff_search", [
      actor("staff2"),
      "support_fixture_",
      "PREFIX",
      null,
      null,
      25,
    ]),
  ).rejects.toThrow("STAFF_ACTION_FORBIDDEN");
  await expect(
    query(staff, "staff_search", [
      {
        ...actor("staff"),
        mfaAuthenticatedAt: new Date(Date.now() - 660000).toISOString(),
      },
      "support_fixture_",
      "PREFIX",
      null,
      null,
      25,
    ]),
  ).rejects.toThrow("FRESH_AUTH_REQUIRED");
  await expect(
    query(runtime, "staff_search", [
      actor("staff"),
      "support_fixture_",
      "PREFIX",
      null,
      null,
      25,
    ]),
  ).rejects.toThrow();
  const first = await query(staff, "staff_search", [
    actor("staff"),
    "support_fixture_",
    "PREFIX",
    null,
    null,
    1,
  ]);
  const second = await query(staff, "staff_search", [
    actor("staff"),
    "support_fixture_",
    "PREFIX",
    first.nextKind,
    first.nextId,
    1,
  ]);
  expect(second.rows[0].id).not.toBe(first.rows[0].id);
});

it("rejects SQL NULL bounds rather than admitting unbounded staff reads", async () => {
  await expect(
    query(staff, "staff_view", [actor("staff"), "operations", null, null]),
  ).rejects.toThrow("INVALID_SUPPORT_QUERY");
  await expect(
    query(staff, "staff_search", [
      actor("staff"),
      "support_fixture_",
      "PREFIX",
      null,
      null,
      null,
    ]),
  ).rejects.toThrow("INVALID_SUPPORT_QUERY");
});
it("paginates beyond the first25matching IDs without dropping the rest of a prefix", async () => {
  await admin.query(
    "INSERT INTO \"ProductUser\"(id) SELECT 'support_batch_fixture_'||lpad(i::text,3,'0') FROM generate_series(1,27) i",
  );
  const ids: string[] = [];
  let kind: string | null = null,
    id: string | null = null;
  for (let page = 0; page < 3; page++) {
    const result = await query(staff, "staff_search", [
      actor("staff"),
      "support_batch_fixture_",
      "PREFIX",
      kind,
      id,
      10,
    ]);
    ids.push(...result.rows.map((row: { id: string }) => row.id));
    kind = result.nextKind;
    id = result.nextId;
  }
  expect(ids).toHaveLength(27);
  expect(new Set(ids).size).toBe(27);
  expect(ids.at(-1)).toBe("support_batch_fixture_027");
});
