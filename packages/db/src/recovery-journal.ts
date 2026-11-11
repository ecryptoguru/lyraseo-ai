import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

/** Local rehearsal only. Keep this directory and key OUTSIDE every database/backup restore boundary. */
export const RECOVERY_POLICY = "LOCAL_RECOVERY_V1";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const zero = "0".repeat(64);
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export type DeletionIntent = {
  caseId: string;
  requestId: string;
  workspaceId: string;
  siteId: string;
  incarnation: string;
  epoch: number;
  action: "DELETE_SITE" | "REVOKE_INTEGRATIONS" | "REVOKE_SITE_TOKENS";
};
export type JournalWatermark = {
  partition: string;
  sequence: number;
  hash: string;
};
export type DeletionReceiptClock = {
  acceptedAt: string;
  deadline: string;
  recordExpiresAt: string;
};
export type JournalEntry = JournalWatermark & {
  policy: typeof RECOVERY_POLICY;
  phase: "INTENT" | "APPLIED";
  previousHash: string;
  recordedAt: string;
  intent: DeletionIntent;
  intentSequence?: number;
  receiptHash?: string;
  receiptClock?: DeletionReceiptClock;
};
export interface RecoveryJournal {
  readonly qualification: "LOCAL_TEST_ONLY";
  intent(value: DeletionIntent): Promise<JournalEntry>;
  applied(
    intent: JournalEntry,
    receiptHash: string,
    receiptClock?: DeletionReceiptClock,
  ): Promise<JournalEntry>;
  pending(): Promise<JournalEntry[]>;
  watermark(): Promise<JournalWatermark>;
  /** Includes entries newer than the backup, so deletion after its capture is replayed. */
  replay(
    backup: JournalWatermark,
    trustedLatest: JournalWatermark,
  ): Promise<JournalEntry[]>;
}
const genuineJournals = new WeakSet<object>();
export function assertRecoveryJournal(value: RecoveryJournal): void {
  if (!genuineJournals.has(value)) throw Error("UNTRUSTED_RECOVERY_JOURNAL");
}
function validIntent(value: DeletionIntent) {
  const fields = [
    "caseId",
    "requestId",
    "workspaceId",
    "siteId",
    "incarnation",
    "epoch",
    "action",
  ];
  if (
    !value ||
    Object.keys(value).sort().join() !== fields.sort().join() ||
    ![value.caseId, value.requestId, value.incarnation].every(
      (v) => typeof v === "string" && uuid.test(v),
    ) ||
    ![value.workspaceId, value.siteId].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v),
    ) ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 1 ||
    !["DELETE_SITE", "REVOKE_INTEGRATIONS", "REVOKE_SITE_TOKENS"].includes(
      value.action,
    )
  )
    throw Error("INVALID_DELETION_INTENT");
  // Stable property order is part of the idempotency domain, not caller JSON order.
  return {
    caseId: value.caseId,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    siteId: value.siteId,
    incarnation: value.incarnation,
    epoch: value.epoch,
    action: value.action,
  };
}
export async function openRecoveryJournal(config: {
  root: string;
  key: Uint8Array;
  enabled: boolean;
  recoverAbandonedLock?: { expectedDigest: string };
}): Promise<RecoveryJournal> {
  if (!config.enabled) throw Error("RECOVERY_DISABLED");
  if (config.key.length !== 32) throw Error("INVALID_RECOVERY_KEY");
  const key = Buffer.from(config.key);
  const root = config.root;
  if (
    !isAbsolute(root) ||
    normalize(root) !== root ||
    (await realpath(root)) !== root
  )
    throw Error("UNSAFE_RECOVERY_ROOT");
  const identity = await lstat(root);
  if (
    !identity.isDirectory() ||
    (identity.mode & 0o077) !== 0 ||
    identity.uid !== process.getuid?.()
  )
    throw Error("UNSAFE_RECOVERY_ROOT");
  async function checkRoot() {
    const current = await lstat(root);
    if (
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      (current.mode & 0o077) !== 0 ||
      current.uid !== identity.uid ||
      (await realpath(root)) !== root
    )
      throw Error("UNSAFE_RECOVERY_ROOT");
  }
  async function read(name: string, maximum: number) {
    const fd = await open(
      join(root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await fd.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== identity.uid ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > maximum
      )
        throw Error("UNSAFE_RECOVERY_FILE");
      return await fd.readFile();
    } finally {
      await fd.close();
    }
  }
  async function syncDirectory() {
    const directory = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async function write(name: string, bytes: Uint8Array) {
    const pending = "." + name + "." + randomUUID() + ".pending";
    const fd = await open(
      join(root, pending),
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await link(join(root, pending), join(root, name));
    await syncDirectory();
    await unlink(join(root, pending));
    await syncDirectory();
  }
  if (config.recoverAbandonedLock) {
    await checkRoot();
    let recovery;
    try {
      recovery = await open(
        join(root, ".recovery-lock"),
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw Error("RECOVERY_JOURNAL_BUSY");
    }
    try {
      await recovery.writeFile(
        JSON.stringify({ pid: process.pid, token: randomUUID() }),
      );
      await recovery.sync();
      const bytes = await read(".writer-lock", 1024);
      if (
        !digest.test(config.recoverAbandonedLock.expectedDigest) ||
        hash(bytes) !== config.recoverAbandonedLock.expectedDigest
      )
        throw Error("JOURNAL_RECOVERY_LOCK_CHANGED");
      let record: { pid: number; token: string };
      try {
        record = JSON.parse(bytes.toString());
      } catch {
        throw Error("JOURNAL_RECOVERY_OWNER_UNKNOWN");
      }
      if (
        !Number.isSafeInteger(record.pid) ||
        record.pid < 1 ||
        !uuid.test(record.token)
      )
        throw Error("JOURNAL_RECOVERY_OWNER_UNKNOWN");
      try {
        process.kill(record.pid, 0);
        throw Error("JOURNAL_RECOVERY_OWNER_LIVE");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      for (const pending of (await readdir(root)).filter((entry) =>
        /^\.(?:partition|[0-9]{12}\.entry)\.[a-f0-9-]{36}\.pending$/.test(
          entry,
        ),
      )) {
        const stat = await lstat(join(root, pending));
        if (
          !stat.isFile() ||
          stat.uid !== identity.uid ||
          (stat.mode & 0o077) !== 0 ||
          stat.nlink > 2
        )
          throw Error("UNSAFE_RECOVERY_FILE");
        if (stat.nlink === 2) {
          const final = await lstat(join(root, pending.slice(1, -45)));
          if (final.ino !== stat.ino || final.dev !== stat.dev)
            throw Error("UNSAFE_RECOVERY_FILE");
        }
        await unlink(join(root, pending));
      }
      if (
        hash(await read(".writer-lock", 1024)) !==
        config.recoverAbandonedLock.expectedDigest
      )
        throw Error("JOURNAL_RECOVERY_LOCK_CHANGED");
      await unlink(join(root, ".writer-lock"));
      await syncDirectory();
    } finally {
      await recovery.close();
      await unlink(join(root, ".recovery-lock"));
      await syncDirectory();
    }
  }
  async function noRecovery() {
    try {
      await lstat(join(root, ".recovery-lock"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw Error("RECOVERY_JOURNAL_BUSY");
  }
  let serial: Promise<unknown> = Promise.resolve();
  function locked<T>(work: () => Promise<T>): Promise<T> {
    const result = serial.then(async () => {
      await checkRoot();
      await noRecovery();
      let lock;
      try {
        lock = await open(
          join(root, ".writer-lock"),
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
      } catch {
        throw Error("RECOVERY_JOURNAL_BUSY");
      }
      try {
        await noRecovery();
        await lock.writeFile(
          JSON.stringify({ pid: process.pid, token: randomUUID() }),
        );
        await lock.sync();
        return await work();
      } finally {
        await lock.close();
        await unlink(join(root, ".writer-lock"));
        await syncDirectory();
      }
    });
    serial = result.catch(() => undefined);
    return result;
  }
  const partition = await locked(async () => {
    try {
      return (await read("partition", 64)).toString();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (
        (await readdir(root)).some(
          (name) => name !== ".writer-lock" && name !== ".recovery-lock",
        )
      )
        throw Error("UNSAFE_RECOVERY_ROOT");
      const id = randomUUID();
      await write("partition", Buffer.from(id));
      return id;
    }
  });
  if (!uuid.test(partition)) throw Error("JOURNAL_AUTHENTICATION_FAILED");
  const name = (n: number) => String(n).padStart(12, "0") + ".entry";
  async function entries(): Promise<JournalEntry[]> {
    const files = (await readdir(root))
      .filter(
        (n) =>
          n !== "partition" && n !== ".writer-lock" && n !== ".recovery-lock",
      )
      .sort();
    if (files.length > 100000)
      throw Error("JOURNAL_CAPACITY_REQUIRES_ROTATION");
    const result: JournalEntry[] = [];
    for (let i = 0; i < files.length; i++) {
      if (files[i] !== name(i + 1)) throw Error("JOURNAL_SEQUENCE_GAP");
      const bytes = await read(files[i]!, 16384);
      try {
        const frame = JSON.parse(bytes.toString()) as {
          nonce: string;
          tag: string;
          body: string;
        };
        const nonce = Buffer.from(frame.nonce, "base64url"),
          tag = Buffer.from(frame.tag, "base64url"),
          body = Buffer.from(frame.body, "base64url");
        if (
          nonce.length !== 12 ||
          tag.length !== 16 ||
          Object.keys(frame).sort().join() !== "body,nonce,tag"
        )
          throw Error();
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(
          Buffer.from(RECOVERY_POLICY + ":" + partition + ":" + (i + 1)),
        );
        decipher.setAuthTag(tag);
        const entry = JSON.parse(
          Buffer.concat([decipher.update(body), decipher.final()]).toString(),
        ) as JournalEntry;
        if (
          entry.partition !== partition ||
          entry.sequence !== i + 1 ||
          entry.policy !== RECOVERY_POLICY ||
          entry.previousHash !== (result.at(-1)?.hash ?? zero) ||
          !["INTENT", "APPLIED"].includes(entry.phase) ||
          new Date(entry.recordedAt).toISOString() !== entry.recordedAt
        )
          throw Error();
        entry.intent = validIntent(entry.intent);
        if (entry.receiptClock)
          entry.receiptClock = validClock(entry.receiptClock);
        if (
          entry.phase === "APPLIED" &&
          (!Number.isSafeInteger(entry.intentSequence) ||
            !digest.test(entry.receiptHash ?? "") ||
            !result.some(
              (prior) =>
                prior.sequence === entry.intentSequence &&
                prior.phase === "INTENT" &&
                JSON.stringify(prior.intent) === JSON.stringify(entry.intent),
            ))
        )
          throw Error();
        if (
          result.some(
            (prior) =>
              prior.phase === entry.phase &&
              prior.intent.caseId === entry.intent.caseId,
          )
        )
          throw Error();
        result.push({ ...entry, hash: hash(bytes) });
      } catch {
        throw Error("JOURNAL_AUTHENTICATION_FAILED");
      }
    }
    return result;
  }
  const watermark = (all: JournalEntry[]): JournalWatermark => ({
    partition,
    sequence: all.length,
    hash: all.at(-1)?.hash ?? zero,
  });
  function validClock(clock: DeletionReceiptClock) {
    if (
      !clock ||
      Object.keys(clock).sort().join(",") !==
        "acceptedAt,deadline,recordExpiresAt" ||
      !Number.isFinite(Date.parse(clock.acceptedAt)) ||
      Date.parse(clock.deadline) !==
        Date.parse(clock.acceptedAt) + 7 * 86400000 ||
      Date.parse(clock.recordExpiresAt) !==
        Date.parse(clock.acceptedAt) + 180 * 86400000
    )
      throw Error("INVALID_DELETION_RECEIPT_CLOCK");
    return { ...clock };
  }
  async function append(
    all: JournalEntry[],
    value: Pick<
      JournalEntry,
      "phase" | "intent" | "intentSequence" | "receiptHash" | "receiptClock"
    >,
  ) {
    const entry: Omit<JournalEntry, "hash"> = {
      partition,
      sequence: all.length + 1,
      policy: RECOVERY_POLICY,
      previousHash: all.at(-1)?.hash ?? zero,
      recordedAt: new Date().toISOString(),
      ...value,
    };
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(
      Buffer.from(RECOVERY_POLICY + ":" + partition + ":" + entry.sequence),
    );
    const body = Buffer.concat([
      cipher.update(JSON.stringify(entry), "utf8"),
      cipher.final(),
    ]);
    const bytes = Buffer.from(
      JSON.stringify({
        nonce: nonce.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        body: body.toString("base64url"),
      }),
    );
    await write(name(entry.sequence), bytes);
    return { ...entry, hash: hash(bytes) };
  }
  await locked(entries); // Wrong key/corrupt state fails at open, before callers can apply anything.
  const journal: RecoveryJournal = {
    qualification: "LOCAL_TEST_ONLY",
    intent(value) {
      return locked(async () => {
        const input = validIntent(value),
          all = await entries();
        const old = all.find(
          (entry) =>
            entry.phase === "INTENT" &&
            (entry.intent.requestId === input.requestId ||
              entry.intent.caseId === input.caseId),
        );
        if (old) {
          if (JSON.stringify(old.intent) !== JSON.stringify(input))
            throw Error("JOURNAL_IDEMPOTENCY_CONFLICT");
          return old;
        }
        return append(all, { phase: "INTENT", intent: input });
      });
    },
    applied(intent, receiptHash, receiptClock) {
      const clock = receiptClock ? validClock(receiptClock) : undefined;
      return locked(async () => {
        const all = await entries();
        const source = all.find(
          (entry) =>
            entry.sequence === intent.sequence &&
            entry.hash === intent.hash &&
            entry.phase === "INTENT",
        );
        if (!source || !digest.test(receiptHash))
          throw Error("INVALID_JOURNAL_RECEIPT");
        const old = all.find(
          (entry) =>
            entry.phase === "APPLIED" &&
            entry.intentSequence === source.sequence,
        );
        if (old) {
          if (
            old.receiptHash !== receiptHash ||
            JSON.stringify(old.receiptClock) !== JSON.stringify(clock)
          )
            throw Error("JOURNAL_IDEMPOTENCY_CONFLICT");
          return old;
        }
        return append(all, {
          phase: "APPLIED",
          intent: source.intent,
          intentSequence: source.sequence,
          receiptHash,
          ...(clock ? { receiptClock: clock } : {}),
        });
      });
    },
    pending() {
      return locked(async () => {
        const all = await entries();
        return all.filter(
          (entry) =>
            entry.phase === "INTENT" &&
            !all.some(
              (next) =>
                next.phase === "APPLIED" &&
                next.intentSequence === entry.sequence,
            ),
        );
      });
    },
    watermark() {
      return locked(async () => watermark(await entries()));
    },
    replay(backup, trustedLatest) {
      return locked(async () => {
        const all = await entries();
        if (
          backup.partition !== partition ||
          !Number.isSafeInteger(backup.sequence) ||
          backup.sequence < 0 ||
          backup.sequence > all.length ||
          backup.hash !==
            (backup.sequence === 0 ? zero : all[backup.sequence - 1]!.hash)
        )
          throw Error("JOURNAL_WATERMARK_MISMATCH");
        const actual = watermark(all);
        if (
          !trustedLatest ||
          trustedLatest.partition !== actual.partition ||
          trustedLatest.sequence !== actual.sequence ||
          trustedLatest.hash !== actual.hash
        )
          throw Error("JOURNAL_LATEST_HEAD_UNPROVEN");
        return all;
      });
    },
  };
  genuineJournals.add(journal);
  return Object.freeze(journal);
}
