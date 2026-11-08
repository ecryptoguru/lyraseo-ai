import { randomUUID, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll } from "vitest";
import { verifyRazorpayDelivery } from "../../packages/db/src/sandbox-billing-codecs";
const { Pool } = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
)("pg");
const db = process.env.LYRA_SANDBOX_BILLING_TEST_DB;
if (!/^lyraseo_billing_[a-f0-9]{12}$/.test(db ?? ""))
  throw Error("OWNED_BILLING_DATABASE_REQUIRED");
const p = (user: string, password: string) =>
  new Pool({
    connectionString: `postgresql://${user}:${password}@127.0.0.1:54329/${db}`,
  });
const admin = p("postgres", "lyraseo_local_only"),
  runtime = p("lyraseo_runtime", "local_runtime_only"),
  recon = p("lyraseo_billing_reconciler", "local_billing_reconciler_only"),
  intake = p("lyraseo_billing_intake", "local_billing_intake_only"),
  staff = p("lyraseo_staff_executor", "local_staff_executor_only"),
  operator = p("lyraseo_operator", "local_operator_only");
afterAll(() =>
  Promise.all(
    [admin, runtime, recon, intake, staff, operator].map((x) => x.end()),
  ),
);
const q = async (p: any, fn: string, args: any[]) =>
  (
    await p.query(
      `SELECT lyraseo_billing.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`,
      args.map((x) => (x && typeof x === "object" ? JSON.stringify(x) : x)),
    )
  ).rows[0].value;
const actor = (id: string) => ({
  userId: id,
  sessionId: `session_${id}`,
  securityVersion: 0,
  authenticatedAt: new Date().toISOString(),
  mfaAuthenticatedAt: new Date().toISOString(),
  mfaVerified: true,
  authProvider: "supabase",
});
async function fixture() {
  const id = "r1_" + randomUUID().replaceAll("-", ""),
    a = actor(id);
  await admin.query('INSERT INTO "ProductUser"(id) VALUES($1);', [id]);
  await admin.query(
    'INSERT INTO "ProductSession"("sessionId","userId","securityVersion","createdAt","refreshedAt") VALUES($1,$2,0,now(),now())',
    [a.sessionId, id],
  );
  await admin.query(
    "INSERT INTO \"Workspace\"(id,name) VALUES($1,'R1 synthetic')",
    [id],
  );
  await admin.query(
    'INSERT INTO "Membership"("workspaceId","userId",role) VALUES($1,$1,\'OWNER\')',
    [id],
  );
  await admin.query(
    "INSERT INTO lyraseo_billing.merchant(provider,merchant_id) VALUES('RAZORPAY',$1)",
    [id],
  );
  const amount = (
    await admin.query(
      "SELECT EXISTS(SELECT FROM information_schema.columns WHERE table_schema='lyraseo_billing' AND table_name='price_mapping' AND column_name='amount_minor') yes",
    )
  ).rows[0].yes;
  await admin.query(
    `INSERT INTO lyraseo_billing.price_mapping(provider,merchant_id,external_price,version,plan_id,currency,exponent${amount ? ",amount_minor" : ""}) VALUES('RAZORPAY',$1,'price_a','v1','same_plan','USD',2${amount ? ",1000" : ""}),('RAZORPAY',$1,'price_b','v2','same_plan','USD',2${amount ? ",1000" : ""})`,
    [id],
  );
  const slot = await q(runtime, "reserve_slot", [
    a,
    id,
    "RAZORPAY",
    id,
    "price_a",
    "v1",
    "first",
  ]);
  const account = (
    await admin.query(
      "SELECT id FROM lyraseo_billing.account WHERE workspace_id=$1",
      [id],
    )
  ).rows[0].id;
  const resource = `sub_${id}`;
  await admin.query(
    "INSERT INTO lyraseo_billing.binding(provider,merchant_id,resource_id,customer_id,account_id) VALUES('RAZORPAY',$1,$2,$3,$4)",
    [id, resource, `cust_${id}`, account],
  );
  if (
    (
      await admin.query(
        "SELECT to_regprocedure('lyraseo_billing.bind_subscription(uuid,text,text,text,text)') IS NOT NULL yes",
      )
    ).rows[0].yes
  )
    await q(recon, "bind_subscription", [
      slot.id,
      resource,
      `cust_${id}`,
      "SYNTHETIC_EXTERNAL_BINDING_V2",
      "a".repeat(64),
    ]);
  return { id, a, slot, resource, account, customer: `cust_${id}` };
}
function snapshot(f: any, version = 1) {
  const start = "2026-11-01T00:00:00Z",
    end = "2026-12-01T00:00:00Z";
  return {
    nativeState: "active",
    state: "ACTIVE",
    planId: "same_plan",
    externalPriceId: "price_a",
    priceMappingVersion: "v1",
    currency: "USD",
    exponent: 2,
    periodStart: start,
    periodEnd: end,
    paid: true,
    disputed: false,
    sourceIdentity: {
      provider: "RAZORPAY",
      merchantId: f.id,
      resourceId: f.resource,
      customerId: f.customer,
    },
    sourceVersion: {
      qualification: "SYNTHETIC_COMPARABLE_V2",
      value: String(version),
    },
    paymentReference: `payment_${f.id}`,
    effects: [
      {
        kind: "PAYMENT",
        reference: `payment_${f.id}`,
        parentReference: null,
        amountMinor: "1000",
        currency: "USD",
        exponent: 2,
        status: "SUCCEEDED",
        resourceId: f.resource,
        periodStart: start,
        periodEnd: end,
        evidenceHash: "b".repeat(64),
        sourceContract: "SYNTHETIC_CANONICAL_V2",
      },
    ],
  };
}
async function apply(f: any, s: any) {
  await q(intake, "record_event", [
    {
      mode: "SANDBOX",
      provider: "RAZORPAY",
      merchantId: f.id,
      externalId: randomUUID(),
      payloadHash: randomUUID().replaceAll("-", "") + "a".repeat(32),
      keyVersion: "fixture",
      type: "subscription.updated",
      resourceId: f.resource,
      customerId: f.customer,
      occurredAt: new Date().toISOString(),
      contract: "fixture",
    },
  ]);
  const c = await q(recon, "claim", ["RAZORPAY", f.id, f.resource]);
  return q(recon, "apply_snapshot", [c.id, c.fence, c.generation, c.token, s]);
}

export {
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
};
