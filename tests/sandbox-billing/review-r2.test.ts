import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  admin,
  runtime,
  recon,
  staff,
  q,
  actor,
  fixture,
  snapshot,
  apply,
} from "../helpers/sandbox-billing-review";
async function requestFixture() {
  const f = await fixture();
  await admin.query(
    'INSERT INTO "StaffGrant"("userId",enabled) VALUES($1,true)',
    [f.id],
  );
  await admin.query(
    "INSERT INTO lyraseo_billing.staff_capability(user_id,action) VALUES($1,'recovery:manage')",
    [f.id],
  );
  const requestId = randomUUID();
  await q(staff, "prepare_request", [
    f.a,
    requestId,
    "recovery:open",
    f.id,
    "{}",
    "R2 controlled recovery request",
  ]);
  return { ...f, requestId };
}
it("R2 wrong-price/version/missing mapping ENDED cannot retire or release a slot", async () => {
  for (const mismatch of [
    { externalPriceId: "price_b", priceMappingVersion: "v2" },
    { externalPriceId: "price_a", priceMappingVersion: "absent" },
    { externalPriceId: undefined, priceMappingVersion: undefined },
  ]) {
    const f = await fixture();
    await apply(f, snapshot(f));
    const result = await apply(f, {
      ...snapshot(f, 2),
      ...mismatch,
      state: "ENDED",
      nativeState: "ended",
      periodEnd: "2026-11-02T00:00:00Z",
      effects: [],
      paymentReference: null,
    });
    expect(result.reason).toBe("FROZEN_PRICE_CONFLICT");
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM lyraseo_billing.base_slot WHERE id=$1",
          [f.slot.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM lyraseo_billing.retirement WHERE resource_id=$1",
          [f.resource],
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(
      q(runtime, "reserve_slot", [
        f.a,
        f.id,
        "RAZORPAY",
        f.id,
        "price_a",
        "v1",
        "wrong-end-replacement",
      ]),
    ).rejects.toThrow("BASE_SLOT_OCCUPIED");
    await admin.query(
      "INSERT INTO lyraseo_billing.merchant(provider,merchant_id) VALUES('POLAR',$1)",
      [f.id],
    );
    await admin.query(
      "INSERT INTO lyraseo_billing.price_mapping(provider,merchant_id,external_price,version,plan_id,currency,exponent,amount_minor) VALUES('POLAR',$1,'price_p','v1','same_plan','USD',2,1000)",
      [f.id],
    );
    await expect(
      q(runtime, "reserve_slot", [
        f.a,
        f.id,
        "POLAR",
        f.id,
        "price_p",
        "v1",
        "wrong-end-cross-provider",
      ]),
    ).rejects.toThrow("BASE_SLOT_OCCUPIED");
    await expect(
      q(recon, "bind_subscription", [
        f.slot.id,
        f.resource,
        f.customer,
        "SYNTHETIC_EXTERNAL_BINDING_V2",
        "a".repeat(64),
      ]),
    ).resolves.toBeDefined();
  }
});
it("R2 expired unconsumed request can be confirmed and safely abandoned before a fresh request", async () => {
  const f = await requestFixture();
  await admin.query(
    "UPDATE lyraseo_billing.step_up SET expires_at=now()-interval '1 second' WHERE token_hash=(SELECT token_hash FROM lyraseo_billing.action_request WHERE id=$1)",
    [f.requestId],
  );
  expect(
    await q(staff, "resolve_request", [f.a, f.requestId, "STATUS"]),
  ).toMatchObject({
    requestState: "AUTHORIZATION_EXPIRED",
    committed: false,
    canAbandon: true,
  });
  expect(
    await q(staff, "resolve_request", [f.a, f.requestId, "ABANDON"]),
  ).toMatchObject({ requestState: "ABANDONED", committed: false });
  expect(await q(staff, "execute_request", [f.a, f.requestId])).toMatchObject({
    requestState: "ABANDONED",
    committed: false,
  });
  await expect(
    q(staff, "prepare_request", [
      f.a,
      randomUUID(),
      "recovery:open",
      f.id,
      "{}",
      "new reviewed request after abandon",
    ]),
  ).resolves.toMatchObject({ state: "PREPARED" });
});
it("R2 lost committed response resolves from a new current session without allowing a replacement", async () => {
  const f = await requestFixture(),
    first = await q(staff, "execute_request", [f.a, f.requestId]),
    rotated = { ...f.a, sessionId: "rotated_" + f.id };
  await admin.query(
    'INSERT INTO "ProductSession"("sessionId","userId","securityVersion","createdAt","refreshedAt") VALUES($1,$2,0,now(),now())',
    [rotated.sessionId, f.id],
  );
  await expect(
    q(staff, "prepare_request", [
      rotated,
      randomUUID(),
      "recovery:open",
      f.id,
      "{}",
      "would duplicate a committed case",
    ]),
  ).rejects.toThrow("UNRESOLVED_STAFF_REQUEST");
  const recovered = await q(staff, "resolve_request", [
    rotated,
    f.requestId,
    "STATUS",
  ]);
  expect(recovered).toMatchObject({
    requestState: "COMMITTED",
    committed: true,
    result: { id: first.id, state: "VERIFYING" },
  });
  expect(
    await q(staff, "ack_request", [rotated, f.requestId, recovered.resultHash]),
  ).toMatchObject({ requestState: "ACKNOWLEDGED" });
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.recovery_case WHERE opened_by=$1",
        [f.id],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("R2 concurrent execute versus safe abandon commits at most one case and preserves a terminal resolution", async () => {
  const f = await requestFixture();
  const results = await Promise.all([
    q(staff, "execute_request", [f.a, f.requestId]),
    q(staff, "resolve_request", [f.a, f.requestId, "ABANDON"]),
  ]);
  const state = (
    await q(staff, "resolve_request", [f.a, f.requestId, "STATUS"])
  ).requestState;
  expect(["COMMITTED", "ABANDONED"]).toContain(state);
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.recovery_case WHERE opened_by=$1",
        [f.id],
      )
    ).rows[0].n,
  ).toBe(state === "COMMITTED" ? 1 : 0);
  expect(results.every((x) => x.requestState === state)).toBe(true);
});
it("R2 definitive target conflict has a server-confirmed unconsumed abandon path", async () => {
  const f = await requestFixture();
  await q(staff, "resolve_request", [f.a, f.requestId, "ABANDON"]);
  const missing = randomUUID(),
    id = randomUUID();
  await q(staff, "prepare_request", [
    f.a,
    id,
    "recovery:approve",
    missing,
    JSON.stringify({ expectedRevision: 7 }),
    "controlled missing target conflict",
  ]);
  expect(await q(staff, "execute_request", [f.a, id])).toMatchObject({
    requestState: "REJECTED",
    committed: false,
    canAbandon: true,
    reason: "TARGET_CONFLICT",
  });
  expect(await q(staff, "resolve_request", [f.a, id, "ABANDON"])).toMatchObject(
    { requestState: "ABANDONED", committed: false },
  );
});
it("R2 other principals cannot resolve or acknowledge another staff request", async () => {
  const first = await requestFixture(),
    other = await requestFixture();
  await q(staff, "execute_request", [first.a, first.requestId]);
  await expect(
    q(staff, "resolve_request", [other.a, first.requestId, "STATUS"]),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    q(staff, "ack_request", [other.a, first.requestId, "a".repeat(64)]),
  ).rejects.toThrow("FORBIDDEN");
});
it("R2 lost prepare acknowledgement and concurrent execute retries consume one frozen request", async () => {
  const f = await requestFixture();
  const prepared = await q(staff, "prepare_request", [
    f.a,
    f.requestId,
    "recovery:open",
    f.id,
    "{}",
    "R2 controlled recovery request",
  ]);
  expect(prepared).toMatchObject({ requestId: f.requestId });
  const [first, second] = await Promise.all([
    q(staff, "execute_request", [f.a, f.requestId]),
    q(staff, "execute_request", [f.a, f.requestId]),
  ]);
  expect(first.id).toBe(second.id);
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.recovery_case WHERE opened_by=$1",
        [f.id],
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    q(staff, "ack_request", [f.a, f.requestId, "0".repeat(64)]),
  ).rejects.toThrow();
  const observed = await q(staff, "resolve_request", [
    f.a,
    f.requestId,
    "STATUS",
  ]);
  const [a, b] = await Promise.all([
    q(staff, "ack_request", [f.a, f.requestId, observed.resultHash]),
    q(staff, "ack_request", [f.a, f.requestId, observed.resultHash]),
  ]);
  expect(a.requestState).toBe("ACKNOWLEDGED");
  expect(b.requestState).toBe("ACKNOWLEDGED");
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM lyraseo_billing.staff_receipt WHERE staff_id=$1 AND outcome='ACKNOWLEDGED'",
        [f.id],
      )
    ).rows[0].n,
  ).toBe(1);
});
