import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../packages/db/src";
import {
  createAuditRun,
  readAuditSource,
  readAuditRun,
  claimAuditRun,
  checkpointPrivateAudit,
} from "../../packages/db/src/audits";
import { acquireRawPage } from "../../packages/visibility/src/acquisition";
import * as context from "../../packages/db/src/context";
import { bindLocalArtifactStore } from "../../packages/db/src/artifact-checkpoint";
import {
  localAuditArtifactStore,
  type AuditArtifactStore,
} from "../../packages/db/src/artifact-store";
import { runRawAuditStep } from "../../apps/lyraseo-web/src/server/acquisition/runner";
import { enrollTestArtifactAuthority } from "../helpers/artifact-authority";
import {
  actor,
  adminUrl,
  runtimeUrl,
  resetDatabase,
  seedTenants,
} from "../helpers/database";

const seams = vi.hoisted(() => ({
  db: null as unknown,
  resolve: null as (() => Promise<unknown>) | null,
}));
vi.mock("@/server/auth/server", () => ({
  database: () => seams.db,
  resolveActor: async () => seams.resolve!(),
}));
import { GET } from "../../apps/lyraseo-web/src/app/api/audits/route";
const db = createDatabase(runtimeUrl),
  legacy = createDatabase(runtimeUrl),
  admin = createDatabase(adminUrl);
const home = "https://example.com/",
  original = Buffer.from(
    "\uFEFF<html><body>SESSION_PRIVATE_SOURCE</body></html>",
  );
const transport = async (url: string) =>
  url.endsWith("robots.txt")
    ? new Response(null, { status: 404 })
    : new Response(original, { headers: { "content-type": "text/html" } });
let root: string,
  store: AuditArtifactStore,
  authority: Awaited<ReturnType<typeof enrollTestArtifactAuthority>>;
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function captured(selected = db) {
  if (selected === legacy) {
    // The controlled legacy receipt clock is shifted back below. Its site proof
    // must precede that clock too; never relax the real future-proof guard.
    await admin.site.update({
      where: { workspaceId_id: { workspaceId: "a", id: "a-site" } },
      data: { verifiedAt: new Date(Date.now() - 2000) },
    });
  }
  const run = await createAuditRun(selected, actor, {
    workspaceId: "a",
    siteId: "a-site",
    profile: "LOCAL_RAW_V1",
    idempotencyKey: "session-read",
    manifest: [home],
  });
  const scope = { workspaceId: "a", siteId: "a-site", auditId: run.id };
  // Keep the legacy receipt strictly before the database checkpoint clock.
  if (selected === legacy) vi.useFakeTimers({ toFake: ["Date"] });
  try {
    if (selected === legacy) vi.setSystemTime(Date.now() - 1000);
    await runRawAuditStep(selected, actor, scope, transport, async () => actor);
  } finally {
    vi.useRealTimers();
  }
  return scope;
}
function request(auditId: string) {
  return new Request(
    `http://localhost:3000/api/audits?workspaceId=a&siteId=a-site&auditId=${auditId}&format=source&url=${encodeURIComponent(home)}`,
  );
}
beforeEach(async () => {
  await resetDatabase();
  await seedTenants();
  root = await mkdtemp(
    join(await realpath(tmpdir()), "lyraseo-session-source-"),
  );
  store = await localAuditArtifactStore(root);
  authority = await enrollTestArtifactAuthority(admin, store);
  bindLocalArtifactStore(db, store, authority);
  seams.db = db;
  seams.resolve = async () => actor;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await authority?.revoke();
  await store?.close();
  await rm(root, { recursive: true, force: true });
});
afterAll(() =>
  Promise.all([db.$disconnect(), legacy.$disconnect(), admin.$disconnect()]),
);

it.each(["removed", "session", "user", "epoch", "failure"])(
  "denies every original byte when identity is %s during backend I/O",
  async (change) => {
    const scope = await captured(),
      entered = barrier(),
      release = barrier();
    let returned = false,
      changed = false;
    bindLocalArtifactStore(
      db,
      {
        ...store,
        async openBounded(version) {
          const bytes = await store.openBounded(version);
          entered.release();
          await release.promise;
          returned = true;
          return bytes;
        },
      },
      authority,
    );
    seams.resolve = async () => {
      if (!changed) return actor;
      expect(returned).toBe(true);
      if (change === "failure") throw Error("AUTH_REFRESH_FAILED");
      if (change === "removed") return null;
      return {
        ...actor,
        ...(change === "session"
          ? { sessionId: "replacement" }
          : change === "user"
            ? { userId: "other" }
            : { securityVersion: 1 }),
      };
    };
    const reading = GET(request(scope.auditId));
    await entered.promise;
    changed = true;
    release.release();
    const response = await reading;
    expect(response.status).not.toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("SESSION_PRIVATE_SOURCE");
  },
);

it.each(["grant", "retirement", "replacement-ref"])(
  "rechecks %s after blocked fresh identity without holding a product transaction",
  async (change) => {
    const scope = await captured(),
      entered = barrier(),
      release = barrier();
    const reader = { ...actor, userId: "viewer" };
    let calls = 0;
    seams.resolve = async () => {
      if (++calls === 1) return reader;
      entered.release();
      await release.promise;
      return reader;
    };
    const reading = GET(request(scope.auditId));
    try {
      expect(
        await Promise.race([
          entered.promise.then(() => "auth"),
          reading.then(() => "delivered"),
        ]),
      ).toBe("auth");
      // A separate connection must acquire all product read locks before releasing identity.
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
        await tx.$executeRawUnsafe(
          'LOCK TABLE "ProductUser", "Membership", "SiteGrant", "Site", "AuditRun", "AuditPage", "ArtifactRef", "ArtifactBlob" IN ACCESS EXCLUSIVE MODE',
        );
        if (change === "grant")
          await tx.siteGrant.deleteMany({ where: { userId: "viewer" } });
        if (change === "retirement") await tx.artifactRef.deleteMany();
        if (change === "replacement-ref") {
          const ref = await tx.artifactRef.findFirstOrThrow();
          await tx.artifactRef.deleteMany();
          await tx.artifactRef.create({
            data: { ...ref, id: crypto.randomUUID() },
          });
        }
      });
    } finally {
      release.release();
    }
    const response = await reading;
    expect(response.status).toBe(change === "grant" ? 404 : 410);
    expect(await response.text()).not.toContain("SESSION_PRIVATE_SOURCE");
  },
);

it("uses fresh authentication metadata for final scope and preserves original BOM bytes and bearer denial", async () => {
  const scope = await captured(),
    fresh = {
      ...actor,
      mfaVerified: false,
      mfaAuthenticatedAt: undefined,
      authenticatedAt: "2020-01-01T00:00:00.000Z",
    };
  let returned = false;
  bindLocalArtifactStore(
    db,
    {
      ...store,
      async openBounded(v) {
        const bytes = await store.openBounded(v);
        returned = true;
        return bytes;
      },
    },
    authority,
  );
  seams.resolve = async () => (returned ? fresh : actor);
  const real = context.withEvidenceRead,
    observed: context.ReadActor[] = [];
  vi.spyOn(context, "withEvidenceRead").mockImplementation(async (...args) => {
    observed.push(args[1]);
    return real(...args);
  });
  const response = await GET(request(scope.auditId));
  expect(response.status).toBe(200);
  expect(observed.at(-1)).toBe(fresh);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(original);
  expect(response.headers.get("Content-Disposition")).toMatch(/^attachment/);
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  const bearer = request(scope.auditId);
  bearer.headers.set("Authorization", "Bearer synthetic");
  expect((await GET(bearer)).status).toBe(404);
});

it.each(["removed", "retirement", "clock-change", "unchanged"])(
  "revalidates legacy decoded SQL source with %s identity/retention",
  async (change) => {
    const scope = await captured(legacy),
      entered = barrier(),
      release = barrier();
    seams.db = legacy;
    let calls = 0;
    seams.resolve = async () => {
      if (++calls === 1) return actor;
      entered.release();
      await release.promise;
      return change === "removed" ? null : actor;
    };
    const reading = GET(request(scope.auditId));
    try {
      expect(
        await Promise.race([
          entered.promise.then(() => "auth"),
          reading.then(() => "delivered"),
        ]),
      ).toBe("auth");
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
        await tx.$executeRawUnsafe(
          'LOCK TABLE "ProductUser", "Membership", "Site", "AuditRun", "AuditPage", "AuditPageRetention" IN ACCESS EXCLUSIVE MODE',
        );
        if (change === "retirement")
          await tx.auditPageRetention.updateMany({
            data: {
              rawExpiresAt: null,
              capturedAt: null,
              clockStatus: "unknown",
            },
          });
        if (change === "clock-change")
          await tx.$executeRaw`UPDATE "AuditPageRetention" SET "capturedAt"="capturedAt"-interval '1 day',"rawExpiresAt"="rawExpiresAt"-interval '1 day'`;
      });
    } finally {
      release.release();
    }
    const response = await reading;
    expect(response.status).toBe(
      change === "unchanged" ? 200 : change === "removed" ? 404 : 410,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (change === "unchanged") {
      expect(bytes).toEqual(original);
      expect(
        (await readAuditRun(legacy, actor, scope)).pages[0]
          ?.sourceRepresentation,
      ).toBe("stored-utf8");
      expect(
        (
          await admin.auditRun.findUniqueOrThrow({
            where: { id: scope.auditId },
          })
        ).storageFormat,
      ).toBeNull();
    } else expect(bytes.toString()).not.toContain("SESSION_PRIVATE_SOURCE");
  },
);

it("requires trusted current identity at the service boundary and continues denying token actors", async () => {
  const scope = await captured();
  await expect(
    readAuditSource(db, actor, scope, home, undefined as never),
  ).rejects.toThrow("CURRENT_ACTOR_REQUIRED");
  await expect(
    readAuditSource(
      db,
      {
        credential: "api-token",
        userId: actor.userId,
        securityVersion: 0,
        tokenId: "synthetic",
        tokenHash: "synthetic",
        workspaceId: "a",
      },
      scope,
      home,
      async () => actor,
    ),
  ).rejects.toThrow("FORBIDDEN");
});

async function legacyFixture(
  raw: string,
  sha256?: string,
  createdAt = new Date(),
) {
  const run = await admin.auditRun.create({
    data: {
      workspaceId: "a",
      siteId: "a-site",
      userId: actor.userId,
      securityVersion: 0,
      idempotencyKey: "old-sql-source",
      inputHash: "fixture",
      manifest: [home],
      profile: "LOCAL_RAW_V1",
      declarations: {},
      methodologyVersion: "readiness-v2",
      status: "COMPLETED",
      createdAt,
    },
  });
  await admin.auditPage.create({
    data: {
      workspaceId: "a",
      auditId: run.id,
      requestedUrl: home,
      evidence: {},
      provenance: {
        rawHtml: raw,
        ...(sha256 ? { sha256 } : {}),
        acquiredAt: new Date(Date.now() - 1000).toISOString(),
      },
    },
  });
  return { workspaceId: "a", siteId: "a-site", auditId: run.id };
}

it.each(["missing-hash", "oversized"])(
  "keeps legacy %s rows bounded without inventing original-wire evidence",
  async (kind) => {
    const raw =
      kind === "oversized"
        ? "x".repeat(5 * 1024 * 1024 + 1)
        : "legacy source without a recorded digest";
    const scope = await legacyFixture(raw);
    seams.db = legacy;
    const response = await GET(request(scope.auditId));
    expect(response.status).toBe(kind === "oversized" ? 410 : 200);
    if (kind === "missing-hash") expect(await response.text()).toBe(raw);
    else expect(await response.text()).not.toContain("xxxxx");
  },
);

it("observes the original private raw deadline crossing while fresh identity is blocked", async () => {
  const run = await createAuditRun(db, actor, {
    workspaceId: "a",
    siteId: "a-site",
    profile: "LOCAL_RAW_V1",
    idempotencyKey: "near-raw-deadline",
    manifest: [home],
  });
  const scope = { workspaceId: "a", siteId: "a-site", auditId: run.id };
  const lease = await claimAuditRun(db, actor, scope, "near-deadline");
  vi.useFakeTimers({ toFake: ["Date"] });
  let observed: Awaited<ReturnType<typeof acquireRawPage>>;
  try {
    vi.setSystemTime(Date.now() - 30 * 86400000 + 2500);
    observed = await acquireRawPage(home, home, transport);
  } finally {
    vi.useRealTimers();
  }
  await checkpointPrivateAudit(db, actor, scope, lease.fence, observed);
  const entered = barrier(),
    release = barrier();
  let calls = 0;
  seams.resolve = async () => {
    if (++calls === 1) return actor;
    entered.release();
    await release.promise;
    return actor;
  };
  const reading = GET(request(scope.auditId));
  try {
    expect(
      await Promise.race([
        entered.promise.then(() => "auth"),
        reading.then(() => "delivered"),
      ]),
    ).toBe("auth");
    await admin.$queryRaw`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM max("expiresAt")-(clock_timestamp() AT TIME ZONE 'UTC'))+0.01)::double precision)::text FROM "ArtifactRef"`;
  } finally {
    release.release();
  }
  const response = await reading;
  expect(response.status).toBe(410);
  expect(await response.text()).not.toContain("SESSION_PRIVATE_SOURCE");
});

it("observes the generated legacy result deadline crossing while fresh identity is blocked", async () => {
  const [row] = await admin.$queryRaw<
    { createdAt: Date }[]
  >`SELECT (clock_timestamp() AT TIME ZONE 'UTC')+interval '2.5 seconds'-interval '13 months' AS "createdAt"`;
  const scope = await legacyFixture(
    "RESULT_DEADLINE_PRIVATE",
    undefined,
    row!.createdAt,
  );
  seams.db = legacy;
  const entered = barrier(),
    release = barrier();
  let calls = 0;
  seams.resolve = async () => {
    if (++calls === 1) return actor;
    entered.release();
    await release.promise;
    return actor;
  };
  const reading = GET(request(scope.auditId));
  try {
    expect(
      await Promise.race([
        entered.promise.then(() => "auth"),
        reading.then(() => "delivered"),
      ]),
    ).toBe("auth");
    await admin.$queryRaw`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM max("resultExpiresAt")-(clock_timestamp() AT TIME ZONE 'UTC'))+0.01)::double precision)::text FROM "AuditRun"`;
  } finally {
    release.release();
  }
  const response = await reading;
  expect(response.status).toBe(410);
  expect(await response.text()).not.toContain("RESULT_DEADLINE_PRIVATE");
});
