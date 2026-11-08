import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { openRecoveryJournal } from "../../packages/db/src/recovery-journal";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lyraseo-recovery-journal-")),
  );
  roots.push(root);
  const key = randomBytes(32);
  const journal = await openRecoveryJournal({ root, key, enabled: true });
  const intent = {
    caseId: randomUUID(),
    requestId: randomUUID(),
    workspaceId: randomUUID(),
    siteId: randomUUID(),
    incarnation: randomUUID(),
    epoch: 1,
    action: "DELETE_SITE" as const,
  };
  return { root, key, journal, intent };
}
it("durably journals deletion intent before apply and resumes the same intent after restart", async () => {
  const { root, key, journal, intent } = await fixture();
  const first = await journal.intent(intent);
  expect(first.sequence).toBe(1);
  expect((await journal.pending()).map((entry) => entry.intent)).toEqual([
    intent,
  ]);
  const reopened = await openRecoveryJournal({ root, key, enabled: true });
  expect(await reopened.intent(intent)).toEqual(first);
  const applied = await reopened.applied(first, "a".repeat(64));
  expect(applied.sequence).toBe(2);
  expect(await reopened.applied(first, "a".repeat(64))).toEqual(applied);
  expect(await reopened.pending()).toEqual([]);
  const watermark = await reopened.watermark();
  expect(watermark.sequence).toBe(2);
  expect(
    (await reopened.replay(watermark, watermark)).map((entry) => entry.phase),
  ).toEqual(["INTENT", "APPLIED"]);
  const disk = await Promise.all(
    (await readdir(root)).map((name) => readFile(join(root, name), "utf8")),
  );
  expect(disk.join("")).not.toContain(intent.workspaceId);
  expect(disk.join("")).not.toContain(intent.caseId);
});
it("rejects changed idempotent intent and conflicting apply receipts", async () => {
  const { journal, intent } = await fixture();
  const first = await journal.intent(intent);
  await expect(
    journal.intent({ ...intent, siteId: randomUUID() }),
  ).rejects.toThrow("JOURNAL_IDEMPOTENCY_CONFLICT");
  await journal.applied(first, "a".repeat(64));
  await expect(journal.applied(first, "b".repeat(64))).rejects.toThrow(
    "JOURNAL_IDEMPOTENCY_CONFLICT",
  );
  expect((await journal.watermark()).sequence).toBe(2);
});
it("fails closed on missing tail, corruption, wrong key and an unknown restore watermark", async () => {
  const { root, journal, intent, key } = await fixture();
  const first = await journal.intent(intent);
  const before = await journal.watermark();
  await journal.applied(first, "a".repeat(64));
  const current = await journal.watermark();
  await expect(
    journal.replay({ ...current, hash: "f".repeat(64) }, current),
  ).rejects.toThrow("JOURNAL_WATERMARK_MISMATCH");
  expect((await journal.replay(before, current)).length).toBe(2);
  await expect(
    openRecoveryJournal({ root, key: randomBytes(32), enabled: true }),
  ).rejects.toThrow("JOURNAL_AUTHENTICATION_FAILED");
  const files = (await readdir(root))
    .filter((name) => name.endsWith(".entry"))
    .sort();
  const tail = join(root, files[1]!);
  const bytes = await readFile(tail);
  await rm(tail);
  await expect(journal.replay(current, current)).rejects.toThrow(
    "JOURNAL_WATERMARK_MISMATCH",
  );
  await expect(journal.replay(before, current)).rejects.toThrow(
    "JOURNAL_LATEST_HEAD_UNPROVEN",
  );
  await writeFile(tail, bytes, { mode: 0o600 });
  bytes[bytes.length - 4] = bytes[bytes.length - 4]! ^ 1;
  await writeFile(tail, bytes);
  await expect(
    openRecoveryJournal({ root, key, enabled: true }),
  ).rejects.toThrow("JOURNAL_AUTHENTICATION_FAILED");
});
it("serializes concurrent intents without duplicate sequences and rejects untrusted paths/configuration", async () => {
  const { root, journal, intent, key } = await fixture();
  const requests = Array.from({ length: 12 }, () => ({
    ...intent,
    caseId: randomUUID(),
    requestId: randomUUID(),
  }));
  const results = await Promise.all(
    requests.map((value) => journal.intent(value)),
  );
  expect(new Set(results.map((entry) => entry.sequence)).size).toBe(12);
  expect((await journal.pending()).length).toBe(12);
  await expect(
    openRecoveryJournal({ root, key, enabled: false }),
  ).rejects.toThrow("RECOVERY_DISABLED");
  await expect(
    openRecoveryJournal({
      root: root + "/../" + root.split("/").pop(),
      key,
      enabled: true,
    }),
  ).rejects.toThrow("UNSAFE_RECOVERY_ROOT");
  await expect(
    journal.intent({ ...intent, workspaceId: "https://secret.example" }),
  ).rejects.toThrow("INVALID_DELETION_INTENT");
});
it("requires explicit matching dead-owner recovery after a real process exits during unpublished output", async () => {
  const { root, key, journal, intent } = await fixture();
  const first = await journal.intent(intent);
  const watermark = await journal.watermark();
  // A separate process follows the on-disk lock/publication protocol and exits
  // before final publication. No deletion acceptance/application was acknowledged.
  const child = spawnSync(process.execPath, [
    "-e",
    `
    const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    const root=process.argv[1];
    const fd=fs.openSync(path.join(root,'.writer-lock'),'wx',0o600);
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token:crypto.randomUUID()}));fs.fsyncSync(fd);
    const pending=fs.openSync(path.join(root,'.000000000002.entry.'+crypto.randomUUID()+'.pending'),'wx',0o600);
    fs.writeSync(pending,'interrupted encrypted output');fs.fsyncSync(pending);
    process.exit(23);
  `,
    root,
  ]);
  expect(child.status).toBe(23);
  await expect(
    openRecoveryJournal({ root, key, enabled: true }),
  ).rejects.toThrow("RECOVERY_JOURNAL_BUSY");
  const expectedDigest = createHash("sha256")
    .update(await readFile(join(root, ".writer-lock")))
    .digest("hex");
  await expect(
    openRecoveryJournal({
      root,
      key,
      enabled: true,
      recoverAbandonedLock: { expectedDigest: "f".repeat(64) },
    }),
  ).rejects.toThrow("JOURNAL_RECOVERY_LOCK_CHANGED");
  const reopened = await openRecoveryJournal({
    root,
    key,
    enabled: true,
    recoverAbandonedLock: { expectedDigest },
  });
  expect(await reopened.watermark()).toEqual(watermark);
  expect(await reopened.pending()).toEqual([first]);
  expect((await readdir(root)).some((name) => name.endsWith(".pending"))).toBe(
    false,
  );
  expect((await reopened.applied(first, "c".repeat(64))).sequence).toBe(2);
});
it("never removes a lock whose owner is live, including a reused PID", async () => {
  const { root, key } = await fixture();
  const bytes = JSON.stringify({ pid: process.pid, token: randomUUID() });
  await writeFile(join(root, ".writer-lock"), bytes, { mode: 0o600 });
  const expectedDigest = createHash("sha256").update(bytes).digest("hex");
  await expect(
    openRecoveryJournal({
      root,
      key,
      enabled: true,
      recoverAbandonedLock: { expectedDigest },
    }),
  ).rejects.toThrow("JOURNAL_RECOVERY_OWNER_LIVE");
  expect((await readFile(join(root, ".writer-lock"))).toString()).toBe(bytes);
});
it("a second operator recovery cannot remove a writer lock while another recovery owns the mutex", async () => {
  const { root, key } = await fixture();
  const child = spawnSync(process.execPath, [
    "-e",
    `const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');fs.writeFileSync(p.join(process.argv[1],'.writer-lock'),JSON.stringify({pid:process.pid,token:c.randomUUID()}),{mode:0o600});process.exit(23);`,
    root,
  ]);
  expect(child.status).toBe(23);
  const bytes = await readFile(join(root, ".writer-lock")),
    expectedDigest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    join(root, ".recovery-lock"),
    JSON.stringify({ pid: process.pid, token: randomUUID() }),
    { mode: 0o600 },
  );
  await expect(
    openRecoveryJournal({
      root,
      key,
      enabled: true,
      recoverAbandonedLock: { expectedDigest },
    }),
  ).rejects.toThrow("RECOVERY_JOURNAL_BUSY");
  expect(await readFile(join(root, ".writer-lock"))).toEqual(bytes);
});
it("does not initialize a journal in an unrelated private directory", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lyraseo-not-journal-")),
  );
  roots.push(root);
  await writeFile(join(root, "unrelated"), "preserve", { mode: 0o600 });
  await expect(
    openRecoveryJournal({ root, key: randomBytes(32), enabled: true }),
  ).rejects.toThrow("UNSAFE_RECOVERY_ROOT");
  expect(await readdir(root)).toEqual(["unrelated"]);
});

it("preserves original deletion receipt clocks across reopen and rejects deadline resets", async () => {
  const { root, key, journal, intent } = await fixture(),
    entry = await journal.intent(intent);
  const acceptedAt = "2026-11-03T00:00:00.123456+00:00",
    clock = {
      acceptedAt,
      deadline: "2026-11-10T00:00:00.123456+00:00",
      recordExpiresAt: "2027-05-02T00:00:00.123456+00:00",
    };
  await journal.applied(entry, "c".repeat(64), clock);
  const reopened = await openRecoveryJournal({ root, key, enabled: true }),
    head = await reopened.watermark();
  expect((await reopened.replay(head, head))[1]?.receiptClock).toEqual(clock);
  expect(() =>
    reopened.applied(entry, "c".repeat(64), {
      ...clock,
      deadline: "2026-11-11T00:00:00.123456+00:00",
    }),
  ).toThrow("INVALID_DELETION_RECEIPT_CLOCK");
  await expect(
    reopened.applied(entry, "c".repeat(64), {
      acceptedAt: "2026-11-04T00:00:00Z",
      deadline: "2026-11-11T00:00:00Z",
      recordExpiresAt: "2027-05-03T00:00:00Z",
    }),
  ).rejects.toThrow("JOURNAL_IDEMPOTENCY_CONFLICT");
});
