import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseMinorUnits,
  verifyRazorpayDelivery,
  projectSandboxSnapshot,
  strictBillingHeaders,
} from "../../packages/db/src/sandbox-billing-codecs";
const endpoint = {
  merchantId: "fixture_merchant",
  keyVersion: "fixture-v1",
  secret: "test-only-secret-not-a-provider-key",
  mode: "SANDBOX" as const,
};
const body = Buffer.from(
  JSON.stringify({
    entity: "event",
    account_id: "fixture_merchant",
    event: "subscription.activated",
    created_at: 1700000000,
    payload: {
      subscription: {
        entity: { id: "sub_fixture", customer_id: "cust_fixture" },
      },
    },
  }),
);
const headers = () => [
  "x-razorpay-event-id",
  "evt_fixture",
  "x-razorpay-signature",
  createHmac("sha256", endpoint.secret).update(body).digest("hex"),
];
describe("sandbox billing evidence", () => {
  it("authenticates exact bytes and pins merchant without retaining raw payload", () => {
    const event = verifyRazorpayDelivery(body, headers(), endpoint);
    expect(event).toMatchObject({
      provider: "RAZORPAY",
      merchantId: "fixture_merchant",
      externalId: "evt_fixture",
      resourceId: "sub_fixture",
      mode: "SANDBOX",
    });
    expect(JSON.stringify(event)).not.toContain(endpoint.secret);
    expect(event).not.toHaveProperty("rawBody");
    expect(() =>
      verifyRazorpayDelivery(
        Buffer.concat([body, Buffer.from(" ")]),
        headers(),
        endpoint,
      ),
    ).toThrow("INVALID_BILLING_DELIVERY");
    expect(() =>
      verifyRazorpayDelivery(body, headers(), {
        ...endpoint,
        merchantId: "other",
      }),
    ).toThrow("INVALID_BILLING_DELIVERY");
  });
  it("rejects duplicate headers regardless of case and missing authentication", () => {
    expect(() =>
      verifyRazorpayDelivery(
        body,
        [...headers(), "X-Razorpay-Signature", headers()[3]!],
        endpoint,
      ),
    ).toThrow();
    expect(() => strictBillingHeaders(["x", "a", "X", "b"])).toThrow();
    expect(() => verifyRazorpayDelivery(body, [], endpoint)).toThrow();
  });
  it("accepts only lossless integral minor amounts with reviewed exponent", () => {
    expect(parseMinorUnits("0", "JPY", 0)).toBe(0n);
    expect(parseMinorUnits("123456789012345678", "KWD", 3)).toBe(
      123456789012345678n,
    );
    for (const bad of [1, 1.2, "1.2", "01", "1e2", "-1", "9223372036854775808"])
      expect(() => parseMinorUnits(bad, "USD", 2)).toThrow();
    expect(() => parseMinorUnits("100", "USD", 3)).toThrow();
  });
  it("requires canonical mapped paid facts and never grants production access", () => {
    const snapshot = {
      nativeState: "active",
      state: "ACTIVE" as const,
      planId: "fixture-plan",
      currency: "USD",
      exponent: 2,
      periodStart: "2026-11-01T00:00:00Z",
      periodEnd: "2026-12-01T00:00:00Z",
      paid: true,
      disputed: false,
      effects: [],
    };
    expect(
      projectSandboxSnapshot(snapshot, new Date("2026-11-03T00:00:00Z")),
    ).toMatchObject({
      state: "ACTIVE",
      sandboxEntitled: false,
      productionEntitled: false,
    });
    expect(
      projectSandboxSnapshot(
        { ...snapshot, paid: false },
        new Date("2026-11-03T00:00:00Z"),
      ),
    ).toMatchObject({ sandboxEntitled: false });
    expect(
      projectSandboxSnapshot(
        { ...snapshot, disputed: true },
        new Date("2026-11-03T00:00:00Z"),
      ),
    ).toMatchObject({ state: "DISPUTED", sandboxEntitled: false });
    expect(
      projectSandboxSnapshot(snapshot, new Date("2027-01-01T00:00:00Z")),
    ).toMatchObject({ sandboxEntitled: false });
  });
});

describe("Polar pinned SDK raw verifier", () => {
  const polarBody = () =>
    Buffer.from(
      JSON.stringify({
        type: "subscription.active",
        timestamp: "2026-11-01T00:00:00Z",
        data: {
          id: "sub_fixture",
          organization_id: "fixture_org",
          customer_id: "cust_fixture",
        },
      }),
    );
  const polarEndpoint = {
    mode: "SANDBOX" as const,
    merchantId: "fixture_org",
    secret:
      "whsec_" +
      Buffer.from("fixture-only-polar-key32bytes____").toString("base64"),
    keyVersion: "fixture-polar-v1",
  };
  async function verify(body: Buffer, raw: string[], config = polarEndpoint) {
    const { verifyPolarDelivery } =
      await import("../../packages/db/src/sandbox-billing-codecs");
    return verifyPolarDelivery(body, raw, config);
  }
  const signed = (body: Buffer, time = Math.floor(Date.now() / 1000)) => {
    const id = "polar_evt_fixture";
    const signature = createHmac(
      "sha256",
      Buffer.from(polarEndpoint.secret.slice(6), "base64"),
    )
      .update(`${id}.${time}.`)
      .update(body)
      .digest("base64");
    return [
      "webhook-id",
      id,
      "webhook-timestamp",
      String(time),
      "webhook-signature",
      `v1,${signature}`,
    ];
  };
  it("verifies original bytes with official versioned SDK and sanitizes output", async () => {
    const body = polarBody();
    expect(await verify(body, signed(body))).toMatchObject({
      provider: "POLAR",
      resourceId: "sub_fixture",
      contract: "@polar-sh/sdk@1.0.2/2026-04",
    });
    await expect(
      verify(Buffer.concat([body, Buffer.from(" ")]), signed(body)),
    ).rejects.toThrow("INVALID_BILLING_DELIVERY");
  });
  it("rejects stale/future transport despite historical event timestamps being valid", async () => {
    const body = polarBody();
    await expect(
      verify(body, signed(body, Math.floor(Date.now() / 1000) - 301)),
    ).rejects.toThrow();
    await expect(
      verify(body, signed(body, Math.floor(Date.now() / 1000) + 301)),
    ).rejects.toThrow();
  });
  it("supports versioned signatures and bounded previous key, rejects duplicate headers and wrong organization", async () => {
    const body = polarBody(),
      raw = signed(body);
    raw[5] = `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${raw[5]}`;
    expect(await verify(body, raw)).toMatchObject({ provider: "POLAR" });
    await expect(
      verify(body, [...raw, "Webhook-ID", "other"]),
    ).rejects.toThrow();
    await expect(
      verify(body, raw, { ...polarEndpoint, merchantId: "wrong_org" }),
    ).rejects.toThrow();
    const rotated = {
      ...polarEndpoint,
      secret: "new-fixture-key",
      previous: {
        secret: polarEndpoint.secret,
        keyVersion: "previous-fixture",
        until: new Date(Date.now() + 60000),
      },
    };
    expect(await verify(body, raw, rotated)).toMatchObject({
      keyVersion: "previous-fixture",
    });
    await expect(
      verify(body, raw, {
        ...rotated,
        previous: { ...rotated.previous, until: new Date(0) },
      }),
    ).rejects.toThrow();
  });
  it("rejects malformed UTF8 and oversize bytes before SDK verification", async () => {
    await expect(
      verify(Buffer.from([0xff]), signed(Buffer.from([0xff]))),
    ).rejects.toThrow();
    await expect(verify(Buffer.alloc(256 * 1024 + 1), [])).rejects.toThrow();
  });
});
