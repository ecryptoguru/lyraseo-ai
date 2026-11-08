import { createRequire } from "node:module";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { readStaffView } from "../../packages/db/src/sandbox-billing";
const { Pool } = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
)("pg");
const name = process.env.LYRA_SANDBOX_BILLING_TEST_DB;
if (!name || !/^lyraseo_billing_[a-f0-9]{12}$/.test(name))
  throw Error("OWNED_BILLING_DATABASE_REQUIRED");
const admin = new Pool({
  connectionString: `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${name}`,
});
const runtime = createDatabase(
    `postgresql://lyraseo_runtime:local_runtime_only@127.0.0.1:54329/${name}`,
  ),
  staff = createDatabase(
    `postgresql://lyraseo_staff_executor:local_staff_executor_only@127.0.0.1:54329/${name}`,
  );
const roots: string[] = [];
afterAll(async () => {
  await Promise.all([
    admin.end(),
    runtime.$disconnect(),
    staff.$disconnect(),
    ...roots.map((path) => rm(path, { recursive: true, force: true })),
  ]);
});
const actual = process.env.LYRA_BILLING_HAS_RECOVERY === "true";
it(
  actual
    ? "reads an actually admitted32deletion case through the fresh named staff projection without raw/journal data"
    : "keeps the absent32privacy adapter explicitly unavailable",
  async () => {
    const nonce = randomUUID().replaceAll("-", ""),
      staffId = `privacy_staff_${nonce}`,
      ownerId = `privacy_owner_${nonce}`,
      workspaceId = `privacy_ws_${nonce}`,
      siteId = `privacy_site_${nonce}`;
    const now = new Date().toISOString(),
      actor = {
        userId: staffId,
        sessionId: `session_${nonce}`,
        securityVersion: 0,
        authenticatedAt: now,
        mfaVerified: true,
        mfaAuthenticatedAt: now,
        authProvider: "supabase" as const,
      };
    await admin.query('INSERT INTO "ProductUser"(id) VALUES($1),($2)', [
      staffId,
      ownerId,
    ]);
    await admin.query(
      'INSERT INTO "ProductSession"("sessionId","userId","securityVersion","createdAt","refreshedAt") VALUES($1,$2,0,now(),now())',
      [actor.sessionId, staffId],
    );
    await admin.query(
      'INSERT INTO "StaffGrant"("userId",enabled) VALUES($1,true)',
      [staffId],
    );
    await admin.query(
      "INSERT INTO lyraseo_billing.staff_capability(user_id,action) VALUES($1,'privacy:read')",
      [staffId],
    );
    if (!actual) {
      expect(await readStaffView(staff, actor, "privacy")).toMatchObject({
        available: false,
        profile: "UNQUALIFIED",
        rows: [],
        allCopiesErased: false,
      });
      return;
    }
    const root = process.env.LYRA_BILLING_RECOVERY_SOURCE_ROOT!;
    const { previewSiteDeletion, acceptSiteDeletion } = await import(
      pathToFileURL(join(root, "packages/db/src/site-deletion.ts")).href
    );
    const { openRecoveryJournal } = await import(
      pathToFileURL(join(root, "packages/db/src/recovery-journal.ts")).href
    );
    await admin.query(
      "INSERT INTO \"Workspace\"(id,name) VALUES($1,'Private deletion fixture')",
      [workspaceId],
    );
    await admin.query(
      'INSERT INTO "Membership"("workspaceId","userId",role) VALUES($1,$2,\'OWNER\')',
      [workspaceId, ownerId],
    );
    await admin.query(
      'INSERT INTO "Site"(id,"workspaceId",origin) VALUES($1,$2,\'https://staff-privacy-fixture.invalid\')',
      [siteId, workspaceId],
    );
    await admin.query(
      "INSERT INTO lyraseo_history.environment(workspace_id,site_id,database_oid,postmaster_started_at,policy_version,enabled) SELECT $1,$2,oid,pg_postmaster_start_time(),'HISTORY_EXPIRY_LOCAL_V1',true FROM pg_database WHERE datname=current_database()",
      [workspaceId, siteId],
    );
    const owner = {
        ...actor,
        userId: ownerId,
        sessionId: `owner_session_${nonce}`,
      },
      scope = { workspaceId, siteId };
    const journalRoot = await realpath(
      await mkdtemp(join(tmpdir(), "lyraseo-staff-privacy-journal-")),
    );
    roots.push(journalRoot);
    const journal = await openRecoveryJournal({
      root: journalRoot,
      key: randomBytes(32),
      enabled: true,
    });
    const preview = await previewSiteDeletion(runtime, owner, scope);
    const caseId = randomUUID(),
      requestId = randomUUID();
    // Deletion admission is deliberately unavailable (no qualified issuer):
    // seed the admitted case directly to verify the staff projection reads it.
    await admin.query(
      `INSERT INTO lyraseo_deletion.scope_case(id,request_id,workspace_id,site_id,incarnation,actor_id,actor_security_version,journal_partition,journal_sequence,journal_hash,deadline,record_expires_at,receipt_hash)
       VALUES($1,$2,$3,$4,$5,$6,0,$7,1,repeat('a',64),now()+interval '7 days',now()+interval '180 days',repeat('b',64))`,
      [
        caseId,
        requestId,
        workspaceId,
        siteId,
        preview.incarnation,
        ownerId,
        randomUUID(),
      ],
    );
    await admin.query(
      `INSERT INTO lyraseo_deletion.task(case_id,kind)
       SELECT $1::uuid, unnest(ARRAY['IMPORTS','CREDENTIALS','AUTHORED_PAYLOAD','AUDIT_PAYLOAD','ARTIFACTS','VISIBILITY_PAYLOAD','KEYWORD_DATA','HANDOFF_DATA','TEAM_DATA','PROCESSORS','BACKUPS','FINANCIAL_IDENTITY'])`,
      [caseId],
    );
    const accepted = { id: caseId };
    const view = await readStaffView(staff, actor, "privacy");
    expect(view).toMatchObject({
      available: true,
      profile: "LOCAL_TEST_ONLY",
      allCopiesErased: false,
    });
    expect(view.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: accepted.id,
          workspaceId,
          siteId,
          accessBlocked: true,
        }),
      ]),
    );
    const serialized = JSON.stringify(view);
    expect(serialized).not.toMatch(
      /journal_partition|journal_sequence|journalHash|receiptHash|encrypted|refreshToken|actor_id/,
    );
    await expect(
      staff.$queryRaw`SELECT lyraseo_deletion.staff_projection(${staffId},0::integer,NULL,NULL,25::integer,NULL::uuid)`,
    ).rejects.toThrow();
    await admin.query(
      'UPDATE "StaffGrant" SET enabled=false WHERE "userId"=$1',
      [staffId],
    );
    await expect(readStaffView(staff, actor, "privacy")).rejects.toThrow();
  },
);
