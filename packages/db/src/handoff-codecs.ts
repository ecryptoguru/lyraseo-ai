import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normalizeUrl } from "@lyraseo/visibility/url";

export const handoffQualification = {
  liveEnabled: false,
  state: "UNQUALIFIED",
  reason:
    "Hosted egress, dedicated action admission and controlled destination acceptance are required.",
} as const;
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function outboundUrl(value: string) {
  const parsed = new URL(value);
  if (
    parsed.search ||
    parsed.hash ||
    value.includes("#") ||
    value.includes("?")
  )
    throw Error("INVALID_DESTINATION");
  return normalizeUrl(value);
}
export function wordpressRequest(
  installation: string,
  origin: string,
  draft: { title: string; body: string },
) {
  const url = new URL(outboundUrl(installation));
  if (
    url.origin !== origin ||
    !url.pathname.endsWith("/") ||
    /%2f|%5c/i.test(url.pathname) ||
    draft.title.length < 1 ||
    draft.title.length > 200 ||
    draft.body.length > 100000
  )
    throw Error("INVALID_WORDPRESS_REQUEST");
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]!,
    );
  const content = draft.body
    .split(/\r?\n\s*\r?\n/)
    .map((part) => `<p>${escape(part)}</p>`)
    .join("");
  const body = JSON.stringify({ title: draft.title, content, status: "draft" });
  if (Buffer.byteLength(body) > 524288)
    throw Error("INVALID_WORDPRESS_REQUEST");
  return {
    url: new URL("wp-json/wp/v2/posts?_fields=id,status,link", url).href,
    body,
    hash: sha256(body),
    rendererVersion: "literal-paragraphs-v1",
  };
}
export function wordpressReceipt(
  status: number,
  body: string,
  endpoint: string,
): {
  state: "CONFIRMED_DRAFT" | "REJECTED" | "UNRESOLVED";
  remotePostId?: number;
  editorUrl?: string;
} {
  if ([400, 401, 403, 404, 405, 413, 415, 422].includes(status))
    return { state: "REJECTED" };
  if (status !== 200 && status !== 201) return { state: "UNRESOLVED" };
  try {
    const data = JSON.parse(body);
    if (
      !Number.isSafeInteger(data.id) ||
      data.id <= 0 ||
      data.status !== "draft"
    )
      return { state: "UNRESOLVED" };
    const base = new URL(endpoint);
    base.pathname = base.pathname.replace(
      /wp-json\/wp\/v2\/posts$/,
      "wp-admin/post.php",
    );
    base.search = new URLSearchParams({
      post: String(data.id),
      action: "edit",
    }).toString();
    return {
      state: "CONFIRMED_DRAFT",
      remotePostId: data.id,
      editorUrl: base.href,
    };
  } catch {
    return { state: "UNRESOLVED" };
  }
}
export type WebhookEvent = {
  id: string;
  type: "test" | "audit.completed" | "report.created";
  workspaceId: string;
  siteId: string;
  occurredAt: string;
  resource: { kind: "test" | "audit" | "report"; id: string };
};
export function webhookEnvelope(input: WebhookEvent) {
  const expected = {
    test: "test",
    "audit.completed": "audit",
    "report.created": "report",
  };
  if (
    [input.id, input.workspaceId, input.siteId, input.resource?.id].some(
      (value) =>
        typeof value !== "string" || value.length < 1 || value.length > 128,
    ) ||
    typeof input.occurredAt !== "string" ||
    expected[input.type] !== input.resource.kind ||
    !Number.isFinite(Date.parse(input.occurredAt)) ||
    new Date(input.occurredAt).toISOString() !== input.occurredAt
  )
    throw Error("INVALID_EVENT");
  const body = JSON.stringify({
    id: input.id,
    type: input.type,
    version: 1,
    occurredAt: input.occurredAt,
    workspaceId: input.workspaceId,
    siteId: input.siteId,
    resource: { kind: input.resource.kind, id: input.resource.id },
  });
  if (Buffer.byteLength(body) > 16384) throw Error("INVALID_EVENT");
  return body;
}
function webhookKey(value: string) {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value)
    throw Error("INVALID_WEBHOOK_KEY");
  return bytes;
}
export function signWebhook(
  body: string,
  key: string,
  keyId: string,
  timestamp: number,
) {
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(keyId) ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  )
    throw Error("INVALID_SIGNATURE");
  const signature = createHmac("sha256", webhookKey(key))
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");
  return {
    "X-Lyraseo-Timestamp": String(timestamp),
    "X-Lyraseo-Key-Id": keyId,
    "X-Lyraseo-Signature": `v1=${signature}`,
  };
}
/** Receiver helper. Deduplicate the authenticated returned ID in the receiver's own transaction. */
export function verifyWebhook(
  body: string,
  headers: Record<string, string>,
  keys: Record<string, string>,
  nowSeconds: number,
) {
  const timestamp = headers["X-Lyraseo-Timestamp"],
    signature = headers["X-Lyraseo-Signature"],
    keyId = headers["X-Lyraseo-Key-Id"];
  if (
    Buffer.byteLength(body) > 16384 ||
    !timestamp ||
    !/^(0|[1-9][0-9]{0,12})$/.test(timestamp) ||
    !Number.isSafeInteger(nowSeconds) ||
    Math.abs(nowSeconds - Number(timestamp)) > 300 ||
    !signature ||
    !/^v1=[a-f0-9]{64}$/.test(signature) ||
    !keyId ||
    !Object.hasOwn(keys, keyId)
  )
    throw Error("INVALID_SIGNATURE");
  const expected = signWebhook(body, keys[keyId]!, keyId, Number(timestamp))[
    "X-Lyraseo-Signature"
  ].slice(3);
  if (
    !timingSafeEqual(
      Buffer.from(signature.slice(3), "hex"),
      Buffer.from(expected, "hex"),
    )
  )
    throw Error("INVALID_SIGNATURE");
  const event = JSON.parse(body);
  if (
    event.version !== 1 ||
    Object.keys(event).sort().join(",") !==
      "id,occurredAt,resource,siteId,type,version,workspaceId" ||
    !event.resource ||
    Object.keys(event.resource).sort().join(",") !== "id,kind"
  )
    throw Error("INVALID_EVENT");
  webhookEnvelope(event);
  return event as WebhookEvent & { version: 1 };
}
export function webhookOutcome(
  status: number | undefined,
  attempt: number,
  now: Date,
): { state: "DELIVERED" | "RETRY" | "FAILED"; nextDueAt: Date | null } {
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > 6 ||
    !Number.isFinite(now.getTime())
  )
    throw Error("INVALID_ATTEMPT");
  if (
    status !== undefined &&
    Number.isInteger(status) &&
    status >= 200 &&
    status <= 299
  )
    return { state: "DELIVERED", nextDueAt: null };
  const retryable =
    status === undefined ||
    status === 429 ||
    (Number.isInteger(status) && status >= 500 && status <= 599);
  if (!retryable || attempt === 6) return { state: "FAILED", nextDueAt: null };
  return {
    state: "RETRY",
    nextDueAt: new Date(
      now.getTime() + [60, 300, 1800, 7200, 43200][attempt - 1]! * 1000,
    ),
  };
}
