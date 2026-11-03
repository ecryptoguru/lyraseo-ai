import { enrollTestArtifactAuthority } from "../../helpers/artifact-authority";
// Node-only disposable harness. Never imported by the Worker/application boot.
import { mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  localAuditArtifactStore,
  faultAfterMutation,
} from "../../../packages/db/src/artifact-store";
import { bindLocalArtifactStore } from "../../../packages/db/src/artifact-checkpoint";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createDatabase } from "../../../packages/db/src";
import {
  runtimePaths,
  type RuntimeKey,
} from "../../../packages/contracts/src/runtime-signing";
import { createControlledFixture } from "../../../apps/lyraseo-web/src/server/runtime/fixture";
import { startControlledRuntime } from "../../../apps/lyraseo-web/src/server/runtime/listener";
process.once(
  "message",
  async ({
    admin: adminUrl,
    secret,
    rotatedSecret,
    artifactParent,
  }: {
    admin: string;
    secret: string;
    rotatedSecret: string;
    artifactParent: string;
  }) => {
    const parsed = new URL(adminUrl);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.port !== "54329" ||
      !/^\/lyraseo_worker_[0-9a-f]{32}$/.test(parsed.pathname)
    )
      throw Error("OWNED_DISPOSABLE_DATABASE_REQUIRED");
    const admin = createDatabase(adminUrl);
    parsed.username = "lyraseo_dispatch";
    parsed.password = "local_dispatch_only";
    const db = createDatabase(parsed.href);
    const artifactRoot = await mkdtemp(
      join(await realpath(artifactParent), "objects-"),
    );
    const objects = await localAuditArtifactStore(artifactRoot);
    const authority = await enrollTestArtifactAuthority(admin, objects);
    bindLocalArtifactStore(db, faultAfterMutation(objects, "put"), authority);
    const original: RuntimeKey = {
      id: "supervised",
      principal: "lyraseo_dispatch",
      audience: "lyraseo-kernel-a",
      actions: runtimePaths,
      secret: new Uint8Array(Buffer.from(secret, "base64url")),
    };
    const rotated: RuntimeKey = {
      ...original,
      id: "replacement",
      secret: new Uint8Array(Buffer.from(rotatedSecret, "base64url")),
    };
    if (
      rotated.secret.byteLength !== 32 ||
      Buffer.from(rotated.secret).equals(Buffer.from(original.secret))
    )
      throw Error("INDEPENDENT_ROTATION_KEY_REQUIRED");
    let keys: RuntimeKey[] = [original],
      hops = 0;
    const fixture = createControlledFixture(
      "https://example.com",
      async (url, signal) => {
        signal.throwIfAborted();
        hops++;
        return url.endsWith("robots.txt")
          ? new Response(null, { status: 404 })
          : new Response(
              "<html><head><title>Controlled worker journey</title></head><body><main>Local fixture content</main></body></html>",
              { headers: { "Content-Type": "text/html" } },
            );
      },
    );
    const boot = () =>
      startControlledRuntime({ db, keys: () => keys, fixture });
    let runtime = await boot();
    const server = createServer(async (req, res) => {
      try {
        let result: unknown;
        switch (req.url) {
          case "/seed-private":
          case "/seed": {
            await admin.$executeRawUnsafe(
              'TRUNCATE TABLE "ProductUser", "Workspace", "StaffGrant", "StepUpGrant", "BudgetPeriod", "ProductSession" CASCADE',
            );
            await admin.internalRequest.deleteMany();
            hops = 0;
            keys = [original];
            await admin.productUser.create({ data: { id: "owner" } });
            await admin.workspace.create({
              data: { id: "a", name: "Controlled" },
            });
            await admin.membership.create({
              data: { workspaceId: "a", userId: "owner", role: "OWNER" },
            });
            await admin.site.create({
              data: {
                id: "a-site",
                workspaceId: "a",
                origin: "https://example.com",
                verifiedAt: new Date(),
              },
            });
            await admin.runtimePolicy.updateMany({ data: { enabled: false } });
            await admin.runtimePolicy.updateMany({
              where: { key: { in: ["global", "audits"] } },
              data: { enabled: true },
            });
            const audit = await admin.auditRun.create({
              data: {
                workspaceId: "a",
                siteId: "a-site",
                userId: "owner",
                securityVersion: 0,
                idempotencyKey: randomUUID(),
                inputHash: "fixture",
                profile: "CONTROLLED_RAW_TEST_V1",
                declarations: {},
                methodologyVersion: "readiness-v2",
                storageFormat:
                  req.url === "/seed-private" ? "AUDIT_PRIVATE_V1" : null,
                manifest: ["https://example.com/", "https://example.com/about"],
              },
            });
            const work = await admin.workDispatch.create({
              data: {
                workspaceId: "a",
                siteId: "a-site",
                userId: "owner",
                admittedSecurityVersion: 0,
                targetKind: "AUDIT_RAW",
                auditId: audit.id,
                capability: "audits",
                profile: audit.profile,
                eligibility: "CONTROLLED_TEST",
                admittedAt: audit.createdAt,
                expiresAt: new Date(+audit.createdAt + 3600000),
                disposition: "PENDING",
                nextAttemptAt: new Date(),
              },
            });
            result = { workId: work.id, auditId: audit.id };
            break;
          }
          case "/state":
            result = {
              audits: await admin.auditRun.findMany({
                select: { status: true },
              }),
              work: await admin.workDispatch.findMany({
                select: { id: true, generation: true, disposition: true },
              }),
              pages: await admin.auditPage.count(),
              refs: await admin.artifactRef.count(),
              scratch: await admin.auditEvaluationScratch.count(),
              inline: await admin.auditPage.count({
                where: {
                  provenance: { path: ["rawHtml"], string_contains: "<html>" },
                },
              }),
              replays: await admin.internalRequest.count(),
              hops,
            };
            break;
          case "/expire-delivery":
            await admin.workDispatch.updateMany({
              where: { claimToken: { not: null } },
              data: { leaseUntil: new Date(Date.now() - 1000) },
            });
            result = { ok: true };
            break;
          case "/target-revoke":
            await admin.workDispatch.updateMany({
              data: {
                revokedAt: new Date(),
                disposition: "SUPPRESSED",
                nextAttemptAt: null,
                claimToken: null,
                leaseUntil: null,
              },
            });
            result = { ok: true };
            break;
          case "/in-progress":
            await admin.auditRun.updateMany({
              data: {
                status: "RUNNING",
                leaseOwner: randomUUID(),
                leaseUntil: new Date(Date.now() + 90000),
              },
            });
            result = { ok: true };
            break;
          case "/pause":
            await admin.runtimePolicy.updateMany({ data: { enabled: false } });
            result = { ok: true };
            break;
          case "/revoke":
            keys = [];
            result = { ok: true };
            break;
          case "/restore":
            keys = [original];
            result = { ok: true };
            break;
          case "/rotate":
            keys = [rotated];
            result = { ok: true };
            break;
          case "/cancel":
            await admin.auditRun.updateMany({ data: { status: "FAILED" } });
            result = { ok: true };
            break;
          case "/delete":
            await admin.site.updateMany({ data: { deletedAt: new Date() } });
            result = { ok: true };
            break;
          case "/restart":
            await runtime.close();
            runtime = await boot();
            {
              const version = await new Promise<number>((resolve, reject) => {
                const handler = (message: {
                  event: string;
                  origin: string;
                  version: number;
                }) => {
                  if (message.event !== "restart-pinned") return;
                  clearTimeout(timer);
                  process.removeListener("message", handler);
                  if (
                    message.origin !== runtime.origin ||
                    !Number.isSafeInteger(message.version) ||
                    message.version < 2
                  )
                    return reject(Error("INVALID_RESTART_PIN"));
                  resolve(message.version);
                };
                const timer = setTimeout(() => {
                  process.removeListener("message", handler);
                  reject(Error("RESTART_PIN_TIMEOUT"));
                }, 3000);
                process.on("message", handler);
                process.send?.({
                  event: "restart-pin",
                  origin: runtime.origin,
                });
              });
              result = { origin: runtime.origin, version };
            }
            break;
          default:
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"HARNESS_FAILURE"}');
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.send?.({
      event: "ready",
      origin: runtime.origin,
      control: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    });
    const close = async () => {
      await runtime.close();
      await new Promise<void>((r) => server.close(() => r()));
      await objects.close();
      await authority.revoke();
      await Promise.all([admin.$disconnect(), db.$disconnect()]);
      process.exit(0);
    };
    process.once("SIGTERM", () => void close());
  },
);
process.send?.({ event: "configure" });
