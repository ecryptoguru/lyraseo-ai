import type { IncomingMessage } from "node:http";
import {
  BILLING_BODY_LIMIT,
  strictBillingHeaders,
  verifyPolarDelivery,
  verifyRazorpayDelivery,
  type TrustedSandboxEndpoint,
} from "./sandbox-billing-codecs";
/** Raw Node seam. Stock Next Request does not retain duplicate header evidence.
 * No route enables this adapter until hosted raw-ingress/account qualification.
 */
export async function verifySandboxBillingRequest(
  request: IncomingMessage,
  endpoint: TrustedSandboxEndpoint,
) {
  if (
    request.method !== "POST" ||
    !["/api/billing/webhooks/razorpay", "/api/billing/webhooks/polar"].includes(
      request.url ?? "",
    )
  )
    throw new Error("INVALID_BILLING_DELIVERY");
  const headers = strictBillingHeaders(request.rawHeaders);
  if (
    headers.cookie ||
    headers.authorization ||
    Object.keys(headers).some(
      (key) => key.startsWith("x-lyra-") || key.startsWith("x-mcp-"),
    ) ||
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
      headers["content-type"] ?? "",
    )
  )
    throw new Error("INVALID_BILLING_DELIVERY");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const close = () => request.destroy();
  controller.signal.addEventListener("abort", close, { once: true });
  try {
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > BILLING_BODY_LIMIT)
        throw new Error("INVALID_BILLING_DELIVERY");
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks);
    return request.url === "/api/billing/webhooks/razorpay"
      ? verifyRazorpayDelivery(raw, request.rawHeaders, endpoint)
      : await verifyPolarDelivery(raw, request.rawHeaders, endpoint);
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", close);
    if (!request.complete) request.destroy();
  }
}
