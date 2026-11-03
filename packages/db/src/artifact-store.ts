// Local controlled backend. A generation is allocated by the DB before any I/O.
// Exclusive creation plus DB publication avoids a second, untracked plaintext temp file.
import { isDeepStrictEqual } from "node:util";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export const SOURCE_LIMIT = 5 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export interface ArtifactVersion {
  workspaceId: string;
  storageKey: string;
  generation: string;
  codec: "IDENTITY";
  sourceHash: string;
  sourceLength: number;
  storedHash: string;
  storedLength: number;
  /** SQL-owned immutable binding; absent on legacy/unqualified generations. */
  origin?: string;
}
type Physical = Pick<ArtifactVersion, "storageKey" | "generation">;
export interface AuditArtifactStore {
  readonly qualification: "LOCAL_TEST_ONLY";
  close(): Promise<void>;
  inspectOrigin(workspace: string): Promise<LocalArtifactOrigin>;
  putImmutable(version: ArtifactVersion, bytes: Uint8Array): Promise<void>;
  statVersion(version: ArtifactVersion): Promise<boolean>;
  openBounded(version: ArtifactVersion): Promise<Uint8Array>;
  recoverReservedVersion(version: ArtifactVersion): Promise<Uint8Array>;
  deleteExactVersion(version: ArtifactVersion): Promise<void>;
  inventoryPage(
    workspace: string,
    after: Physical | null,
    limit: number,
  ): Promise<Physical[]>;
}
export type LocalArtifactOrigin = {
  assertionVersion: "STORE_ORIGIN_V1";
  qualification: "LOCAL_TEST_ONLY";
  backend: "POSIX_FD_V1";
  root: { identity: string[]; stamp: string[]; instance: string };
  namespace: { identity: string[]; stamp: string[] };
};
type OriginCapability = {
  inspect(workspace: string): Promise<LocalArtifactOrigin>;
  provision(workspace: string): Promise<LocalArtifactOrigin>;
};
// Exact object identity is authority. There is no exposed/copyable witness token.
const localOrigins = new WeakMap<AuditArtifactStore, OriginCapability>();
function physicalOrigin(value: string, workspace: string): LocalArtifactOrigin {
  let origin;
  try {
    origin = JSON.parse(value);
  } catch {
    throw invalid();
  }
  if (
    origin.assertionVersion !== "STORE_ORIGIN_V1" ||
    origin.qualification !== "LOCAL_TEST_ONLY" ||
    origin.backend !== "POSIX_FD_V1" ||
    origin.workspaceId !== workspace ||
    !uuid.test(origin.storeId) ||
    !uuid.test(origin.namespaceId)
  )
    throw invalid();
  return {
    assertionVersion: origin.assertionVersion,
    qualification: origin.qualification,
    backend: origin.backend,
    root: origin.root,
    namespace: origin.namespace,
  };
}
/** Nonmutating private witness: injectable inspectOrigin JSON is never consulted. */
export async function assertLocalArtifactOrigin(
  store: AuditArtifactStore,
  workspace: string,
  expected: string,
) {
  const capability = localOrigins.get(store);
  if (!capability) throw Error("ARTIFACT_UNAVAILABLE");
  const wanted = physicalOrigin(expected, workspace),
    actual = await capability.inspect(workspace);
  if (!isDeepStrictEqual(actual, wanted)) throw Error("ARTIFACT_UNAVAILABLE");
}
/** Explicit isolated operator operation only. Never called by reads or selected writers. */
export async function provisionLocalArtifactNamespace(
  store: AuditArtifactStore,
  workspace: string,
) {
  const capability = localOrigins.get(store);
  if (!capability) throw Error("ARTIFACT_UNAVAILABLE");
  return capability.provision(workspace);
}
const invalid = () => new Error("INVALID_ARTIFACT");
function prefix(workspace: string) {
  if (!workspace || workspace.length > 256) throw invalid();
  return hash(workspace);
}
function suffix(v: Physical) {
  if (!uuid.test(v.storageKey) || !uuid.test(v.generation)) throw invalid();
  return v.storageKey + "." + v.generation;
}
function possible(v: ArtifactVersion) {
  if (
    v.codec !== "IDENTITY" ||
    !Number.isSafeInteger(v.sourceLength) ||
    v.sourceLength < 0 ||
    v.sourceLength > SOURCE_LIMIT ||
    !/^[a-f0-9]{64}$/.test(v.sourceHash) ||
    v.sourceHash !== v.storedHash ||
    v.sourceLength !== v.storedLength
  )
    throw invalid();
}
function matches(bytes: Uint8Array, v: ArtifactVersion) {
  if (bytes.byteLength !== v.storedLength || hash(bytes) !== v.storedHash)
    throw invalid();
}
const helperPath = fileURLToPath(
  new URL("./artifact-posix.py", import.meta.url),
);
const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export async function localAuditArtifactStore(
  root: string,
  afterNamespacePinned?: () => Promise<void>,
): Promise<AuditArtifactStore> {
  if (!["darwin", "linux"].includes(process.platform) || !isAbsolute(root))
    throw invalid();
  const python = await realpath("/usr/bin/python3"),
    helper = await realpath(helperPath);
  const [interpreter, script] = await Promise.all([
    stat(python),
    lstat(helperPath),
  ]);
  if (
    !python.startsWith("/usr/bin/") ||
    interpreter.uid !== 0 ||
    !interpreter.isFile() ||
    (interpreter.mode & 0o022) !== 0 ||
    !script.isFile() ||
    ![0, process.getuid?.()].includes(script.uid) ||
    (script.mode & 0o022) !== 0
  )
    throw invalid();
  let running = 0;
  async function invoke(
    header: Record<string, unknown>,
    fd: number,
    bytes?: Uint8Array,
  ): Promise<Buffer> {
    if (running >= 8) throw Error("ARTIFACT_UNAVAILABLE");
    running++;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(python, ["-I", "-S", "-B", helper], {
          shell: false,
          env: { NODE_ENV: "test" },
          stdio: ["pipe", "pipe", "ignore", fd, "pipe"],
        });
        const out: Buffer[] = [];
        let total = 0,
          failed = false;
        const abort = () => {
          failed = true;
          child.kill("SIGKILL");
        };
        const timer = setTimeout(abort, 5000);
        child.on("error", () => {
          clearTimeout(timer);
          reject(Error("ARTIFACT_UNAVAILABLE"));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0 || failed) reject(Error("ARTIFACT_UNAVAILABLE"));
          else resolve(Buffer.concat(out));
        });
        child.stdin!.on("error", () => {});
        child.stdout!.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > SOURCE_LIMIT) abort();
          else out.push(chunk);
        });
        const barrier = child.stdio[4] as Readable;
        barrier.once("data", () => {
          void Promise.resolve()
            .then(() =>
              ["origin", "provision"].includes(String(header.op))
                ? undefined
                : afterNamespacePinned?.(),
            )
            .then(() => child.stdin!.end(bytes), abort);
        });
        child.stdin!.write(JSON.stringify(header) + "\n");
        if (header.op === "bootstrap") child.stdin!.end();
      });
    } finally {
      running--;
    }
  }
  // Hold a candidate before walking the path. Enrollment authorizes only the exact
  // inode reached by the helper's no-follow component walk from the filesystem root.
  const rootHandle = await open(root, directoryFlags);
  let enrolled: [string, string];
  try {
    const fsRoot = await open("/", directoryFlags);
    try {
      enrolled = JSON.parse(
        (
          await invoke(
            { op: "bootstrap", parts: root.split("/").slice(1) },
            fsRoot.fd,
          )
        ).toString(),
      );
    } finally {
      await fsRoot.close();
    }
    const initial = await rootHandle.stat({ bigint: true });
    if (
      initial.dev.toString() !== enrolled[0] ||
      initial.ino.toString() !== enrolled[1]
    )
      throw invalid();
  } catch (error) {
    await rootHandle.close();
    throw error;
  }
  const pending = new Set<Promise<Buffer>>();
  let closing: Promise<void> | undefined;
  async function stillAddressable() {
    const st = await lstat(root, { bigint: true });
    if (
      !st.isDirectory() ||
      st.dev.toString() !== enrolled[0] ||
      st.ino.toString() !== enrolled[1] ||
      (st.mode & 0o777n) !== 0o700n
    )
      throw invalid();
  }
  async function call(
    op: string,
    workspace: string,
    fields: Record<string, unknown>,
    bytes?: Uint8Array,
  ) {
    if (closing || pending.size >= 8) throw Error("ARTIFACT_UNAVAILABLE");
    const operation = (async () => {
      await stillAddressable();
      const result = await invoke(
        {
          op,
          namespace: prefix(workspace),
          root: enrolled,
          parts: root.split("/").slice(1),
          ...fields,
        },
        rootHandle.fd,
        bytes,
      );
      await stillAddressable();
      return result;
    })();
    pending.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(operation);
    }
  }
  function version(op: string, v: ArtifactVersion, bytes?: Uint8Array) {
    possible(v);
    return call(
      op,
      v.workspaceId,
      {
        name: suffix(v),
        size: v.storedLength,
        digest: v.storedHash,
        ...(v.origin
          ? { origin: physicalOrigin(v.origin, v.workspaceId) }
          : {}),
      },
      bytes,
    );
  }
  const store: AuditArtifactStore = {
    qualification: "LOCAL_TEST_ONLY",
    inspectOrigin: (workspace) => inspect(workspace, "origin"),
    close() {
      return (closing ??= (async () => {
        await Promise.allSettled([...pending]);
        await rootHandle.close();
      })());
    },
    async putImmutable(v, bytes) {
      possible(v);
      if (!v.origin) throw Error("ARTIFACT_UNAVAILABLE");
      matches(bytes, v);
      await version("put", v, Buffer.from(bytes));
    },
    async statVersion(v) {
      const result = (await version("stat", v)).toString();
      if (result !== "true" && result !== "false") throw invalid();
      return result === "true";
    },
    openBounded: (v) => version("open", v),
    recoverReservedVersion: (v) => version("recover", v),
    async deleteExactVersion(v) {
      await version("delete", v);
    },
    async inventoryPage(workspace, after, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
      return JSON.parse(
        (
          await call("inventory", workspace, {
            after: after ? suffix(after) : "",
            limit,
          })
        ).toString(),
      );
    },
  };
  async function inspect(workspace: string, op: "origin" | "provision") {
    return JSON.parse(
      (await call(op, workspace, {})).toString(),
    ) as LocalArtifactOrigin;
  }
  localOrigins.set(store, {
    inspect: (workspace) => inspect(workspace, "origin"),
    provision: (workspace) => inspect(workspace, "provision"),
  });
  return Object.freeze(store);
}
export type LocalArtifactFaultHooks = {
  before?: (
    operation: string,
    version?: ArtifactVersion,
  ) => Promise<void> | void;
  after?: (
    operation: string,
    version?: ArtifactVersion,
  ) => Promise<void> | void;
  readMutation?: "flip" | "truncate" | "zeros";
};
/** Fixed trusted fault facade. Hooks cannot replace the real I/O or supply witness evidence. */
export function localArtifactFaultFacade(
  store: AuditArtifactStore,
  hooks: LocalArtifactFaultHooks,
): AuditArtifactStore {
  const capability = localOrigins.get(store);
  if (!capability) throw Error("ARTIFACT_UNAVAILABLE");
  const before = hooks.before,
    after = hooks.after,
    mutation = hooks.readMutation;
  async function io<T>(
    kind: string,
    v: ArtifactVersion | undefined,
    work: () => Promise<T>,
  ) {
    // Hooks observe a frozen copy; they cannot redirect the delegate's generation.
    const observed = v ? Object.freeze({ ...v }) : undefined;
    await before?.(kind, observed);
    const result = await work();
    await after?.(kind, observed);
    return result;
  }
  const facade: AuditArtifactStore = {
    qualification: "LOCAL_TEST_ONLY",
    close: () => store.close(),
    inspectOrigin: (w) => capability.inspect(w),
    putImmutable: (v, b) => io("put", v, () => store.putImmutable(v, b)),
    statVersion: (v) => io("stat", v, () => store.statVersion(v)),
    openBounded: async (v) => {
      const bytes = await io("read", v, () => store.openBounded(v));
      if (mutation === "truncate") return bytes.slice(1);
      if (mutation === "zeros") return new Uint8Array(bytes.length);
      if (mutation === "flip") {
        const copy = new Uint8Array(bytes);
        if (copy.length) copy[0]! ^= 1;
        return copy;
      }
      return bytes;
    },
    recoverReservedVersion: (v) =>
      io("recover", v, () => store.recoverReservedVersion(v)),
    deleteExactVersion: (v) =>
      io("delete", v, () => store.deleteExactVersion(v)),
    inventoryPage: (w, a, l) =>
      io("inventory", undefined, () => store.inventoryPage(w, a, l)),
  };
  localOrigins.set(facade, capability);
  return Object.freeze(facade);
}
// Deterministic, one-shot acknowledgment loss, only after successful mutation.
export function faultAfterMutation(
  store: AuditArtifactStore,
  operation: "put" | "delete",
): AuditArtifactStore {
  let armed = true;
  function reply(kind: typeof operation) {
    if (armed && operation === kind) {
      armed = false;
      throw Error("ARTIFACT_ACK_UNCERTAIN");
    }
  }
  return localArtifactFaultFacade(store, {
    after: (kind) => {
      if (kind === "put" || kind === "delete") reply(kind);
    },
  });
}
