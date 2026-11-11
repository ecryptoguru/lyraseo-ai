import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { projectSnapshot, obj } from "./saved-evidence";
import { fixedDays } from "./retention";
import {
  assertRecoveryJournal,
  type JournalWatermark,
  type RecoveryJournal,
} from "./recovery-journal";

const profile = "LOCAL_RETAINED_WORK_ONLY" as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const opaque = /^[A-Za-z0-9_-]{1,128}$/;
const magic = Buffer.from("LYRAREC1\n");
const maximum = 16 * 1024 * 1024;
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const omissions = [
  "RAW_SOURCE_AND_PROVIDER_ENVELOPES",
  "CREDENTIALS_SESSIONS_DISPATCH_CAPABILITIES",
  "ORIGINAL_REPORT_DOWNLOAD_BYTES",
  "FINANCIAL_AND_SECURITY_ARCHIVES",
  "APPLICATION_RELATIONS_AND_MEMBERSHIPS",
] as const;
export type RecoveryRecordInput = {
  id: string;
  workspaceId: string;
  siteId: string;
  incarnation: string;
  kind:
    "AUTHORED_HEAD" | "PINNED_REVISION" | "RECENT_REVISION" | "SAVED_SUMMARY";
  createdAt: string;
  data: unknown;
};
type RecoveryRecord = RecoveryRecordInput & {
  expiresAt: string | null;
  data: Record<string, unknown>;
  hash: string;
};
type RecoveryPoint = {
  profile: typeof profile;
  policy: "RETAINED_WORK_V1";
  id: string;
  createdAt: string;
  expiresAt: string;
  sourceSnapshotAt: string;
  journal: JournalWatermark;
  records: RecoveryRecord[];
  omissions: readonly string[];
};
function timestamp(value: string) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw Error("INVALID_RECOVERY_TIMESTAMP");
  return new Date(value);
}
function authored(value: unknown) {
  const data = obj(value),
    content = obj(data.content);
  if (
    !opaque.test(String(data.draftId)) ||
    !Number.isSafeInteger(data.revision) ||
    (data.revision as number) < 1 ||
    typeof content.title !== "string" ||
    content.title.length > 200 ||
    typeof content.body !== "string" ||
    content.body.length > 100000 ||
    !Array.isArray(content.assumptions) ||
    content.assumptions.length > 50 ||
    !content.assumptions.every(
      (v) => typeof v === "string" && v.length <= 2000,
    ) ||
    !Array.isArray(content.citations) ||
    content.citations.length > 100 ||
    !content.citations.every(
      (v) =>
        typeof obj(v).sourceId === "string" &&
        String(obj(v).sourceId).length <= 256 &&
        typeof obj(v).note === "string" &&
        String(obj(v).note).length <= 2000,
    )
  )
    throw Error("INVALID_AUTHORED_RECOVERY_RECORD");
  return {
    draftId: data.draftId,
    revision: data.revision,
    content: {
      title: content.title,
      body: content.body,
      assumptions: content.assumptions,
      citations: content.citations.map((v) => ({
        sourceId: obj(v).sourceId,
        note: obj(v).note,
      })),
    },
  };
}
function record(input: RecoveryRecordInput, at: Date): RecoveryRecord {
  if (
    ![input.id, input.workspaceId, input.siteId].every(
      (v) => typeof v === "string" && opaque.test(v),
    ) ||
    !uuid.test(input.incarnation)
  )
    throw Error("INVALID_RECOVERY_RECORD_SCOPE");
  const created = timestamp(input.createdAt);
  if (+created > +at) throw Error("RECOVERY_RECORD_FROM_FUTURE");
  let data: Record<string, unknown>,
    expiresAt: string | null = null;
  switch (input.kind) {
    case "AUTHORED_HEAD":
    case "PINNED_REVISION":
    case "RECENT_REVISION":
      data = authored(input.data);
      if (input.kind === "RECENT_REVISION")
        expiresAt = fixedDays(created, 90).toISOString();
      break;
    case "SAVED_SUMMARY": {
      const source = obj(input.data);
      if (typeof source.title !== "string" || source.title.length > 200)
        throw Error("INVALID_SAVED_RECOVERY_SUMMARY");
      data = {
        title: source.title,
        snapshot: projectSnapshot(source.snapshot),
        representation: "REDACTED_DERIVATIVE_V1",
      };
      break;
    }
    default:
      throw Error("UNSUPPORTED_RECOVERY_CLASS");
  }
  const body = {
    id: input.id,
    workspaceId: input.workspaceId,
    siteId: input.siteId,
    incarnation: input.incarnation,
    kind: input.kind,
    createdAt: input.createdAt,
    expiresAt,
    data,
  };
  return { ...body, hash: sha(JSON.stringify(body)) };
}
/** A bounded encrypted retained-work archive, NOT a complete application backup.
 * No activation API exists. Application/financial/storage restore gates remain explicit.
 * AES-256-GCM uses the Node/OpenSSL authenticated cipher; plaintext is never written to disk. */
export async function localRecoveryPoints(config: {
  root: string;
  journalRoot: string;
  key: Uint8Array;
  enabled: boolean;
  now?: () => Date;
}) {
  if (!config.enabled) throw Error("RECOVERY_DISABLED");
  if (config.key.length !== 32) throw Error("INVALID_RECOVERY_KEY");
  const key = Buffer.from(config.key),
    root = config.root,
    journalRoot = config.journalRoot;
  for (const path of [root, journalRoot])
    if (
      !isAbsolute(path) ||
      normalize(path) !== path ||
      (await realpath(path)) !== path
    )
      throw Error("UNSAFE_RECOVERY_ROOT");
  const within = (a: string, b: string) => {
    const r = relative(a, b);
    return (
      r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r))
    );
  };
  if (within(root, journalRoot) || within(journalRoot, root))
    throw Error("RECOVERY_BOUNDARIES_OVERLAP");
  const identity = await lstat(root);
  if (
    !identity.isDirectory() ||
    identity.uid !== process.getuid?.() ||
    (identity.mode & 0o077) !== 0
  )
    throw Error("UNSAFE_RECOVERY_ROOT");
  async function check() {
    const now = await lstat(root);
    if (
      !now.isDirectory() ||
      now.dev !== identity.dev ||
      now.ino !== identity.ino ||
      now.uid !== identity.uid ||
      (now.mode & 0o077) !== 0 ||
      (await realpath(root)) !== root
    )
      throw Error("UNSAFE_RECOVERY_ROOT");
  }
  const now = () => {
    const value = config.now?.() ?? new Date();
    timestamp(value.toISOString());
    return value;
  };
  async function syncDirectory() {
    const fd = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  }
  async function load(
    id: string,
    allowExpired = false,
  ): Promise<RecoveryPoint> {
    if (!uuid.test(id)) throw Error("INVALID_RECOVERY_POINT_ID");
    await check();
    const fd = await open(
      join(root, id + ".point"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let bytes: Buffer;
    try {
      const stat = await fd.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== identity.uid ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > maximum + 4096
      )
        throw Error("UNSAFE_RECOVERY_FILE");
      bytes = await fd.readFile();
    } finally {
      await fd.close();
    }
    let point: RecoveryPoint;
    try {
      if (!bytes.subarray(0, magic.length).equals(magic)) throw Error();
      const headerLength = bytes.readUInt32BE(magic.length),
        offset = magic.length + 4 + headerLength;
      if (headerLength > 2048 || offset + 16 > bytes.length) throw Error();
      const headerBytes = bytes.subarray(magic.length + 4, offset),
        header = JSON.parse(headerBytes.toString()) as {
          id: string;
          nonce: string;
        };
      if (header.id !== id || Object.keys(header).sort().join() !== "id,nonce")
        throw Error();
      const nonce = Buffer.from(header.nonce, "base64url");
      if (nonce.length !== 12) throw Error();
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(Buffer.concat([magic, headerBytes]));
      decipher.setAuthTag(bytes.subarray(-16));
      point = JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(offset, -16)),
          decipher.final(),
        ]).toString(),
      ) as RecoveryPoint;
      if (
        point.id !== id ||
        point.profile !== profile ||
        point.policy !== "RETAINED_WORK_V1" ||
        !Array.isArray(point.records) ||
        point.records.length > 10000 ||
        JSON.stringify(point.omissions) !== JSON.stringify(omissions) ||
        +timestamp(point.expiresAt) !==
          +fixedDays(timestamp(point.createdAt), 7) ||
        +timestamp(point.sourceSnapshotAt) > +timestamp(point.createdAt) ||
        !uuid.test(point.journal.partition) ||
        !Number.isSafeInteger(point.journal.sequence) ||
        point.journal.sequence < 0 ||
        !/^[a-f0-9]{64}$/.test(point.journal.hash)
      )
        throw Error();
      const seen = new Set<string>();
      for (const row of point.records) {
        const normalized = record(row, timestamp(point.sourceSnapshotAt));
        if (JSON.stringify(row) !== JSON.stringify(normalized)) throw Error();
        const unique = [
          row.kind,
          row.workspaceId,
          row.siteId,
          row.incarnation,
          row.id,
        ].join(":");
        if (seen.has(unique)) throw Error();
        seen.add(unique);
      }
    } catch {
      throw Error("RECOVERY_POINT_AUTHENTICATION_FAILED");
    }
    if (!allowExpired && +timestamp(point.expiresAt) <= +now())
      throw Error("RECOVERY_POINT_EXPIRED");
    return point;
  }
  async function inventory() {
    await check();
    const files = (await readdir(root)).sort();
    if (
      files.length > 1000 ||
      files.some(
        (file) => !uuid.test(file.slice(0, -6)) || !file.endsWith(".point"),
      )
    )
      throw Error("RECOVERY_INVENTORY_REQUIRES_REVIEW");
    const points = [];
    for (const file of files) {
      const p = await load(file.slice(0, -6), true);
      points.push({
        id: p.id,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        expired: +timestamp(p.expiresAt) <= +now(),
      });
    }
    const latest = points
      .map((p) => +timestamp(p.createdAt))
      .sort((a, b) => b - a)[0];
    return {
      points,
      expired: points.filter((p) => p.expired).length,
      verified: points.filter((p) => !p.expired).length,
      missingDailyPoint: latest === undefined || +now() - latest >= 86400000,
    };
  }
  await inventory(); // Refuse unrelated/non-archive contents before publishing into a namespace.
  return {
    qualification: "LOCAL_TEST_ONLY" as const,
    async create(input: {
      records: RecoveryRecordInput[];
      journal: JournalWatermark;
      sourceSnapshotAt: string;
    }) {
      await inventory();
      const at = now(),
        snapshot = timestamp(input.sourceSnapshotAt);
      if (
        +snapshot > +at ||
        !Array.isArray(input.records) ||
        input.records.length > 10000 ||
        !uuid.test(input.journal.partition) ||
        !Number.isSafeInteger(input.journal.sequence) ||
        input.journal.sequence < 0 ||
        !/^[a-f0-9]{64}$/.test(input.journal.hash)
      )
        throw Error("INVALID_RECOVERY_POINT");
      const records = input.records.map((row) => record(row, snapshot));
      if (
        records.some(
          (row) => row.expiresAt !== null && +timestamp(row.expiresAt) <= +at,
        )
      )
        throw Error("EXPIRED_RECOVERY_INPUT");
      if (
        new Set(
          records.map((row) =>
            [
              row.kind,
              row.workspaceId,
              row.siteId,
              row.incarnation,
              row.id,
            ].join(":"),
          ),
        ).size !== records.length
      )
        throw Error("DUPLICATE_RECOVERY_RECORD");
      const id = randomUUID(),
        point: RecoveryPoint = {
          profile,
          policy: "RETAINED_WORK_V1",
          id,
          createdAt: at.toISOString(),
          expiresAt: fixedDays(at, 7).toISOString(),
          sourceSnapshotAt: input.sourceSnapshotAt,
          journal: { ...input.journal },
          records,
          omissions,
        };
      const plaintext = JSON.stringify(point);
      if (Buffer.byteLength(plaintext) > maximum)
        throw Error("RECOVERY_POINT_TOO_LARGE");
      const nonce = randomBytes(12),
        header = Buffer.from(
          JSON.stringify({ id, nonce: nonce.toString("base64url") }),
        ),
        length = Buffer.alloc(4);
      length.writeUInt32BE(header.length);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.concat([magic, header]));
      const pending = "." + id + ".pending",
        fd = await open(
          join(root, pending),
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
      try {
        await fd.writeFile(Buffer.concat([magic, length, header]));
        // Bounded chunks feed OpenSSL without a plaintext intermediate file.
        const bytes = Buffer.from(plaintext);
        for (let offset = 0; offset < bytes.length; offset += 65536)
          await fd.writeFile(
            cipher.update(bytes.subarray(offset, offset + 65536)),
          );
        await fd.writeFile(
          Buffer.concat([cipher.final(), cipher.getAuthTag()]),
        );
        await fd.sync();
      } finally {
        await fd.close();
      }
      await link(join(root, pending), join(root, id + ".point"));
      await syncDirectory();
      await unlink(join(root, pending));
      await syncDirectory();
      await load(id);
      return {
        id,
        createdAt: point.createdAt,
        expiresAt: point.expiresAt,
        records: records.length,
        profile,
      };
    },
    verify: (id: string) => load(id),
    inventory,
    async prune(input: { confirmed: boolean }) {
      if (!input.confirmed) throw Error("RECOVERY_PRUNE_CONFIRMATION_REQUIRED");
      const listed = await inventory();
      let removed = 0;
      for (const item of listed.points.filter((p) => p.expired)) {
        await load(item.id, true);
        await unlink(join(root, item.id + ".point"));
        removed++;
      }
      await syncDirectory();
      return { removed };
    },
    async rehearse(
      id: string,
      journal: RecoveryJournal,
      trustedLatest: JournalWatermark,
    ) {
      assertRecoveryJournal(journal);
      const point = await load(id),
        events = await journal.replay(point.journal, trustedLatest);
      const pending = events.filter(
        (event) =>
          event.phase === "INTENT" &&
          !events.some(
            (next) =>
              next.phase === "APPLIED" &&
              next.intentSequence === event.sequence,
          ),
      );
      const deleted = events
        .filter(
          (event) =>
            event.phase === "APPLIED" && event.intent.action === "DELETE_SITE",
        )
        .map((event) => event.intent);
      let erasedRecords = 0,
        expiredRecords = 0,
        withheldRecords = 0;
      const records = point.records.filter((row) => {
        if (
          deleted.some(
            (intent) =>
              intent.workspaceId === row.workspaceId &&
              intent.siteId === row.siteId &&
              intent.incarnation === row.incarnation,
          )
        ) {
          erasedRecords++;
          return false;
        }
        if (
          pending.some(
            (entry) =>
              entry.intent.action === "DELETE_SITE" &&
              entry.intent.workspaceId === row.workspaceId &&
              entry.intent.siteId === row.siteId &&
              entry.intent.incarnation === row.incarnation,
          )
        ) {
          withheldRecords++;
          return false;
        }
        if (row.expiresAt !== null && +timestamp(row.expiresAt) <= +now()) {
          expiredRecords++;
          return false;
        }
        return true;
      });
      return {
        profile,
        records,
        erasedRecords,
        expiredRecords,
        withheldRecords,
        journal: trustedLatest,
        credentialsRestored: 0,
        dispatchEnabled: false,
        reopenAllowed: false,
        blockers: [
          "APPLICATION_RESTORE_NOT_QUALIFIED",
          ...(pending.length ? ["PENDING_DELETION_INTENT"] : []),
        ],
        pendingIntents: pending.length,
        omissions: point.omissions,
      };
    },
  };
}
