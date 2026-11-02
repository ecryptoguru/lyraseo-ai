// Both the Node receiver and future Worker signer use these exact wire bytes.
export const runtimePaths = [
  "/api/internal/runtime/dispatch",
  "/api/internal/runtime/dispatch/ack",
  "/api/internal/runtime/dispatch/defer",
  "/api/internal/runtime/step",
  "/api/internal/runtime/recover",
] as const;
export type RuntimePath = (typeof runtimePaths)[number];
export type RuntimeKey = Readonly<{
  id: string;
  principal: "lyraseo_dispatch";
  audience: "lyraseo-kernel-a";
  actions: readonly RuntimePath[];
  secret: Uint8Array<ArrayBuffer>;
}>;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = (): never => {
  throw new Error("INVALID_REQUEST");
};
export function canonicalRuntimeBytes(
  path: RuntimePath,
  h: Headers,
  hash: string,
) {
  const field = (k: string) => h.get("x-lyra-" + k) ?? invalid();
  const fields = [
    "lyra-runtime-v1",
    field("key-id"),
    field("principal"),
    field("audience"),
    "POST",
    path,
    field("issued-at"),
    field("expires-at"),
    field("request-id"),
    hash,
  ].map((x) => encoder.encode(x));
  const bytes = new Uint8Array(fields.reduce((n, f) => n + 4 + f.length, 0));
  const view = new DataView(bytes.buffer);
  let i = 0;
  for (const f of fields) {
    view.setUint32(i, f.length, false);
    bytes.set(f, i + 4);
    i += 4 + f.length;
  }
  return bytes;
}
export function runtimeBodyLimit(path: RuntimePath) {
  return path === runtimePaths[0] || path === runtimePaths[4] ? 8192 : 1024;
}
export async function authenticateRuntime(
  path: RuntimePath,
  headers: Headers,
  bytes: Uint8Array<ArrayBuffer>,
  keys: readonly RuntimeKey[],
  now = Math.floor(Date.now() / 1000),
) {
  const h = new Headers(headers);
  const id = h.get("x-lyra-key-id"),
    requestId = h.get("x-lyra-request-id"),
    principal = h.get("x-lyra-principal"),
    audience = h.get("x-lyra-audience");
  const matches = keys.filter((k) => k.id === id),
    key = matches[0];
  if (
    !key ||
    matches.length !== 1 ||
    !id ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
    key.principal !== "lyraseo_dispatch" ||
    key.audience !== "lyraseo-kernel-a" ||
    key.principal !== principal ||
    key.audience !== audience ||
    !key.actions.includes(path) ||
    key.secret.byteLength < 32 ||
    !requestId ||
    !uuid.test(requestId) ||
    bytes.length > runtimeBodyLimit(path)
  )
    invalid();
  // Bind the selected authority before the first asynchronous crypto call.
  // Only a closure can access these bytes; callers cannot replace the snapshot.
  const verifiedSecret = Uint8Array.from(key!.secret);
  const signedBytes = Uint8Array.from(bytes);
  const signerId = id!,
    signerPrincipal = principal!,
    signerAudience = audience!;
  const assertCurrentSigner = (keyring: readonly RuntimeKey[]) => {
    const matches = keyring.filter((candidate) => candidate.id === signerId);
    const active = matches[0];
    if (
      matches.length !== 1 ||
      !active ||
      active.principal !== signerPrincipal ||
      active.audience !== signerAudience ||
      !active.actions.includes(path) ||
      active.secret.length !== verifiedSecret.length ||
      !verifiedSecret.every((byte, index) => active.secret[index] === byte)
    )
      throw new Error("SIGNER_REVOKED");
  };
  const seconds = (s: string | null) =>
    s && /^[1-9][0-9]{0,10}$/.test(s) ? Number(s) : invalid();
  const issued = seconds(h.get("x-lyra-issued-at")),
    expires = seconds(h.get("x-lyra-expires-at"));
  if (
    issued > now + 30 ||
    expires <= now ||
    expires <= issued ||
    expires - issued > 60
  )
    invalid();
  const sig = h.get("x-lyra-signature");
  if (!sig || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(sig)) invalid();
  const signature = Uint8Array.from(
    atob(sig!.replace(/-/g, "+").replace(/_/g, "/") + "="),
    (x) => x.charCodeAt(0),
  );
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", signedBytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    verifiedSecret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      cryptoKey,
      signature,
      canonicalRuntimeBytes(path, h, hash),
    ))
  )
    invalid();
  if (
    signedBytes[0] === 239 &&
    signedBytes[1] === 187 &&
    signedBytes[2] === 191
  )
    invalid();
  const rawBody = new TextDecoder("utf-8", { fatal: true }).decode(signedBytes);
  return {
    assertCurrentSigner,
    requestId: requestId!,
    audience: audience!,
    issuedAt: new Date(issued * 1000),
    expiresAt: new Date(expires * 1000),
    rawBody,
  };
}
// All five schemas are flat. Consume a strict integer/string object directly to
// reject duplicate keys before a JSON parser or PostgreSQL jsonb can collapse them.
export function parseRuntimeBody(path: RuntimePath, raw: string) {
  const body: Record<string, string | number> = Object.create(null);
  const ws = "[ \\t\\r\\n]*";
  const inner =
    raw.match(new RegExp("^" + ws + "\\{([\\s\\S]*)\\}" + ws + "$"))?.[1] ??
    invalid();
  // JSON string escapes are decoded before comparing keys. Commas can only
  // separate pairs here: a comma inside any supported key or UUID is invalid.
  const quoted = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
  const pair = new RegExp(
    "^" +
      ws +
      "(" +
      quoted +
      ")" +
      ws +
      ":" +
      ws +
      "(" +
      quoted +
      "|[1-9][0-9]{0,9})" +
      ws +
      "$",
  );
  for (const part of inner.split(",")) {
    const match = pair.exec(part);
    if (!match) invalid();
    const key: string = JSON.parse(match![1]!);
    if (Object.hasOwn(body, key)) invalid();
    body[key] = JSON.parse(match![2]!);
  }
  const n = (k: string, max: number) =>
    typeof body[k] === "number" && body[k] <= max && body[k] >= 1;
  const id = (k: string) => typeof body[k] === "string" && uuid.test(body[k]);
  const count = Object.keys(body).length;
  if (path === runtimePaths[0] || path === runtimePaths[4]) {
    if (count !== 1 || !n("limit", 20)) invalid();
  } else {
    if (!id("workId") || !n("generation", 2147483647)) invalid();
    if (path === runtimePaths[3]) {
      if (count !== 3 || body.version !== 1) invalid();
    } else if (
      !id("claimToken") ||
      (path === runtimePaths[1]
        ? count !== 3
        : count !== 4 || !n("retrySeconds", 300))
    )
      invalid();
  }
  return body;
}
