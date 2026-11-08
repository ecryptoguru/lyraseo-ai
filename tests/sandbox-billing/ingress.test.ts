import { createHmac } from "node:crypto";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { persistVerifiedSandboxEvent } from "../../packages/db/src/sandbox-billing";
import { verifySandboxBillingRequest } from "../../packages/db/src/sandbox-billing-ingress";
const { Pool } = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
)("pg");
const name = process.env.LYRA_SANDBOX_BILLING_TEST_DB;
if (!name || !/^lyraseo_billing_[a-f0-9]{12}$/.test(name))
  throw Error("OWNED_BILLING_DATABASE_REQUIRED");
const admin = new Pool({
  connectionString: `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${name}`,
});
const intake = createDatabase(
  `postgresql://lyraseo_billing_intake:local_billing_intake_only@127.0.0.1:54329/${name}`,
);
const endpoint = {
  mode: "SANDBOX" as const,
  merchantId: "fixture_ingress",
  keyVersion: "fixture-only-v1",
  secret: "locally-generated-fixture-ingress-key",
};
const body = Buffer.from(
  JSON.stringify({
    entity: "event",
    account_id: endpoint.merchantId,
    event: "subscription.activated",
    created_at: 1700000000,
    payload: {
      subscription: {
        entity: { id: "sub_ingress", customer_id: "cust_ingress" },
      },
    },
  }),
);
let port = 0,
  sends = 0,
  loseAck = false;
const server = createServer(async (req, res) => {
  try {
    const event = await verifySandboxBillingRequest(req, endpoint);
    const receipt = await persistVerifiedSandboxEvent(intake, event);
    sends++;
    if (loseAck) {
      loseAck = false;
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(receipt));
  } catch {
    res.writeHead(400);
    res.end("Invalid delivery");
  }
});
const deliver = (bytes = body, extra: Record<string, string | string[]> = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/billing/webhooks/razorpay",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-razorpay-event-id": "evt_ingress",
          "x-razorpay-signature": createHmac("sha256", endpoint.secret)
            .update(bytes)
            .digest("hex"),
          ...extra,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (value) => chunks.push(value));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(bytes.subarray(0, 31));
    req.end(bytes.subarray(31));
  });
beforeAll(async () => {
  await admin.query(
    `INSERT INTO "Workspace"(id,name) VALUES('billing-ingress','Ingress fixture'); INSERT INTO lyraseo_billing.account(workspace_id) VALUES('billing-ingress'); INSERT INTO lyraseo_billing.merchant(provider,merchant_id) VALUES('RAZORPAY','fixture_ingress'); INSERT INTO lyraseo_billing.binding(provider,merchant_id,resource_id,customer_id,account_id) SELECT 'RAZORPAY','fixture_ingress','sub_ingress','cust_ingress',id FROM lyraseo_billing.account WHERE workspace_id='billing-ingress';`,
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    }),
  );
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await intake.$disconnect();
  await admin.end();
});
it("durably ingests streamed exact bytes before acknowledgement and recovers a lost acknowledgement without duplicate events", async () => {
  loseAck = true;
  await expect(deliver()).rejects.toThrow();
  const retry = await deliver();
  expect(retry.status).toBe(200);
  expect(JSON.parse(retry.body)).toMatchObject({ outcome: "EXACT_REPLAY" });
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.event WHERE merchant_id='fixture_ingress'",
      )
    ).rows[0].n,
  ).toBe(1);
});
it("rejects malformed duplicate signatures, browser credentials, compression and oversized streams before intake", async () => {
  const previous = sends;
  expect(
    (await deliver(body, { "x-razorpay-signature": ["bad", "bad"] })).status,
  ).toBe(400);
  expect((await deliver(body, { cookie: "session=fixture" })).status).toBe(400);
  expect((await deliver(body, { "content-encoding": "gzip" })).status).toBe(
    400,
  );
  expect(
    await deliver(Buffer.alloc(256 * 1024 + 1)).then(
      (response) => response.status === 400,
      (error: NodeJS.ErrnoException) => error.code === "ECONNRESET",
    ),
  ).toBe(true);
  expect(sends).toBe(previous);
});
