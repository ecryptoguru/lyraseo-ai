import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { webhooks } from "@polar-sh/sdk/2026-04";

export const BILLING_BODY_LIMIT = 256 * 1024;
export const POLAR_FIXTURE_CONTRACT = "@polar-sh/sdk@1.0.2/2026-04";
export type SandboxProvider = "RAZORPAY" | "POLAR";
export type SandboxState =
  | "NONE"
  | "PENDING"
  | "ACTIVE"
  | "PAST_DUE"
  | "CANCEL_AT_PERIOD_END"
  | "ENDED"
  | "DISPUTED";
export type TrustedSandboxEndpoint = {
  mode: "SANDBOX";
  merchantId: string;
  keyVersion: string;
  secret: string;
  previous?: { secret: string; keyVersion: string; until: Date };
};
export type VerifiedBillingEvent = {
  mode: "SANDBOX";
  provider: SandboxProvider;
  merchantId: string;
  externalId: string;
  payloadHash: string;
  keyVersion: string;
  type: string;
  resourceId: string;
  customerId: string | null;
  occurredAt: string;
  contract: string;
  sourceAccountVerified?: boolean;
  references?: {
    subscriptionId?: string;
    paymentId?: string;
    orderId?: string;
    refundId?: string;
    disputeId?: string;
    customerId?: string;
  };
};
function invalid(): never {
  throw new Error("INVALID_BILLING_DELIVERY");
}
const opaque = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value
    : invalid();
export function strictBillingHeaders(
  raw: readonly string[],
): Record<string, string> {
  if (raw.length % 2 || raw.length > 128) invalid();
  const headers: Record<string, string> = Object.create(null);
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i]!.toLowerCase(),
      value = raw[i + 1]!;
    if (
      !/^[a-z0-9-]{1,80}$/.test(key) ||
      key in headers ||
      value.length > 4096 ||
      /[\r\n]/.test(value)
    )
      invalid();
    headers[key] = value;
  }
  if (headers["content-encoding"] && headers["content-encoding"] !== "identity")
    invalid();
  return headers;
}
function decode(raw: Uint8Array): Record<string, unknown> {
  if (!raw.byteLength || raw.byteLength > BILLING_BODY_LIMIT) invalid();
  try {
    const result: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    );
    if (!result || typeof result !== "object" || Array.isArray(result))
      invalid();
    return result as Record<string, unknown>;
  } catch {
    return invalid();
  }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function opaqueReferences(values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, opaque(value)]),
  );
}
function keys(endpoint: TrustedSandboxEndpoint) {
  if (endpoint.mode !== "SANDBOX" || !endpoint.secret || !endpoint.keyVersion)
    invalid();
  if (
    endpoint.previous &&
    endpoint.previous.until.getTime() > Date.now() + 24 * 60 * 60 * 1000
  )
    invalid();
  return [
    { secret: endpoint.secret, keyVersion: endpoint.keyVersion },
    ...(endpoint.previous && endpoint.previous.until.getTime() > Date.now()
      ? [endpoint.previous]
      : []),
  ];
}
export function verifyRazorpayDelivery(
  raw: Uint8Array,
  rawHeaders: readonly string[],
  endpoint: TrustedSandboxEndpoint,
): VerifiedBillingEvent {
  const headers = strictBillingHeaders(rawHeaders);
  if (!/^[a-fA-F0-9]{64}$/.test(headers["x-razorpay-signature"] ?? ""))
    invalid();
  const signature = Buffer.from(headers["x-razorpay-signature"]!, "hex");
  if (raw.byteLength > BILLING_BODY_LIMIT) invalid();
  const key = keys(endpoint).find((candidate) =>
    timingSafeEqual(
      createHmac("sha256", candidate.secret).update(raw).digest(),
      signature,
    ),
  );
  if (!key) return invalid();
  const event = decode(raw);
  if (
    event.account_id !== endpoint.merchantId ||
    event.entity !== "event" ||
    typeof event.event !== "string" ||
    !/^(subscription|payment|refund|dispute)\.[a-z_]{1,64}(?:\.[a-z_]{1,64})?$/.test(
      event.event,
    ) ||
    typeof event.created_at !== "number" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0
  )
    invalid();
  const payload = object(event.payload);
  const family = event.event.includes("dispute")
    ? "dispute"
    : event.event.split(".")[0]!;
  const resource = object(object(payload[family]).entity),
    sub = object(object(payload.subscription).entity);
  const references = opaqueReferences({
    subscriptionId: resource.subscription_id ?? sub.id,
    paymentId:
      resource.payment_id ?? (family === "payment" ? resource.id : undefined),
    orderId: resource.order_id,
    refundId: family === "refund" ? resource.id : undefined,
    disputeId: family === "dispute" ? resource.id : undefined,
    customerId: resource.customer_id,
  });
  return {
    mode: "SANDBOX",
    provider: "RAZORPAY",
    sourceAccountVerified: true,
    references,
    merchantId: opaque(event.account_id),
    externalId: opaque(headers["x-razorpay-event-id"]),
    payloadHash: createHash("sha256").update(raw).digest("hex"),
    keyVersion: key.keyVersion,
    type: event.event,
    resourceId: opaque(resource?.id),
    customerId: resource?.customer_id ? opaque(resource.customer_id) : null,
    occurredAt: new Date(event.created_at * 1000).toISOString(),
    contract: "RAZORPAY_SANDBOX_FIXTURE_V1",
  };
}
export async function verifyPolarDelivery(
  raw: Uint8Array,
  rawHeaders: readonly string[],
  endpoint: TrustedSandboxEndpoint,
): Promise<VerifiedBillingEvent> {
  const headers = strictBillingHeaders(rawHeaders);
  const parsed = decode(raw); // fatal UTF-8 before SDK decoding; payload is never reserialized for verification.
  if (!/^\d{1,12}$/.test(headers["webhook-timestamp"] ?? "")) invalid();
  opaque(headers["webhook-id"]);
  let keyVersion: string | undefined;
  for (const candidate of keys(endpoint)) {
    try {
      await webhooks.validateEvent(raw, headers, candidate.secret);
      keyVersion = candidate.keyVersion;
      break;
    } catch {
      /* SDK errors may contain payload details; never retain them. */
    }
  }
  const data = object(parsed.data);
  const organization =
    data.organization_id ??
    object(data.product).organization_id ??
    object(data.order).organization_id ??
    object(data.customer).organization_id;
  if (
    !keyVersion ||
    (organization !== undefined && organization !== endpoint.merchantId) ||
    typeof parsed.type !== "string" ||
    !/^(subscription|order|refund)\.[a-z_]{1,64}$/.test(parsed.type) ||
    typeof parsed.timestamp !== "string" ||
    !Number.isFinite(Date.parse(parsed.timestamp))
  )
    return invalid();
  return {
    mode: "SANDBOX",
    provider: "POLAR",
    sourceAccountVerified: organization === endpoint.merchantId,
    references: opaqueReferences({
      subscriptionId: data.subscription_id ?? object(data.subscription).id,
      paymentId: data.payment_id,
      orderId: parsed.type.startsWith("order.")
        ? data.id
        : (data.order_id ?? object(data.order).id),
      refundId: parsed.type.startsWith("refund.") ? data.id : undefined,
      customerId: data.customer_id ?? object(data.customer).id,
    }),
    merchantId: opaque(endpoint.merchantId),
    externalId: opaque(headers["webhook-id"]),
    payloadHash: createHash("sha256").update(raw).digest("hex"),
    keyVersion,
    type: parsed.type,
    resourceId: opaque(data.id),
    customerId: data.customer_id ? opaque(data.customer_id) : null,
    occurredAt: new Date(parsed.timestamp).toISOString(),
    contract: POLAR_FIXTURE_CONTRACT,
  };
}
const exponents: Record<string, number> = {
  USD: 2,
  INR: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
  BHD: 3,
};
export function parseMinorUnits(
  value: unknown,
  currency: string,
  exponent: number,
): bigint {
  if (
    exponents[currency] !== exponent ||
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value)
  )
    throw new Error("INVALID_BILLING_AMOUNT");
  const amount = BigInt(value);
  if (amount > 9223372036854775807n) throw new Error("INVALID_BILLING_AMOUNT");
  return amount;
}
export type BillingEffect = {
  status?: "PENDING" | "FAILED" | "SUCCEEDED";
  resourceId?: string;
  periodStart?: string;
  periodEnd?: string;
  evidenceHash?: string;
  sourceContract?: "SYNTHETIC_CANONICAL_V2";
  kind: "PAYMENT" | "REFUND" | "DISPUTE_OPEN" | "DISPUTE_RESOLVED";
  reference: string;
  parentReference: string | null;
  amountMinor: string;
  currency: string;
  exponent: number;
};
export type SandboxSnapshot = {
  sourceIdentity?: {
    provider: string;
    merchantId: string;
    resourceId: string;
    customerId: string;
  };
  sourceVersion?: { qualification: "SYNTHETIC_COMPARABLE_V2"; value: string };
  externalPriceId?: string;
  priceMappingVersion?: string;
  paymentReference?: string | null;
  nativeState: string;
  state: SandboxState;
  planId: string | null;
  currency: string;
  exponent: number;
  periodStart: string | null;
  periodEnd: string | null;
  paid: boolean;
  disputed: boolean;
  effects: BillingEffect[];
};
export function projectSandboxSnapshot(
  snapshot: SandboxSnapshot,
  _now = new Date(),
) {
  if (
    ![
      "NONE",
      "PENDING",
      "ACTIVE",
      "PAST_DUE",
      "CANCEL_AT_PERIOD_END",
      "ENDED",
      "DISPUTED",
    ].includes(snapshot.state) ||
    !/^[a-z_]{1,64}$/.test(snapshot.nativeState) ||
    snapshot.effects.length > 100
  )
    throw new Error("INVALID_BILLING_SNAPSHOT");
  parseMinorUnits("0", snapshot.currency, snapshot.exponent);
  for (const effect of snapshot.effects) {
    opaque(effect.reference);
    if (effect.parentReference) opaque(effect.parentReference);
    if (
      effect.currency !== snapshot.currency ||
      effect.exponent !== snapshot.exponent
    )
      throw new Error("BILLING_CURRENCY_MISMATCH");
    parseMinorUnits(effect.amountMinor, effect.currency, effect.exponent);
  }
  return {
    ...snapshot,
    state: snapshot.disputed ? ("DISPUTED" as const) : snapshot.state,
    // Only locked reconciliation compares admitted resource, frozen price,
    // successful economic evidence and comparable canonical version.
    sandboxEntitled: false,
    productionEntitled: false as const,
  };
}
