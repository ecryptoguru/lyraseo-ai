// Local controlled backend. A generation is allocated by the DB before any I/O.
// Exclusive creation plus DB publication avoids a second, untracked plaintext temp file.
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
}
type Physical = Pick<ArtifactVersion, "storageKey" | "generation">;
export interface AuditArtifactStore {
  readonly qualification: "LOCAL_TEST_ONLY";
  close(): Promise<void>;
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
            .then(afterNamespacePinned)
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
        { op, namespace: prefix(workspace), root: enrolled, ...fields },
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
      { name: suffix(v), size: v.storedLength, digest: v.storedHash },
      bytes,
    );
  }
  return {
    qualification: "LOCAL_TEST_ONLY",
    close() {
      return (closing ??= (async () => {
        await Promise.allSettled([...pending]);
        await rootHandle.close();
      })());
    },
    async putImmutable(v, bytes) {
      possible(v);
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
  return {
    ...store,
    async putImmutable(v, b) {
      await store.putImmutable(v, b);
      reply("put");
    },
    async deleteExactVersion(v) {
      await store.deleteExactVersion(v);
      reply("delete");
    },
  };
}
