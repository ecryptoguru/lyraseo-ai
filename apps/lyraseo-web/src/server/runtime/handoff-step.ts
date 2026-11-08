import { createHash, createHmac } from "node:crypto";
import {
  admitHandoff,
  checkHandoff,
  finishHandoff,
  type HandoffBinding,
} from "@lyraseo/db/bridge";
import type { createDatabase } from "@lyraseo/db";
import type { KernelRequest } from "@lyraseo/db/dispatch";
import type { HandoffFixture } from "./handoff-fixture";

const fields = [
  "url",
  "connectionUrl",
  "generation",
  "body",
  "bodyHash",
  "kind",
  "eventId",
  "cipher",
  "keyId",
  "previousCipher",
  "previousKeyId",
  "workspaceId",
  "siteId",
] as const;
function validate(b: HandoffBinding, fixture: HandoffFixture) {
  if (
    !b ||
    !["WORDPRESS", "WEBHOOK"].includes(b.kind) ||
    !Number.isSafeInteger(b.generation) ||
    b.generation < 1 ||
    typeof b.body !== "string" ||
    typeof b.cipher !== "string" ||
    !b.workspaceId ||
    !b.siteId ||
    createHash("sha256").update(b.body).digest("hex") !== b.bodyHash ||
    new URL(b.url).origin !== fixture.origin ||
    new URL(b.connectionUrl).origin !== fixture.origin ||
    (b.previousCipher === null) !== (b.previousKeyId === null)
  )
    throw Error("STALE_TARGET");
  if (b.kind === "WORDPRESS") {
    const connection = new URL(b.connectionUrl),
      endpoint = new URL(
        "wp-json/wp/v2/posts?_fields=id,status,link",
        connection,
      );
    const body = JSON.parse(b.body);
    if (
      !connection.pathname.endsWith("/") ||
      connection.search ||
      connection.hash ||
      endpoint.href !== b.url ||
      Buffer.byteLength(b.body) > 524288 ||
      Object.keys(body).sort().join(",") !== "content,status,title" ||
      body.status !== "draft" ||
      typeof body.title !== "string" ||
      body.title.length < 1 ||
      body.title.length > 200 ||
      typeof body.content !== "string" ||
      !body.content.startsWith("<p>") ||
      !body.content.endsWith("</p>") ||
      /[<>]/.test(body.content.replace(/<\/?p>/g, ""))
    )
      throw Error("STALE_TARGET");
  } else {
    const event = JSON.parse(b.body);
    if (
      b.url !== b.connectionUrl ||
      !b.eventId ||
      !b.keyId ||
      event.id !== b.eventId ||
      event.workspaceId !== b.workspaceId ||
      event.siteId !== b.siteId ||
      Buffer.byteLength(b.body) > 16384
    )
      throw Error("STALE_TARGET");
  }
}
function headers(b: HandoffBinding, fixture: HandoffFixture) {
  const secret = fixture.open(b.cipher, b);
  if (b.kind === "WORDPRESS") {
    const v = JSON.parse(secret);
    if (
      typeof v.username !== "string" ||
      !v.username ||
      v.username.length > 200 ||
      /[:\r\n]/.test(v.username) ||
      typeof v.applicationPassword !== "string" ||
      !v.applicationPassword ||
      v.applicationPassword.length > 1024 ||
      /[\r\n]/.test(v.applicationPassword)
    )
      throw Error("INVALID_CREDENTIAL");
    return {
      Authorization: `Basic ${Buffer.from(`${v.username}:${v.applicationPassword}`).toString("base64")}`,
    };
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = (key: string) => {
    const bytes = Buffer.from(key, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== key)
      throw Error("INVALID_CREDENTIAL");
    return (
      "v1=" +
      createHmac("sha256", bytes)
        .update(`${timestamp}.`)
        .update(b.body)
        .digest("hex")
    );
  };
  if (!b.keyId || !/^[A-Za-z0-9_-]{1,64}$/.test(b.keyId))
    throw Error("INVALID_CREDENTIAL");
  const result: Record<string, string> = {
    "X-Lyraseo-Timestamp": timestamp,
    "X-Lyraseo-Key-Id": b.keyId,
    "X-Lyraseo-Signature": signature(secret),
    "X-Lyraseo-Event-Id": b.eventId!,
  };
  if (b.previousCipher && b.previousKeyId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(b.previousKeyId))
      throw Error("INVALID_CREDENTIAL");
    result["X-Lyraseo-Previous-Key-Id"] = b.previousKeyId;
    result["X-Lyraseo-Previous-Signature"] = signature(
      fixture.open(b.previousCipher, b),
    );
  }
  return result;
}
function receipt(b: HandoffBinding, status: number | null, raw: string) {
  let outcome: string,
    remote: number | null = null,
    editor: string | null = null;
  if (b.kind === "WEBHOOK")
    outcome =
      status !== null && status >= 200 && status < 300
        ? "DELIVERED"
        : status === null || status === 429 || status >= 500
          ? "RETRY"
          : "FAILED";
  else if (
    status !== null &&
    [400, 401, 403, 404, 405, 413, 415, 422].includes(status)
  )
    outcome = "REJECTED";
  else {
    outcome = "UNRESOLVED";
    if (status === 200 || status === 201)
      try {
        const data = JSON.parse(raw);
        if (
          Number.isSafeInteger(data.id) &&
          data.id > 0 &&
          data.status === "draft"
        ) {
          remote = data.id;
          editor = b.url.replace(
            "wp-json/wp/v2/posts?_fields=id,status,link",
            `wp-admin/post.php?post=${remote}&action=edit`,
          );
          outcome = "CONFIRMED_DRAFT";
        }
      } catch {
        /* an ambiguous response never triggers another WordPress POST */
      }
  }
  return {
    outcome,
    status,
    code: status === null ? "TRANSPORT_UNKNOWN" : "HTTP_RESPONSE",
    remote,
    editor,
  };
}
export async function signedHandoffStep(
  db: ReturnType<typeof createDatabase>,
  envelope: KernelRequest,
  fixture: HandoffFixture,
  outer: AbortSignal,
  deadline: Date,
  assertSigner: () => void,
) {
  const attempt = await admitHandoff(db, envelope, deadline, () => {
    assertSigner();
    outer.throwIfAborted();
  });
  if (attempt.disposition !== "ADMITTED") return attempt;
  const controller = new AbortController(),
    signal = AbortSignal.any([outer, controller.signal]);
  let binding: HandoffBinding | undefined, active: Promise<void> | undefined;
  const check = () => {
    signal.throwIfAborted();
    try {
      assertSigner();
    } catch (error) {
      controller.abort();
      throw error;
    }
    if (!active) {
      const timer = setTimeout(() => controller.abort(), 650);
      active = checkHandoff(db, envelope.requestId, attempt.proof, deadline)
        .then((current) => {
          validate(current, fixture);
          if (
            current.kind !== attempt.kind ||
            (binding && fields.some((k) => binding![k] !== current[k]))
          )
            throw Error("STALE_ATTEMPT");
          binding ??= Object.freeze({ ...current });
        })
        .catch((error) => {
          controller.abort();
          throw error;
        })
        .finally(() => {
          clearTimeout(timer);
          active = undefined;
        });
    }
    return active;
  };
  const fresh = async () => {
    if (active) await active;
    await check();
    signal.throwIfAborted();
  };
  const poll = setInterval(() => {
    if (!signal.aborted)
      void Promise.resolve()
        .then(check)
        .catch(() => {});
  }, 200);
  try {
    await fresh();
    const frozen = binding!,
      requestHeaders = {
        "Content-Type": "application/json",
        ...headers(frozen, fixture),
      };
    let result: { status: number; body: string } | undefined;
    try {
      result = await fixture.post(
        frozen.url,
        frozen.body,
        requestHeaders,
        AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        fresh,
      );
    } catch {
      if (outer.aborted || controller.signal.aborted)
        throw Error("STALE_ATTEMPT");
    }
    clearInterval(poll);
    if (active) await active;
    // A timeout after opening is an unknown provider outcome, not a retryable WP create.
    assertSigner();
    outer.throwIfAborted();
    await fresh();
    return await finishHandoff(
      db,
      envelope.requestId,
      attempt.proof,
      receipt(frozen, result?.status ?? null, result?.body ?? ""),
      deadline,
      () => {
        assertSigner();
        outer.throwIfAborted();
      },
    );
  } finally {
    clearInterval(poll);
    controller.abort();
  }
}
