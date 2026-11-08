import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createDatabase } from "../../packages/db/src";
import { createContentDraft } from "../../packages/db/src/content";
import {
  configureWordPress,
  configureWebhook,
  prepareWordPress,
  previewWordPress,
  prepareWebhookTest,
  readHandoffs,
  disconnectHandoff,
  rotateWebhook,
  handoffAad,
} from "../../packages/db/src/handoffs";
import {
  verifyWebhook,
  wordpressReceipt,
} from "../../packages/db/src/handoff-codecs";
import { secretBox } from "../../apps/lyraseo-web/src/server/google/provider";

// Test-only socket seam: production URL validation, all-address DNS screening,
// authorization barriers, fixed headers and byte limits still execute. Only the
// final HTTPS socket is routed to our controlled loopback HTTP receiver; this is
// not live TLS/runtime egress qualification and adds no production bypass.
const localSocket = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));
vi.mock("node:https", async () => {
  const http = await import("node:http");
  return {
    request: (
      url: URL,
      options: import("node:https").RequestOptions,
      callback: (response: import("node:http").IncomingMessage) => void,
    ) => {
      if (!localSocket.port) throw Error("CONTROLLED_SOCKET_NOT_BOUND");
      if (
        url.protocol !== "https:" ||
        options.method !== "POST" ||
        options.agent !== false
      )
        throw Error("INVALID_CONTROLLED_SOCKET");
      return http.request(
        {
          hostname: "127.0.0.1",
          port: localSocket.port,
          path: url.pathname + url.search,
          method: options.method,
          headers: { ...options.headers, Host: url.host },
          signal: options.signal,
          maxHeaderSize: options.maxHeaderSize,
          agent: false,
        },
        callback,
      );
    },
  };
});
import {
  wordpressFrozenDraftPost,
  signedWebhookPost,
} from "../../apps/lyraseo-web/src/server/handoffs/transport";
const apiSeams = vi.hoisted(() => ({
  db: null as unknown,
  actor: null as unknown,
}));
vi.mock("@/server/auth/server", () => ({
  database: () => apiSeams.db,
  resolveActor: async () => apiSeams.actor,
}));
vi.mock("@/server/auth/settings", () => ({
  authSettings: () => ({ origin: "http://127.0.0.1:3012" }),
}));
import * as handoffApi from "../../apps/lyraseo-web/src/app/api/integrations/handoffs/route";
const name = process.env.LYRA_HANDOFF_DB_NAME;
if (!name || !/^lyraseo_handoff_[a-f0-9]{12}$/.test(name))
  throw Error("REQUIRED_HANDOFF_FIXTURE_DATABASE");
const url = (user: string, password: string) =>
  `postgresql://${user}:${password}@127.0.0.1:54329/${name}`;
const admin = createDatabase(url("postgres", "lyraseo_local_only")),
  db = createDatabase(url("lyraseo_runtime", "local_runtime_only")),
  executor = createDatabase(
    url("lyraseo_handoff_fixture", "local_handoff_fixture_only"),
  );
const actor = {
  userId: "handoff-owner",
  sessionId: "handoff-session",
  securityVersion: 0,
  authenticatedAt: new Date().toISOString(),
  mfaVerified: true,
  mfaAuthenticatedAt: new Date().toISOString(),
  authProvider: "supabase" as const,
};
const scope = { workspaceId: "handoff-a", siteId: "handoff-a-site" };
const box = secretBox(Buffer.alloc(32, 9).toString("base64"));
let revisionId: string;
async function fixtureClone(id: string) {
  const clone = randomUUID();
  const [source] = await admin.$queryRaw<
    { kind: string; body: string }[]
  >`SELECT kind,body FROM lyraseo_handoff.intent WHERE id=${id}::uuid`;
  const eventId = randomUUID();
  const body =
    source!.kind === "WEBHOOK"
      ? JSON.stringify({ ...JSON.parse(source!.body), id: eventId })
      : source!.body;
  await admin.$executeRaw`INSERT INTO lyraseo_handoff.intent(id,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,idempotency_key,input_hash,mode,draft_id,draft_revision_id,event_type,resource_kind,resource_id,event_id,body,body_hash,renderer_version,destination_url)
 SELECT ${clone}::uuid,workspace_id,site_id,destination_id,destination_generation,kind,created_by,security_version,${clone},input_hash,'FIXTURE',draft_id,draft_revision_id,event_type,resource_kind,resource_id,${eventId}::uuid,${body},encode(sha256(convert_to(${body},'UTF8')),'hex'),renderer_version,destination_url FROM lyraseo_handoff.intent WHERE id=${id}::uuid`;
  return clone;
}
async function claim(id: string) {
  return (
    await executor.$queryRaw<
      {
        value: {
          id: string;
          kind: string;
          fence: number;
          attempt: number;
        } | null;
      }[]
    >`SELECT lyraseo_handoff.fixture_claim(${id}::uuid) AS value`
  )[0]!.value;
}
async function binding(id: string, fence: number) {
  return (
    await executor.$queryRaw<
      {
        value: {
          url: string;
          connectionUrl: string;
          generation: number;
          body: string;
          cipher: string;
          keyId: string;
          previousCipher: string | null;
          previousKeyId: string | null;
          kind: string;
        };
      }[]
    >`SELECT lyraseo_handoff.fixture_before_socket(${id}::uuid,${fence}) AS value`
  )[0]!.value;
}
async function finish(
  id: string,
  fence: number,
  outcome: string,
  status: number | null,
  code: string,
  post: number | null = null,
  editor: string | null = null,
) {
  return (
    await executor.$queryRaw<
      { value: { state: string; replayed: boolean } }[]
    >`SELECT lyraseo_handoff.fixture_finish(${id}::uuid,${fence},${outcome},${status}::integer,${code},${post}::bigint,${editor}::text) AS value`
  )[0]!.value;
}
async function state(id: string) {
  return (
    await admin.$queryRaw<
      { state: string; attempt: number; next_due_at: Date; body: string }[]
    >`SELECT state,attempt,next_due_at,body FROM lyraseo_handoff.intent WHERE id=${id}::uuid`
  )[0]!;
}
async function wp() {
  const draft = await createContentDraft(db, actor, scope, {
    kind: "draft",
    title: "Exact source",
    body: "<script>alert(1)</script>\n\nA & B",
    assumptions: [],
    citations: [],
    auditIds: [],
    searchSnapshotIds: ["handoff-source"],
  });
  revisionId = draft.history[0]!.id;
  return configureWordPress(db, actor, scope, box, {
    installation: "https://example.com/blog/",
    username: "dedicated-editor",
    applicationPassword: "fixture-not-a-real-password",
    confirmed: true,
    expectedRevision: (await readHandoffs(db, actor, scope)).destinations.find(
      (d) => d.kind === "WORDPRESS",
    )?.revision,
  });
}
async function preparedWP(destinationId: string, key = randomUUID()) {
  const preview = await previewWordPress(db, actor, scope, {
    destinationId,
    draftRevisionId: revisionId,
  });
  return prepareWordPress(db, actor, scope, {
    destinationId,
    draftRevisionId: revisionId,
    expectedBodyHash: preview.hash,
    expectedDestinationGeneration: preview.destination.generation,
    expectedDestinationUrl: preview.destination.url,
    idempotencyKey: key,
  });
}
async function webhook() {
  return configureWebhook(db, actor, scope, box, {
    url: "https://receiver.example.com/events",
    confirmed: true,
    expectedRevision: (await readHandoffs(db, actor, scope)).destinations.find(
      (d) => d.kind === "WEBHOOK",
    )?.revision,
  });
}
beforeAll(async () => {
  await admin.productUser.createMany({
    data: [
      { id: actor.userId },
      { id: "handoff-viewer" },
      { id: "handoff-editor" },
      { id: "handoff-foreign" },
    ],
  });
  await admin.workspace.createMany({
    data: [
      { id: scope.workspaceId, name: "Handoff A" },
      { id: "handoff-b", name: "Handoff B" },
    ],
  });
  await admin.membership.createMany({
    data: [
      { workspaceId: scope.workspaceId, userId: actor.userId, role: "OWNER" },
      {
        workspaceId: scope.workspaceId,
        userId: "handoff-viewer",
        role: "VIEWER",
      },
      { workspaceId: "handoff-b", userId: "handoff-foreign", role: "OWNER" },
    ],
  });
  await admin.site.createMany({
    data: [
      {
        id: scope.siteId,
        workspaceId: scope.workspaceId,
        origin: "https://example.com",
        verifiedAt: new Date(),
      },
      {
        id: "handoff-b-site",
        workspaceId: "handoff-b",
        origin: "https://other.com",
        verifiedAt: new Date(),
      },
      {
        id: "handoff-ungranted",
        workspaceId: scope.workspaceId,
        origin: "https://third.com",
        verifiedAt: new Date(),
      },
    ],
  });
  await admin.siteGrant.create({
    data: { ...scope, userId: "handoff-viewer" },
  });
  await admin.searchSnapshot.create({
    data: {
      id: "handoff-source",
      ...scope,
      property: "https://example.com/",
      startDate: "2026-11-01",
      endDate: "2026-11-02",
      shape: "page",
      status: "partial",
      rows: [{ keys: ["https://example.com/"], clicks: 1, impressions: 10 }],
    },
  });
  const draft = await createContentDraft(db, actor, scope, {
    kind: "draft",
    title: "Exact source",
    body: "<script>alert(1)</script>\n\nA & B",
    assumptions: [],
    citations: [],
    auditIds: [],
    searchSnapshotIds: ["handoff-source"],
  });
  revisionId = draft.history[0]!.id;
});
afterAll(async () => {
  await Promise.all([
    admin.$disconnect(),
    db.$disconnect(),
    executor.$disconnect(),
  ]);
});
describe("durable restricted handoffs", () => {
  it("scopes setup, secrets and reads across tenants and viewers", async () => {
    const d = await wp();
    const read = await readHandoffs(
      db,
      { ...actor, userId: "handoff-viewer" },
      scope,
    );
    expect(read.destinations[0]!.id).toBe(d.id);
    expect(JSON.stringify(read)).not.toContain("fixture-not-a-real-password");
    expect(JSON.stringify(read)).not.toContain("secret_cipher");
    await expect(
      wp().then(() =>
        configureWordPress(
          db,
          { ...actor, userId: "handoff-viewer" },
          scope,
          box,
          {
            installation: d.url,
            username: "x",
            applicationPassword: "x",
            confirmed: true,
          },
        ),
      ),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      readHandoffs(db, { ...actor, userId: "handoff-foreign" }, scope),
    ).rejects.toThrow();
    await expect(
      readHandoffs(
        db,
        { ...actor, userId: "handoff-viewer" },
        { ...scope, siteId: "handoff-ungranted" },
      ),
    ).rejects.toThrow();
    await expect(
      db.$queryRaw`SELECT secret_cipher FROM lyraseo_handoff.destination`,
    ).rejects.toThrow();
    await expect(
      executor.$queryRaw`SELECT * FROM public."ContentRevision"`,
    ).rejects.toThrow();
    await expect(
      executor.$executeRaw`SET ROLE lyraseo_handoff_owner`,
    ).rejects.toThrow();
  });
  it("freezes same-site revision, exact literal payload and concurrent idempotency without dispatch", async () => {
    const d = await wp(),
      key = randomUUID();
    const [a, b] = await Promise.all([
      preparedWP(d.id, key),
      preparedWP(d.id, key),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.mode).toBe("QUARANTINED");
    expect(a.state).toBe("PREPARED");
    await expect(
      executor.$queryRaw`SELECT lyraseo_handoff.fixture_claim(${a.id}::uuid)`,
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      db.$queryRaw`SELECT lyraseo_handoff.fixture_claim(${a.id}::uuid)`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE lyraseo_handoff.intent SET mode='FIXTURE' WHERE id=${a.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      admin.$executeRaw`UPDATE lyraseo_handoff.intent SET body='changed' WHERE id=${a.id}::uuid`,
    ).rejects.toThrow("IMMUTABLE_HANDOFF");
    await expect(
      previewWordPress(
        db,
        actor,
        { ...scope, siteId: "handoff-ungranted" },
        { destinationId: d.id, draftRevisionId: revisionId },
      ),
    ).rejects.toThrow();
  });
  it("accepts one draft POST then loses its response: restart and duplicate delivery cannot create again", async () => {
    const d = await wp(),
      prepared = await preparedWP(d.id),
      id = await fixtureClone(prepared.id);
    const claimed = await claim(id);
    expect(claimed!.attempt).toBe(1);
    const bound = await binding(id, claimed!.fence);
    expect(JSON.parse(bound.body).status).toBe("draft");
    let posts = 0;
    const sentBodies: string[] = [];
    const server = createServer((req, res) => {
      if (req.method === "POST") posts++;
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        sentBodies.push(Buffer.concat(chunks).toString());
        res.destroy();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address() as { port: number };
    localSocket.port = address.port;
    const credential = JSON.parse(
      box.open(
        bound.cipher,
        handoffAad(scope, "WORDPRESS", bound.connectionUrl, bound.generation),
      ),
    );
    try {
      await expect(
        wordpressFrozenDraftPost(
          {
            installation: bound.connectionUrl,
            origin: new URL(bound.connectionUrl).origin,
            body: bound.body,
            bodyHash: (
              await import("../../packages/db/src/handoff-codecs")
            ).sha256(bound.body),
            ...credential,
          },
          async () => {
            await binding(id, claimed!.fence);
          },
        ),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    await admin.$executeRaw`UPDATE lyraseo_handoff.intent SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${id}::uuid`;
    expect(await claim(id)).toBeNull();
    expect((await state(id)).state).toBe("UNRESOLVED");
    expect(await claim(id)).toBeNull();
    expect(await claim(id)).toBeNull();
    expect(posts).toBe(1);
    expect(sentBodies).toEqual([bound.body]);
  });
  it("guards current access immediately before socket and rejects stale completion", async () => {
    const d = await wp(),
      id = await fixtureClone((await preparedWP(d.id)).id),
      claimed = await claim(id);
    await disconnectHandoff(db, actor, scope, d.id, d.revision);
    await expect(binding(id, claimed!.fence)).rejects.toThrow("STALE_HANDOFF");
    await expect(
      finish(
        id,
        claimed!.fence,
        "CONFIRMED_DRAFT",
        201,
        "RESPONSE",
        42,
        "https://example.com/blog/wp-admin/post.php?post=42&action=edit",
      ),
    ).rejects.toThrow("STALE_HANDOFF");
    expect((await state(id)).state).toBe("UNRESOLVED");
  });
  it("confirms one draft receipt, replays once, and preserves append-only receipts", async () => {
    const d = await wp(),
      id = await fixtureClone((await preparedWP(d.id)).id),
      c = await claim(id),
      b = await binding(id, c!.fence);
    const receipt = wordpressReceipt(201, '{"id":42,"status":"draft"}', b.url);
    expect(
      (
        await finish(
          id,
          c!.fence,
          receipt.state,
          201,
          "RESPONSE",
          receipt.remotePostId!,
          receipt.editorUrl!,
        )
      ).state,
    ).toBe("CONFIRMED_DRAFT");
    expect(
      (
        await finish(
          id,
          c!.fence,
          receipt.state,
          201,
          "RESPONSE",
          receipt.remotePostId!,
          receipt.editorUrl!,
        )
      ).replayed,
    ).toBe(true);
    expect(await claim(id)).toBeNull();
    await expect(
      admin.$executeRaw`UPDATE lyraseo_handoff.receipt SET code='OTHER' WHERE intent_id=${id}::uuid`,
    ).rejects.toThrow("IMMUTABLE_HANDOFF_RECEIPT");
  });
  it("webhook dropped acknowledgement reuses authenticated event bytes and receiver deduplicates effect", async () => {
    const configured = await webhook(),
      d = configured.destination,
      key = randomUUID();
    const prepared = await prepareWebhookTest(db, actor, scope, {
      destinationId: d.id,
      idempotencyKey: key,
    });
    expect(
      (
        await prepareWebhookTest(db, actor, scope, {
          destinationId: d.id,
          idempotencyKey: key,
        })
      ).id,
    ).toBe(prepared.id);
    const id = await fixtureClone(prepared.id),
      first = await claim(id),
      b = await binding(id, first!.fence),
      seen = new Set<string>();
    let effects = 0,
      requests = 0;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        requests++;
        const body = Buffer.concat(chunks).toString(),
          headers = {
            "X-Lyraseo-Timestamp": String(req.headers["x-lyraseo-timestamp"]),
            "X-Lyraseo-Signature": String(req.headers["x-lyraseo-signature"]),
            "X-Lyraseo-Key-Id": String(req.headers["x-lyraseo-key-id"]),
          };
        const event = verifyWebhook(
          body,
          headers,
          { [configured.keyId]: configured.secret },
          Math.floor(Date.now() / 1000),
        );
        if (!seen.has(event.id)) {
          seen.add(event.id);
          effects++;
        }
        if (requests === 1) res.destroy();
        else {
          res.writeHead(204);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address() as { port: number };
    localSocket.port = address.port;
    let currentFence = first!.fence;
    async function send() {
      return signedWebhookPost(
        {
          url: b.url,
          body: b.body,
          eventId: JSON.parse(b.body).id,
          key: configured.secret,
          keyId: configured.keyId,
        },
        async () => {
          await binding(id, currentFence);
        },
      );
    }
    try {
      await expect(send()).rejects.toThrow();
      expect(
        (await finish(id, first!.fence, "RETRY", null, "NETWORK_UNCERTAIN"))
          .state,
      ).toBe("RETRY");
      expect(await claim(id)).toBeNull();
      await admin.$executeRaw`UPDATE lyraseo_handoff.intent SET next_due_at=clock_timestamp()-interval '1 second' WHERE id=${id}::uuid`;
      const second = await claim(id);
      expect(second!.attempt).toBe(2);
      currentFence = second!.fence;
      expect((await binding(id, second!.fence)).body).toBe(b.body);
      await expect(
        finish(id, first!.fence, "DELIVERED", 204, "RESPONSE"),
      ).rejects.toThrow("STALE_HANDOFF");
      expect((await send()).status).toBe(204);
      expect(
        (await finish(id, second!.fence, "DELIVERED", 204, "RESPONSE")).state,
      ).toBe("DELIVERED");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(requests).toBe(2);
    expect(effects).toBe(1);
  });
  it("rotation exposes keys once, binds purpose, expires previous overlap and revocation removes secrets", async () => {
    const c = await webhook(),
      rotated = await rotateWebhook(
        db,
        actor,
        scope,
        box,
        c.destination.id,
        c.destination.revision,
      );
    const read = await readHandoffs(db, actor, scope),
      d = read.destinations.find((x) => x.id === c.destination.id)!;
    expect(d.previous_key_id).toBe(c.keyId);
    expect(Date.parse(d.previous_until!) - Date.now()).toBeLessThanOrEqual(
      86400000,
    );
    const id = await fixtureClone(
        (
          await prepareWebhookTest(db, actor, scope, {
            destinationId: d.id,
            idempotencyKey: randomUUID(),
          })
        ).id,
      ),
      claim_ = await claim(id),
      bound = await binding(id, claim_!.fence);
    expect(
      box.open(
        bound.cipher,
        handoffAad(scope, "WEBHOOK", bound.connectionUrl, bound.generation),
      ),
    ).toBe(rotated.secret);
    expect(() =>
      box.open(
        bound.cipher,
        handoffAad(scope, "WORDPRESS", bound.connectionUrl, bound.generation),
      ),
    ).toThrow();
    await admin.$executeRaw`UPDATE lyraseo_handoff.destination SET previous_until=clock_timestamp()-interval '1 second' WHERE id=${d.id}::uuid`;
    expect((await binding(id, claim_!.fence)).previousCipher).toBeNull();
    await disconnectHandoff(db, actor, scope, d.id, d.revision);
    const [stored] = await admin.$queryRaw<
      { secret_cipher: string | null; previous_cipher: string | null }[]
    >`SELECT secret_cipher,previous_cipher FROM lyraseo_handoff.destination WHERE id=${d.id}::uuid`;
    expect(stored).toEqual({ secret_cipher: null, previous_cipher: null });
  });
});
it("concurrent claims open exactly one send barrier; suspension and stale user epoch block a socket", async () => {
  const d = await wp(),
    id = await fixtureClone((await preparedWP(d.id)).id);
  const results = await Promise.all([claim(id), claim(id)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const c = results.find(Boolean)!;
  await admin.productUser.update({
    where: { id: actor.userId },
    data: { securityVersion: 1 },
  });
  try {
    await expect(binding(id, c.fence)).rejects.toThrow("STALE_HANDOFF");
    expect(
      (await finish(id, c.fence, "UNRESOLVED", null, "ACCESS_REVOKED")).state,
    ).toBe("UNRESOLVED");
  } finally {
    await admin.productUser.update({
      where: { id: actor.userId },
      data: { securityVersion: 0 },
    });
  }
});
it("SQL bounds all webhook retries and prevents stale receipts changing the terminal result", async () => {
  const configured = await webhook(),
    id = await fixtureClone(
      (
        await prepareWebhookTest(db, actor, scope, {
          destinationId: configured.destination.id,
          idempotencyKey: randomUUID(),
        })
      ).id,
    );
  const delays = [60, 300, 1800, 7200, 43200];
  for (let attempt = 1; attempt <= 6; attempt++) {
    const c = await claim(id);
    expect(c!.attempt).toBe(attempt);
    const before = Date.now();
    const result = await finish(
      id,
      c!.fence,
      "RETRY",
      503,
      "UPSTREAM_UNAVAILABLE",
    );
    if (attempt === 6) {
      expect(result.state).toBe("FAILED");
      break;
    }
    const row = await state(id);
    expect(row.next_due_at.getTime() - before).toBeGreaterThanOrEqual(
      delays[attempt - 1]! * 1000 - 100,
    );
    expect(row.next_due_at.getTime() - before).toBeLessThan(
      delays[attempt - 1]! * 1000 + 1000,
    );
    expect(await claim(id)).toBeNull();
    await admin.$executeRaw`UPDATE lyraseo_handoff.intent SET next_due_at=clock_timestamp()-interval '1 second' WHERE id=${id}::uuid`;
  }
  expect(await claim(id)).toBeNull();
  expect((await state(id)).attempt).toBe(6);
});
it("opted-in report events freeze a minimal resource envelope in the report transaction", async () => {
  const old = (await readHandoffs(db, actor, scope)).destinations.find(
    (d) => d.kind === "WEBHOOK",
  );
  await configureWebhook(db, actor, scope, box, {
    url: "https://receiver.example.com/events",
    confirmed: true,
    eventTypes: ["report.created"],
    expectedRevision: old?.revision,
  });
  const { captureEditorialEvidence, storeEvidenceReport } =
    await import("../../packages/db/src/content");
  const snapshot = await captureEditorialEvidence(db, actor, scope, {
    auditIds: [],
    searchSnapshotIds: ["handoff-source"],
  });
  const report = await storeEvidenceReport(db, actor, scope, {
    title: "Private report",
    snapshot,
    render: async () => ({ pdf: new Uint8Array([1, 2, 3]), csv: "fixture" }),
  });
  const [event] = await admin.$queryRaw<
    { body: string; state: string; mode: string }[]
  >`SELECT body,state,mode FROM lyraseo_handoff.intent WHERE resource_id=${report.id}`;
  const body = JSON.parse(event!.body);
  expect(body.type).toBe("report.created");
  expect(body.resource).toEqual({ kind: "report", id: report.id });
  expect(body.workspaceId).toBe(scope.workspaceId);
  expect(body.siteId).toBe(scope.siteId);
  expect(Object.keys(body).sort()).toEqual([
    "id",
    "occurredAt",
    "resource",
    "siteId",
    "type",
    "version",
    "workspaceId",
  ]);
  expect(event!.mode).toBe("QUARANTINED");
  expect(event!.state).toBe("PREPARED");
  expect(event!.body).not.toContain("Exact source");
});
it("revoking an editor's site grant after claim blocks the socket and output completion", async () => {
  await admin.membership.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: scope.workspaceId,
        userId: "handoff-editor",
      },
    },
    create: {
      workspaceId: scope.workspaceId,
      userId: "handoff-editor",
      role: "EDITOR",
    },
    update: { role: "EDITOR" },
  });
  await admin.siteGrant.create({
    data: { ...scope, userId: "handoff-editor" },
  });
  const editor = { ...actor, userId: "handoff-editor" },
    destination = await wp(),
    preview = await previewWordPress(db, editor, scope, {
      destinationId: destination.id,
      draftRevisionId: revisionId,
    });
  const original = await prepareWordPress(db, editor, scope, {
      destinationId: destination.id,
      draftRevisionId: revisionId,
      expectedBodyHash: preview.hash,
      expectedDestinationGeneration: preview.destination.generation,
      expectedDestinationUrl: preview.destination.url,
      idempotencyKey: randomUUID(),
    }),
    id = await fixtureClone(original.id),
    c = await claim(id);
  await admin.siteGrant.delete({
    where: {
      workspaceId_siteId_userId: { ...scope, userId: "handoff-editor" },
    },
  });
  await expect(binding(id, c!.fence)).rejects.toThrow("STALE_HANDOFF");
  expect(
    (await finish(id, c!.fence, "UNRESOLVED", null, "ACCESS_REVOKED")).state,
  ).toBe("UNRESOLVED");
});
it("a new intent or destination generation cannot silently replace an unresolved draft", async () => {
  const d = await wp(),
    original = await preparedWP(d.id),
    id = await fixtureClone(original.id),
    c = await claim(id);
  await finish(id, c!.fence, "UNRESOLVED", null, "NETWORK_UNCERTAIN");
  const replacement = await fixtureClone(original.id);
  expect(await claim(replacement)).toBeNull();
  expect((await state(replacement)).state).toBe("REJECTED");
  // Product admission similarly preserves uncertainty across destination reconnects.
  await admin.$executeRaw`UPDATE lyraseo_handoff.intent SET state='UNRESOLVED' WHERE id=${original.id}::uuid`;
  await configureWordPress(db, actor, scope, box, {
    installation: d.url,
    username: "dedicated-editor",
    applicationPassword: "fixture",
    confirmed: true,
    expectedRevision: d.revision,
  });
  await expect(preparedWP(d.id)).rejects.toThrow(
    "WORDPRESS_RECONCILIATION_REQUIRED",
  );
});
for (const change of ["installation", "reconnect"] as const) {
  it(`rejects a service preparation from the originally reviewed destination after ${change}`, async () => {
    const configured = await wp(),
      preview = await previewWordPress(db, actor, scope, {
        destinationId: configured.id,
        draftRevisionId: revisionId,
      }),
      key = randomUUID();
    const originalReview = {
      destinationId: configured.id,
      draftRevisionId: revisionId,
      expectedBodyHash: preview.hash,
      expectedDestinationGeneration: preview.destination.generation,
      expectedDestinationUrl: preview.destination.url,
      idempotencyKey: key,
    };
    const updated = await configureWordPress(
      db,
      { ...actor, sessionId: "second-authorized-session" },
      scope,
      box,
      {
        installation:
          change === "installation"
            ? "https://example.com/second/"
            : configured.url,
        username: "reconnected-editor",
        applicationPassword: "fixture-new-password",
        confirmed: true,
        expectedRevision: configured.revision,
      },
    );
    const rows = () =>
      admin.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) FROM lyraseo_handoff.intent WHERE(workspace_id,site_id,idempotency_key)=(${scope.workspaceId},${scope.siteId},${key})`;
    expect((await rows())[0]!.count).toBe(0n);
    await expect(
      prepareWordPress(db, actor, scope, originalReview),
    ).rejects.toThrow("REVISION_CONFLICT");
    expect((await rows())[0]!.count).toBe(0n);
    const fresh = await previewWordPress(db, actor, scope, {
      destinationId: configured.id,
      draftRevisionId: revisionId,
    });
    expect(fresh.hash).toBe(preview.hash);
    expect(fresh.destination.generation).toBe(updated.generation);
    const refreshedReview = {
      ...originalReview,
      expectedDestinationGeneration: fresh.destination.generation,
      expectedDestinationUrl: fresh.destination.url,
    };
    const saved = await prepareWordPress(db, actor, scope, refreshedReview);
    expect(saved.state).toBe("PREPARED");
    expect(saved.destination_url).toBe(fresh.url);
    expect((await rows())[0]!.count).toBe(1n);
  });
  it(`requires the reviewed destination binding through the real API after ${change}`, async () => {
    apiSeams.db = db;
    apiSeams.actor = actor;
    const priorCapabilities = process.env.LYRA_ENABLED_CAPABILITIES,
      priorKey = process.env.LYRA_HANDOFF_ENCRYPTION_KEY;
    vi.stubEnv(
      "LYRA_ENABLED_CAPABILITIES",
      `${priorCapabilities ?? ""},handoffs`,
    );
    vi.stubEnv(
      "LYRA_HANDOFF_ENCRYPTION_KEY",
      Buffer.alloc(32, 9).toString("base64"),
    );
    try {
      const configured = await wp(),
        params = new URLSearchParams({
          ...scope,
          action: "wordpress.preview",
          destinationId: configured.id,
          draftRevisionId: revisionId,
        });
      const previewResponse = await handoffApi.GET(
        new Request(
          `http://127.0.0.1:3012/api/integrations/handoffs?${params}`,
        ),
      );
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json(),
        key = randomUUID();
      const post = (value: Record<string, unknown>) =>
        handoffApi.POST(
          new Request("http://127.0.0.1:3012/api/integrations/handoffs", {
            method: "POST",
            headers: {
              origin: "http://127.0.0.1:3012",
              "content-type": "application/json",
            },
            body: JSON.stringify({ ...scope, ...value }),
          }),
        );
      apiSeams.actor = { ...actor, sessionId: "second-authorized-session" };
      const changed = await post({
        action: "wordpress.configure",
        installation:
          change === "installation"
            ? "https://example.com/second/"
            : configured.url,
        username: "second-editor",
        applicationPassword: "fixture-second-password",
        confirmed: true,
        expectedRevision: configured.revision,
      });
      expect(changed.status).toBe(200);
      apiSeams.actor = actor;
      const body = {
        action: "wordpress.prepare",
        destinationId: configured.id,
        draftRevisionId: revisionId,
        expectedBodyHash: preview.hash,
        expectedDestinationGeneration: preview.destination.generation,
        expectedDestinationUrl: preview.destination.url,
        idempotencyKey: key,
      };
      const stale = await post(body);
      expect(stale.status).toBe(409);
      const [missing] = await admin.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) FROM lyraseo_handoff.intent WHERE(workspace_id,site_id,idempotency_key)=(${scope.workspaceId},${scope.siteId},${key})`;
      expect(missing!.count).toBe(0n);
      const freshResponse = await handoffApi.GET(
          new Request(
            `http://127.0.0.1:3012/api/integrations/handoffs?${params}`,
          ),
        ),
        fresh = await freshResponse.json();
      expect(freshResponse.status).toBe(200);
      const saved = await post({
        ...body,
        expectedDestinationGeneration: fresh.destination.generation,
        expectedDestinationUrl: fresh.destination.url,
      });
      expect(saved.status).toBe(200);
      expect((await saved.json()).destination_url).toBe(fresh.url);
      const {
        expectedDestinationGeneration: _generation,
        expectedDestinationUrl: _url,
        ...withoutBinding
      } = body;
      expect(
        (await post({ ...withoutBinding, idempotencyKey: randomUUID() }))
          .status,
      ).toBe(409);
    } finally {
      vi.stubEnv("LYRA_ENABLED_CAPABILITIES", priorCapabilities);
      vi.stubEnv("LYRA_HANDOFF_ENCRYPTION_KEY", priorKey);
    }
  });
}
it("deletion-purpose seams require a tombstone, retire credentials immediately and erase only local scoped data", async () => {
  await expect(
    db.$queryRaw`SELECT lyraseo_handoff.retire_site(${scope.workspaceId},${scope.siteId})`,
  ).rejects.toThrow();
  await expect(
    executor.$queryRaw`SELECT lyraseo_handoff.erase_site(${scope.workspaceId},${scope.siteId})`,
  ).rejects.toThrow();
  await expect(
    admin.$queryRaw`SELECT lyraseo_handoff.retire_site(${scope.workspaceId},${scope.siteId})`,
  ).rejects.toThrow("SITE_NOT_TOMBSTONED");
  await admin.site.update({
    where: { id: scope.siteId },
    data: { deletedAt: new Date() },
  });
  await admin.$queryRaw`SELECT lyraseo_handoff.retire_site(${scope.workspaceId},${scope.siteId})`;
  const rows = await admin.$queryRaw<
    {
      status: string;
      secret_cipher: string | null;
      previous_cipher: string | null;
    }[]
  >`SELECT status,secret_cipher,previous_cipher FROM lyraseo_handoff.destination WHERE(workspace_id,site_id)=(${scope.workspaceId},${scope.siteId})`;
  expect(rows.length).toBeGreaterThan(0);
  expect(
    rows.every(
      (row) =>
        row.status === "REVOKED" &&
        row.secret_cipher === null &&
        row.previous_cipher === null,
    ),
  ).toBe(true);
  const [result] = await admin.$queryRaw<
    {
      value: {
        receipts: number;
        intents: number;
        destinations: number;
        externalCopies: string;
      };
    }[]
  >`SELECT lyraseo_handoff.erase_site(${scope.workspaceId},${scope.siteId}) AS value`;
  expect(result!.value.destinations).toBe(2);
  expect(result!.value.intents).toBeGreaterThan(0);
  expect(result!.value.externalCopies).toBe("USER_MANAGED");
  expect(
    await admin.$queryRaw`SELECT id FROM lyraseo_handoff.intent WHERE(workspace_id,site_id)=(${scope.workspaceId},${scope.siteId})`,
  ).toEqual([]);
  expect(
    await admin.site.findUnique({ where: { id: "handoff-b-site" } }),
  ).not.toBeNull();
  await expect(readHandoffs(db, actor, scope)).rejects.toThrow();
});
