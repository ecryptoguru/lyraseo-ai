import { expect, it } from "vitest";
import { randomUUID, createHmac } from "node:crypto";
import { verifyRazorpayDelivery } from "../../packages/db/src/sandbox-billing-codecs";
import {
  admin,
  runtime,
  recon,
  intake,
  staff,
  operator,
  q,
  actor,
  fixture,
  snapshot,
  apply,
} from "../helpers/sandbox-billing-review";
it("R1 old ended subscription cannot reclaim a newly reserved same-provider intent", async () => {
  const f = await fixture();
  expect(await apply(f, snapshot(f))).toMatchObject({ sandboxEntitled: true });
  await apply(f, {
    ...snapshot(f, 2),
    state: "ENDED",
    nativeState: "ended",
    periodEnd: "2026-11-02T00:00:00Z",
    effects: [],
    paymentReference: null,
  });
  await q(runtime, "reserve_slot", [
    f.a,
    f.id,
    "RAZORPAY",
    f.id,
    "price_a",
    "v1",
    "second",
  ]);
  expect(await apply(f, snapshot(f, 3))).toMatchObject({
    sandboxEntitled: false,
  });
});
it("R1 exact observed external price/version must match frozen intent even when plan/currency match", async () => {
  const f = await fixture();
  expect(
    await apply(f, {
      ...snapshot(f),
      externalPriceId: "price_b",
      priceMappingVersion: "v2",
    }),
  ).toMatchObject({ sandboxEntitled: false, reason: "FROZEN_PRICE_CONFLICT" });
});
it("R1 a paid boolean without successful source-bound payment never grants entitlement", async () => {
  const f = await fixture();
  expect(
    await apply(f, {
      ...snapshot(f),
      effects: [],
      paymentReference: null,
      paid: true,
    }),
  ).toMatchObject({ sandboxEntitled: false });
});
it("R1 pending and failed refunds are observations, not completed refund totals", async () => {
  const f = await fixture(),
    s = snapshot(f);
  for (const [i, status] of ["PENDING", "FAILED"].entries()) {
    await apply(f, {
      ...s,
      sourceVersion: {
        qualification: "SYNTHETIC_COMPARABLE_V2",
        value: String(i + 1),
      },
      effects: [
        ...s.effects,
        {
          ...s.effects[0],
          kind: "REFUND",
          reference: `refund_${f.id}`,
          parentReference: s.paymentReference,
          amountMinor: "1000",
          status,
        },
      ],
    });
  }
  expect(
    (
      await admin.query(
        "SELECT coalesce(sum(amount_minor),0)::text total FROM lyraseo_billing.money_fact WHERE parent_reference=$1 AND kind='REFUND'",
        [s.paymentReference],
      )
    ).rows[0].total,
  ).toBe("0");
});
it("R1 stale canonical source version cannot regress an ended projection without another notice", async () => {
  const f = await fixture();
  await apply(f, snapshot(f));
  await apply(f, {
    ...snapshot(f, 3),
    state: "ENDED",
    nativeState: "ended",
    periodEnd: "2026-11-02T00:00:00Z",
    effects: [],
    paymentReference: null,
  });
  expect(await apply(f, snapshot(f, 2))).toMatchObject({
    state: "ENDED",
    sandboxEntitled: false,
    reason: "STALE_CANONICAL",
  });
});
it("R1 actual-shaped signed refund notice is durable even while subscription discovery is unresolved", async () => {
  const f = await fixture();
  const endpoint = {
    mode: "SANDBOX" as const,
    merchantId: f.id,
    keyVersion: "fixture",
    secret: "fixture-refund-secret",
  };
  const body = Buffer.from(
    JSON.stringify({
      entity: "event",
      account_id: f.id,
      event: "refund.processed",
      created_at: 1700000000,
      payload: {
        refund: {
          entity: {
            id: `refund_${f.id}`,
            payment_id: `unknownpay_${f.id}`,
            amount: 1000,
            currency: "USD",
            status: "processed",
          },
        },
      },
    }),
  );
  const e = verifyRazorpayDelivery(
    body,
    [
      "x-razorpay-event-id",
      randomUUID(),
      "x-razorpay-signature",
      createHmac("sha256", endpoint.secret).update(body).digest("hex"),
    ],
    endpoint,
  );
  expect(await q(intake, "record_event", [e])).toMatchObject({
    outcome: "DURABLE_UNRESOLVED",
  });
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.event WHERE resource_id=$1",
        [`refund_${f.id}`],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("R1 queued staff execution is unavailable without authoritative current provider-session revalidation", async () => {
  const f = await fixture();
  await admin.query(
    'INSERT INTO "StaffGrant"("userId",enabled) VALUES($1,true)',
    [f.id],
  );
  await admin.query(
    "INSERT INTO lyraseo_billing.staff_capability(user_id,action) VALUES($1,'policy:pause')",
    [f.id],
  );
  const token = randomUUID();
  await q(staff, "issue_step_up", [f.a, "policy:pause", "global", token]);
  const rev = (
    await admin.query(
      "SELECT revision FROM \"RuntimePolicy\" WHERE key='global'",
    )
  ).rows[0].revision;
  const intent = await q(staff, "staff_action", [
    f.a,
    "policy:pause",
    "global",
    token,
    JSON.stringify({ expectedRevision: rev }),
    "fixture current provider unavailable",
  ]);
  expect(await q(operator, "execute_pause", [intent.id])).toMatchObject({
    state: "UNAVAILABLE",
    reason: "AUTHORITATIVE_SESSION_REVALIDATION_UNAVAILABLE",
  });
  expect(
    (
      await admin.query(
        "SELECT revision FROM \"RuntimePolicy\" WHERE key='global'",
      )
    ).rows[0].revision,
  ).toBe(rev);
});
it("R1 processed full refund reduces net paid evidence without inventing subscription cancellation", async () => {
  const f = await fixture(),
    s = snapshot(f);
  await apply(f, s);
  const result = await apply(f, {
    ...s,
    sourceVersion: { qualification: "SYNTHETIC_COMPARABLE_V2", value: "2" },
    effects: [
      ...s.effects,
      {
        ...s.effects[0],
        kind: "REFUND",
        reference: `fullrefund_${f.id}`,
        parentReference: s.paymentReference,
        status: "SUCCEEDED",
      },
    ],
  });
  expect(result).toMatchObject({
    state: "ACTIVE",
    sandboxEntitled: false,
    reason: "PAYMENT_NOT_CORROBORATED",
  });
});
it("R1 equal conflicting or unqualified canonical versions cannot replace newer evidence", async () => {
  const f = await fixture(),
    s = snapshot(f, 4);
  await apply(f, s);
  expect(
    await apply(f, { ...s, state: "PAST_DUE", nativeState: "past_due" }),
  ).toMatchObject({ state: "ACTIVE", reason: "AMBIGUOUS_CANONICAL" });
  expect(await apply(f, { ...s, sourceVersion: undefined })).toMatchObject({
    state: "ACTIVE",
    reason: "UNORDERED_CANONICAL",
  });
});
it("R1 late old subscription cannot reclaim a cross-provider reserved intent", async () => {
  const f = await fixture();
  await apply(f, snapshot(f));
  await apply(f, {
    ...snapshot(f, 2),
    state: "ENDED",
    nativeState: "ended",
    periodEnd: "2026-11-02T00:00:00Z",
    effects: [],
    paymentReference: null,
  });
  await admin.query(
    "INSERT INTO lyraseo_billing.merchant(provider,merchant_id) VALUES('POLAR',$1)",
    [f.id],
  );
  await admin.query(
    "INSERT INTO lyraseo_billing.price_mapping(provider,merchant_id,external_price,version,plan_id,currency,exponent,amount_minor) VALUES('POLAR',$1,'price_a','v1','same_plan','USD',2,1000)",
    [f.id],
  );
  const next = await q(runtime, "reserve_slot", [
    f.a,
    f.id,
    "POLAR",
    f.id,
    "price_a",
    "v1",
    "cross-provider",
  ]);
  expect(await apply(f, snapshot(f, 3))).toMatchObject({
    sandboxEntitled: false,
  });
  expect(
    (
      await admin.query(
        "SELECT id,provider FROM lyraseo_billing.base_slot WHERE account_id=$1",
        [f.account],
      )
    ).rows[0],
  ).toEqual({ id: next.id, provider: "POLAR" });
});
it("R1 successful payment evidence must match the exact resource and billing period", async () => {
  const f = await fixture(),
    s = snapshot(f);
  await expect(
    apply(f, {
      ...s,
      effects: [{ ...s.effects[0], resourceId: "foreign_sub" }],
    }),
  ).rejects.toThrow("INVALID_BILLING_EVIDENCE");
  expect(
    await apply(f, {
      ...s,
      effects: [
        {
          ...s.effects[0],
          periodStart: "2026-10-01T00:00:00Z",
          periodEnd: "2026-11-01T00:00:00Z",
        },
      ],
    }),
  ).toMatchObject({ sandboxEntitled: false });
});
it("R1 server-bound request ID replay creates one recovery case and audits exact retries without browser tokens", async () => {
  const f = await fixture();
  await admin.query(
    'INSERT INTO "StaffGrant"("userId",enabled) VALUES($1,true)',
    [f.id],
  );
  await admin.query(
    "INSERT INTO lyraseo_billing.staff_capability(user_id,action) VALUES($1,'recovery:manage')",
    [f.id],
  );
  const request = randomUUID();
  expect(
    await q(staff, "prepare_request", [
      f.a,
      request,
      "recovery:open",
      f.id,
      "{}",
      "controlled idempotent fixture",
    ]),
  ).not.toHaveProperty("token");
  const first = await q(staff, "execute_request", [f.a, request]);
  expect(
    await q(staff, "prepare_request", [
      f.a,
      request,
      "recovery:open",
      f.id,
      "{}",
      "controlled idempotent fixture",
    ]),
  ).toMatchObject({ requestId: request });
  expect(await q(staff, "execute_request", [f.a, request])).toEqual(first);
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.recovery_case WHERE opened_by=$1",
        [f.id],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.staff_receipt WHERE staff_id=$1 AND outcome='REPLAY'",
        [f.id],
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    q(staff, "prepare_request", [
      f.a,
      request,
      "recovery:open",
      "changed",
      "{}",
      "controlled idempotent fixture",
    ]),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});
it("R1 real-shaped signed payment, refund and dispute deliveries route through signed/known payment references", async () => {
  const f = await fixture();
  await apply(f, snapshot(f));
  for (const [type, key, entity] of [
    [
      "payment.captured",
      "payment",
      {
        id: `noticepay_${f.id}`,
        subscription_id: f.resource,
        customer_id: f.customer,
      },
    ],
    [
      "refund.processed",
      "refund",
      { id: `noticerefund_${f.id}`, payment_id: `payment_${f.id}` },
    ],
    [
      "payment.dispute.created",
      "dispute",
      { id: `dispute_${f.id}`, payment_id: `payment_${f.id}` },
    ],
  ] as const) {
    const endpoint = {
      mode: "SANDBOX" as const,
      merchantId: f.id,
      keyVersion: "fixture",
      secret: "fixture-actual-shaped-key",
    };
    const raw = Buffer.from(
      JSON.stringify({
        entity: "event",
        account_id: f.id,
        event: type,
        created_at: 1700000000,
        payload: { [key]: { entity } },
      }),
    );
    const e = verifyRazorpayDelivery(
      raw,
      [
        "x-razorpay-event-id",
        randomUUID(),
        "x-razorpay-signature",
        createHmac("sha256", endpoint.secret).update(raw).digest("hex"),
      ],
      endpoint,
    );
    const receipt = await q(intake, "record_event", [e]);
    expect(receipt.outcome).toBe("ACCEPTED");
    expect(
      (
        await admin.query(
          "SELECT resource_id FROM lyraseo_billing.event_route WHERE event_id=$1",
          [receipt.id],
        )
      ).rows[0].resource_id,
    ).toBe(f.resource);
  }
});
it("R1 Polar order/refund signed families preserve their own IDs and route only verified same-organization subscription references", async () => {
  const f = await fixture();
  await admin.query(
    "INSERT INTO lyraseo_billing.merchant(provider,merchant_id) VALUES('POLAR',$1)",
    [f.id],
  );
  await admin.query(
    "INSERT INTO lyraseo_billing.binding(provider,merchant_id,resource_id,customer_id,account_id) VALUES('POLAR',$1,$2,$3,$4)",
    [f.id, `polar_${f.resource}`, f.customer, f.account],
  );
  const { verifyPolarDelivery } =
    await import("../../packages/db/src/sandbox-billing-codecs");
  const key = Buffer.from("fixture-polar-32byte-key-padding__"),
    endpoint = {
      mode: "SANDBOX" as const,
      merchantId: f.id,
      keyVersion: "fixture",
      secret: "whsec_" + key.toString("base64"),
    };
  for (const type of ["order.paid", "refund.created", "subscription.active"]) {
    const id = `${type.split(".")[0]}_${f.id}`,
      body = Buffer.from(
        JSON.stringify({
          type,
          timestamp: "2026-11-03T00:00:00Z",
          data: {
            id,
            organization_id: f.id,
            subscription_id: `polar_${f.resource}`,
            customer_id: f.customer,
            order_id: `order_${f.id}`,
          },
        }),
      ),
      eventId = randomUUID(),
      time = String(Math.floor(Date.now() / 1000)),
      signature = createHmac("sha256", key)
        .update(`${eventId}.${time}.`)
        .update(body)
        .digest("base64");
    const e = await verifyPolarDelivery(
      body,
      [
        "webhook-id",
        eventId,
        "webhook-timestamp",
        time,
        "webhook-signature",
        `v1,${signature}`,
      ],
      endpoint,
    );
    expect(e.resourceId).toBe(id);
    const receipt = await q(intake, "record_event", [e]);
    expect(receipt.outcome).toBe("ACCEPTED");
    expect(
      (
        await admin.query(
          "SELECT resource_id FROM lyraseo_billing.event_route WHERE event_id=$1",
          [receipt.id],
        )
      ).rows[0].resource_id,
    ).toBe(`polar_${f.resource}`);
  }
});
it("R1 unresolved discovery is bounded, remains visible, and cannot accept a caller-selected foreign account", async () => {
  const f = await fixture();
  const receipt = await q(intake, "record_event", [
    {
      mode: "SANDBOX",
      provider: "RAZORPAY",
      merchantId: f.id,
      externalId: randomUUID(),
      payloadHash: "f".repeat(64),
      keyVersion: "fixture",
      contract: "fixture",
      type: "refund.processed",
      resourceId: `unresolved_${f.id}`,
      customerId: "foreign_customer",
      references: { paymentId: `unknown_${f.id}` },
      occurredAt: new Date().toISOString(),
    },
  ]);
  expect(receipt.outcome).toBe("DURABLE_UNRESOLVED");
  expect(await q(recon, "resolve_pending", [receipt.id])).toMatchObject({
    state: "UNAVAILABLE",
    reason: "QUALIFIED_REFERENCE_READER_UNAVAILABLE",
  });
  expect(await q(recon, "resolve_pending", [receipt.id])).toMatchObject({
    reason: "BACKOFF_OR_TERMINAL",
  });
  await expect(q(runtime, "resolve_pending", [receipt.id])).rejects.toThrow();
  expect(
    (
      await admin.query(
        "SELECT state,attempts FROM lyraseo_billing.discovery WHERE event_id=$1",
        [receipt.id],
      )
    ).rows[0],
  ).toEqual({ state: "UNAVAILABLE", attempts: 1 });
});
it("R1 a refund arriving before its payment is durably routed after source-bound payment evidence arrives", async () => {
  const f = await fixture(),
    s = snapshot(f);
  const event = {
    mode: "SANDBOX",
    provider: "RAZORPAY",
    merchantId: f.id,
    externalId: randomUUID(),
    payloadHash: "e".repeat(64),
    keyVersion: "fixture",
    contract: "fixture",
    type: "refund.processed",
    resourceId: `earlyrefund_${f.id}`,
    customerId: f.customer,
    references: { paymentId: s.paymentReference },
    occurredAt: new Date().toISOString(),
  };
  const pending = await q(intake, "record_event", [event]);
  expect(pending.outcome).toBe("DURABLE_UNRESOLVED");
  await apply(f, s);
  expect(await q(recon, "resolve_pending", [pending.id])).toMatchObject({
    state: "ROUTED",
  });
  expect(
    (
      await admin.query(
        "SELECT account_id,resource_id FROM lyraseo_billing.event_route WHERE event_id=$1",
        [pending.id],
      )
    ).rows[0],
  ).toEqual({ account_id: f.account, resource_id: f.resource });
});
it("R1 pending and failed payments remain distinct and cannot become entitlement from paid:true", async () => {
  const f = await fixture(),
    s = snapshot(f);
  for (const [i, status] of ["PENDING", "FAILED"].entries())
    expect(
      await apply(f, {
        ...s,
        sourceVersion: {
          qualification: "SYNTHETIC_COMPARABLE_V2",
          value: String(i + 1),
        },
        effects: [{ ...s.effects[0], status }],
      }),
    ).toMatchObject({ sandboxEntitled: false });
  expect(
    (
      await admin.query(
        "SELECT status FROM lyraseo_billing.economic_observation WHERE reference=$1 ORDER BY source_version",
        [s.paymentReference],
      )
    ).rows.map((x: { status: string }) => x.status),
  ).toEqual(["PENDING", "FAILED"]);
  expect(
    await apply(f, {
      ...s,
      sourceVersion: { qualification: "SYNTHETIC_COMPARABLE_V2", value: "3" },
    }),
  ).toMatchObject({ sandboxEntitled: true });
});
