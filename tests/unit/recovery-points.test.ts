import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecoveryJournal } from "../../packages/db/src/recovery-journal";
import { localRecoveryPoints } from "../../packages/db/src/recovery-points";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lyraseo-points-")));
  const journalRoot = await realpath(
    await mkdtemp(join(tmpdir(), "lyraseo-points-journal-")),
  );
  roots.push(root, journalRoot);
  const key = randomBytes(32),
    journal = await openRecoveryJournal({
      root: journalRoot,
      key: randomBytes(32),
      enabled: true,
    });
  const clock = { now: new Date("2026-11-03T12:34:56.789Z") };
  const points = await localRecoveryPoints({
    root,
    journalRoot,
    key,
    enabled: true,
    now: () => clock.now,
  });
  const scope = {
    workspaceId: "workspace",
    siteId: "site",
    incarnation: randomUUID(),
  };
  const records = [
    {
      ...scope,
      id: "head",
      kind: "AUTHORED_HEAD" as const,
      createdAt: "2024-01-31T12:00:00.123Z",
      data: {
        draftId: "draft",
        revision: 2,
        content: {
          title: "Authored",
          body: "SAVED_BODY",
          assumptions: [],
          citations: [],
        },
      },
    },
    {
      ...scope,
      id: "recent",
      kind: "RECENT_REVISION" as const,
      createdAt: "2026-10-01T12:00:00.123Z",
      data: {
        draftId: "draft",
        revision: 1,
        content: {
          title: "Older",
          body: "old",
          assumptions: [],
          citations: [],
        },
      },
    },
    {
      ...scope,
      id: "report",
      kind: "SAVED_SUMMARY" as const,
      createdAt: "2024-01-31T12:00:00.123Z",
      data: {
        title: "Saved conclusion",
        snapshot: {
          capturedAt: "2024-01-31T12:00:00.123Z",
          scope,
          context: { brandName: "Name" },
          sources: [],
          internalLinks: [],
          rawHtml: "SOURCE_ONLY_MARKER",
        },
      },
    },
  ];
  return { root, journalRoot, key, journal, points, clock, scope, records };
}
it("backs up authored work and redacted saved conclusions with authenticated hashes and original clocks", async () => {
  const { root, points, journal, records } = await setup();
  const created = await points.create({
    records,
    journal: await journal.watermark(),
    sourceSnapshotAt: "2026-11-03T12:34:56.000Z",
  });
  expect(created.expiresAt).toBe("2026-11-10T12:34:56.789Z");
  const verified = await points.verify(created.id);
  expect(verified.records[0]!.data).toMatchObject({
    content: { body: "SAVED_BODY" },
  });
  expect(JSON.stringify(verified)).not.toContain("SOURCE_ONLY_MARKER");
  expect(verified.records[0]!.createdAt).toBe("2024-01-31T12:00:00.123Z");
  const files = await readdir(root);
  expect(files).toEqual([created.id + ".point"]);
  expect(
    (await readFile(join(root, files[0]!))).includes(Buffer.from("SAVED_BODY")),
  ).toBe(false);
  expect(verified.omissions).toContain(
    "CREDENTIALS_SESSIONS_DISPATCH_CAPABILITIES",
  );
  expect(verified.profile).toBe("LOCAL_RETAINED_WORK_ONLY");
});
it("replays deletions after backup only for their exact incarnation and blocks reopening on pending intent", async () => {
  const { points, journal, records, scope } = await setup();
  const created = await points.create({
    records,
    journal: await journal.watermark(),
    sourceSnapshotAt: "2026-11-03T12:34:56.000Z",
  });
  const intent = await journal.intent({
    ...scope,
    caseId: randomUUID(),
    requestId: randomUUID(),
    epoch: 1,
    action: "DELETE_SITE",
  });
  const pending = await points.rehearse(
    created.id,
    journal,
    await journal.watermark(),
  );
  expect(pending.reopenAllowed).toBe(false);
  expect(pending.blockers).toContain("PENDING_DELETION_INTENT");
  expect(pending.records).toEqual([]);
  expect(pending.withheldRecords).toBe(3);
  expect(pending.erasedRecords).toBe(0);
  await journal.applied(intent, "a".repeat(64));
  const restored = await points.rehearse(
    created.id,
    journal,
    await journal.watermark(),
  );
  expect(restored.records).toEqual([]);
  expect(restored.erasedRecords).toBe(3);
  expect(restored.reopenAllowed).toBe(false);
  expect(restored.blockers).toContain("APPLICATION_RESTORE_NOT_QUALIFIED");
  expect(restored.credentialsRestored).toBe(0);
  const nextIncarnation = randomUUID();
  const fresh = await points.create({
    records: records.map((row) => ({ ...row, incarnation: nextIncarnation })),
    journal: await journal.watermark(),
    sourceSnapshotAt: "2026-11-03T12:34:56.000Z",
  });
  expect(
    (await points.rehearse(fresh.id, journal, await journal.watermark()))
      .records,
  ).toHaveLength(3);
});
it("reapplies original historical-revision expiry during restore without restarting its clock", async () => {
  const { points, journal, records, clock } = await setup();
  const createdAt = new Date(+clock.now - 89 * 86400000).toISOString();
  const point = await points.create({
    records: [records[0]!, { ...records[1]!, createdAt }],
    journal: await journal.watermark(),
    sourceSnapshotAt: clock.now.toISOString(),
  });
  const expiry = new Date(Date.parse(createdAt) + 90 * 86400000).toISOString();
  expect((await points.verify(point.id)).records[1]!.expiresAt).toBe(expiry);
  clock.now = new Date(expiry);
  const restored = await points.rehearse(
    point.id,
    journal,
    await journal.watermark(),
  );
  expect(restored.expiredRecords).toBe(1);
  expect(restored.records.map((row) => row.id)).toEqual(["head"]);
  await expect(
    points.rehearse(
      point.id,
      { replay: async () => [] } as never,
      await journal.watermark(),
    ),
  ).rejects.toThrow("UNTRUSTED_RECOVERY_JOURNAL");
});
it("fails authentication on corruption/wrong key and rejects expired points at exactly seven days", async () => {
  const { root, key, journalRoot, points, journal, clock, records } =
    await setup();
  const created = await points.create({
    records,
    journal: await journal.watermark(),
    sourceSnapshotAt: "2026-11-03T12:34:56.000Z",
  });
  await expect(
    localRecoveryPoints({
      root,
      journalRoot,
      key: randomBytes(32),
      enabled: true,
      now: () => clock.now,
    }),
  ).rejects.toThrow("RECOVERY_POINT_AUTHENTICATION_FAILED");
  const file = join(root, created.id + ".point"),
    bytes = await readFile(file);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await writeFile(file, bytes);
  await expect(points.verify(created.id)).rejects.toThrow(
    "RECOVERY_POINT_AUTHENTICATION_FAILED",
  );
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await writeFile(file, bytes);
  clock.now = new Date(created.expiresAt);
  await expect(points.verify(created.id)).rejects.toThrow(
    "RECOVERY_POINT_EXPIRED",
  );
  expect((await points.inventory()).expired).toBe(1);
  await expect(points.prune({ confirmed: false })).rejects.toThrow(
    "RECOVERY_PRUNE_CONFIRMATION_REQUIRED",
  );
  expect(await points.prune({ confirmed: true })).toMatchObject({ removed: 1 });
  expect(await readdir(root)).toEqual([]);
  expect(key).toHaveLength(32);
});
it("rejects overlapping journal and backup paths and unclassified/raw backup records", async () => {
  const { root, key, points, journal, records } = await setup();
  await expect(
    localRecoveryPoints({ root, journalRoot: root, key, enabled: true }),
  ).rejects.toThrow("RECOVERY_BOUNDARIES_OVERLAP");
  await expect(
    points.create({
      records: [{ ...records[0]!, kind: "RAW_HTML" } as never],
      journal: await journal.watermark(),
      sourceSnapshotAt: "2026-11-03T12:00:00.000Z",
    }),
  ).rejects.toThrow("UNSUPPORTED_RECOVERY_CLASS");
  expect(await readdir(root)).toEqual([]);
});
