import {
  canonicalRuntimeBytes,
  parseRuntimeBody,
  runtimeBodyLimit,
  runtimePaths,
  type RuntimePath,
} from "@lyraseo/contracts/runtime-signing";

export type QueueRef = { version: 1; workId: string; generation: number };
export type DispatchRef = Omit<QueueRef, "version"> & { claimToken: string };
export type BridgeResult = {
  disposition: string;
  refs?: DispatchRef[];
};
export class CarrierError extends Error {
  constructor(
    public readonly code:
      | "CONFIGURATION"
      | "TRANSPORT"
      | "INVALID_RESPONSE"
      | "AUTHENTICATION"
      | "CONFLICT"
      | "UNAVAILABLE"
      | "DEADLINE",
  ) {
    super(code);
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) =>
  Object.keys(x).length === keys.length &&
  keys.every((k) => Object.hasOwn(x, k));
const integer = (x: unknown, min: number, max: number): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;
const id = (x: unknown): x is string => typeof x === "string" && uuid.test(x);
export function isQueueRef(x: unknown): x is QueueRef {
  return (
    object(x) &&
    exact(x, ["version", "workId", "generation"]) &&
    x.version === 1 &&
    id(x.workId) &&
    integer(x.generation, 1, 2147483647)
  );
}
function isDispatchRef(x: unknown): x is DispatchRef {
  return (
    object(x) &&
    exact(x, ["workId", "generation", "claimToken"]) &&
    id(x.workId) &&
    integer(x.generation, 1, 2147483647) &&
    id(x.claimToken)
  );
}
// B responses use only strings, integers, arrays and objects. Parse this small
// grammar before JSON can collapse duplicate (including escaped) object keys.
function parseResponse(raw: string): unknown {
  let offset = 0;
  const fail = (): never => {
    throw new CarrierError("INVALID_RESPONSE");
  };
  const ws = () => {
    while (/[ \t\r\n]/.test(raw[offset] ?? "!") && offset < raw.length)
      offset++;
  };
  const string = (): string => {
    const match =
      /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(
        raw.slice(offset),
      );
    if (!match) return fail();
    offset += match[0].length;
    return JSON.parse(match[0]);
  };
  const value = (depth: number): unknown => {
    if (depth > 4) return fail();
    ws();
    const start = raw[offset];
    if (start === '"') return string();
    if (start === "{" || start === "[") {
      offset++;
      ws();
      const result: Record<string, unknown> = Object.create(null),
        array: unknown[] = [];
      const end = start === "{" ? "}" : "]";
      if (raw[offset] === end) {
        offset++;
        return start === "{" ? result : array;
      }
      for (;;) {
        if (start === "{") {
          const key = string();
          ws();
          if (Object.hasOwn(result, key) || raw[offset++] !== ":")
            return fail();
          result[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        ws();
        const token = raw[offset++];
        if (token === end) break;
        if (token !== ",") return fail();
        ws();
      }
      return start === "{" ? result : array;
    }
    const number = /^(0|[1-9][0-9]*)/.exec(raw.slice(offset));
    if (!number) return fail();
    offset += number[0].length;
    return Number(number[0]);
  };
  const result = value(0);
  ws();
  if (offset !== raw.length) return fail();
  return result;
}
export function validateResponse(path: RuntimePath, x: unknown): BridgeResult {
  const invalid = (): never => {
    throw new CarrierError("INVALID_RESPONSE");
  };
  if (!object(x) || typeof x.disposition !== "string") return invalid();
  const d = x.disposition;
  if (path === runtimePaths[0] && (d === "OK" || d === "PAUSED")) {
    if (
      !exact(x, ["disposition", "refs"]) ||
      !Array.isArray(x.refs) ||
      x.refs.length > 1 ||
      !x.refs.every(isDispatchRef) ||
      (d === "PAUSED" && x.refs.length !== 0)
    )
      return invalid();
    return { disposition: d, refs: x.refs };
  }
  if (path === runtimePaths[4] && d === "OK") {
    if (
      !exact(x, ["disposition", "reopened", "suppressed", "reconciliation"]) ||
      ![x.reopened, x.suppressed, x.reconciliation].every((n) =>
        integer(n, 0, 20),
      ) ||
      Number(x.reopened) + Number(x.suppressed) + Number(x.reconciliation) > 20
    )
      return invalid();
    return { disposition: d };
  }
  const accepted =
    path === runtimePaths[3]
      ? ["COMPLETED", "YIELDED", "STALE", "IN_PROGRESS"]
      : path === runtimePaths[1]
        ? ["DELIVERED", "STALE", "PAUSED", "IN_PROGRESS"]
        : path === runtimePaths[2]
          ? ["DEFERRED", "STALE", "PAUSED", "IN_PROGRESS"]
          : ["IN_PROGRESS"];
  if (!exact(x, ["disposition"]) || !accepted.includes(d)) return invalid();
  return { disposition: d };
}
export function configuration(env: Env) {
  if (!env.WORK_QUEUE || typeof env.WORK_QUEUE.send !== "function")
    throw new CarrierError("CONFIGURATION");
  if (env.CARRIER_QUALIFIED !== "true" || env.CARRIER_ENABLED !== "true")
    throw new CarrierError("CONFIGURATION");
  let url: URL;
  try {
    url = new URL(env.BRIDGE_ORIGIN);
  } catch {
    throw new CarrierError("CONFIGURATION");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== env.BRIDGE_ORIGIN ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    typeof env.BRIDGE_KEY_ID !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(env.BRIDGE_KEY_ID) ||
    env.BRIDGE_PRINCIPAL !== "lyraseo_dispatch" ||
    env.BRIDGE_AUDIENCE !== "lyraseo-kernel-a"
  )
    throw new CarrierError("CONFIGURATION");
  // Canonical unpadded base64url bytes; matches B's >=32-byte secret requirement.
  const secret = env.BRIDGE_SECRET;
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43,1366}$/.test(secret))
    throw new CarrierError("CONFIGURATION");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(
      atob(
        secret.replace(/-/g, "+").replace(/_/g, "/") +
          "=".repeat((4 - (secret.length % 4)) % 4),
      ),
      (c) => c.charCodeAt(0),
    );
  } catch {
    throw new CarrierError("CONFIGURATION");
  }
  if (bytes.length < 32 || base64url(bytes) !== secret)
    throw new CarrierError("CONFIGURATION");
  return {
    origin: url.origin,
    keyId: env.BRIDGE_KEY_ID,
    principal: env.BRIDGE_PRINCIPAL,
    audience: env.BRIDGE_AUDIENCE,
    secret: bytes,
  };
}
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export type SigningConfig = ReturnType<typeof configuration>;
export type Envelope = Readonly<{
  path: RuntimePath;
  body: string;
  headers: Headers;
  expires: number;
}>;
export async function signEnvelope(
  config: SigningConfig,
  path: RuntimePath,
  body: string,
  issued = Math.floor(Date.now() / 1000),
  requestId: string = crypto.randomUUID(),
): Promise<Envelope> {
  if (
    !runtimePaths.includes(path) ||
    !Number.isSafeInteger(issued) ||
    issued <= 0 ||
    !uuid.test(requestId)
  )
    throw new CarrierError("CONFIGURATION");
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > runtimeBodyLimit(path))
    throw new CarrierError("CONFIGURATION");
  parseRuntimeBody(path, body);
  const headers = new Headers({
    "content-type": "application/json",
    "x-lyra-key-id": config.keyId,
    "x-lyra-principal": config.principal,
    "x-lyra-audience": config.audience,
    "x-lyra-issued-at": String(issued),
    "x-lyra-expires-at": String(issued + 60),
    "x-lyra-request-id": requestId,
  });
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    config.secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  headers.set(
    "x-lyra-signature",
    base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          canonicalRuntimeBytes(path, headers, digest),
        ),
      ),
    ),
  );
  return { path, body, headers, expires: issued + 60 };
}
export type Transport = (request: Request) => Promise<Response>;
export class Bridge {
  readonly config: SigningConfig;
  constructor(
    env: Env,
    private readonly transport: Transport = (request) => fetch(request),
  ) {
    this.config = configuration(env);
  }
  async command(
    path: RuntimePath,
    body: object,
    deadline: number,
    replay = false,
  ) {
    const envelope = await signEnvelope(
      this.config,
      path,
      JSON.stringify(body),
    );
    try {
      return await this.send(envelope, deadline);
    } catch (error) {
      // Only unknown transport outcomes can replay, once, byte-for-byte while fresh.
      if (
        !replay ||
        !(error instanceof CarrierError) ||
        error.code !== "TRANSPORT" ||
        Date.now() >= deadline ||
        Math.floor(Date.now() / 1000) >= envelope.expires
      )
        throw error;
      return this.send(envelope, deadline);
    }
  }
  async send(envelope: Envelope, deadline: number): Promise<BridgeResult> {
    if (Math.floor(Date.now() / 1000) >= envelope.expires)
      throw new CarrierError("DEADLINE");
    const cutoff = Math.min(
      deadline,
      envelope.expires * 1000,
      Date.now() + (envelope.path === runtimePaths[3] ? 47000 : 8000),
    );
    const remaining = cutoff - Date.now();
    if (remaining <= 0) throw new CarrierError("DEADLINE");
    const abort = new AbortController();
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const assertFresh = () => {
      if (abort.signal.aborted || Date.now() >= cutoff)
        throw new CarrierError("TRANSPORT");
    };
    const action = async () => {
      response = await this.transport(
        new Request(this.config.origin + envelope.path, {
          method: "POST",
          headers: envelope.headers,
          body: envelope.body,
          redirect: "manual",
          signal: abort.signal,
        }),
      );
      if (abort.signal.aborted || Date.now() >= cutoff) {
        void response.body?.cancel().catch(() => {});
        throw new CarrierError("TRANSPORT");
      }
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400) ||
        response.headers.has("content-encoding") ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          response.headers.get("content-type") ?? "",
        ) ||
        !response.body
      )
        throw new CarrierError("INVALID_RESPONSE");
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 32768)
      )
        throw new CarrierError("INVALID_RESPONSE");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        assertFresh();
        if (done) break;
        size += value.length;
        if (size > 32768) throw new CarrierError("INVALID_RESPONSE");
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191)
        throw new CarrierError("INVALID_RESPONSE");
      let result: unknown;
      try {
        result = parseResponse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new CarrierError("INVALID_RESPONSE");
      }
      if (response.status !== 200) {
        // Error responses cannot authorize a Queue acknowledgement.
        if (response.status === 401) throw new CarrierError("AUTHENTICATION");
        if (response.status === 409) throw new CarrierError("CONFLICT");
        throw new CarrierError("UNAVAILABLE");
      }
      const validated = validateResponse(envelope.path, result);
      assertFresh();
      return validated;
    };
    try {
      const result = await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            void reader?.cancel().catch(() => {});
            reject(new CarrierError("TRANSPORT"));
          }, remaining);
        }),
      ]);
      assertFresh();
      return result;
    } catch (error) {
      abort.abort();
      if (reader) void reader.cancel().catch(() => {});
      else if (response?.body) void response.body.cancel().catch(() => {});
      if (error instanceof CarrierError) throw error;
      throw new CarrierError("TRANSPORT");
    } finally {
      clearTimeout(timer);
    }
  }
}
