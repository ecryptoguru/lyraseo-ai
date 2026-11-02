import { randomUUID } from "node:crypto";
import type { createDatabase } from "@lyraseo/db";
import type { Actor } from "@lyraseo/db/context";
import {
  checkpointAuditPage,
  checkpointPrivateAudit,
  claimAuditRun,
  finishAuditRun,
  readAuditRun,
  readAuditProgress,
  yieldAuditRun,
  type AuditScope,
} from "@lyraseo/db/audits";
import {
  runAuditPage,
  type PublicTransport,
} from "@lyraseo/visibility/acquisition";

/** One bounded page per invocation. Successful checkpoints survive tab closure or restart. */
export async function runRawAuditStep(
  db: ReturnType<typeof createDatabase>,
  actor: Actor,
  scope: AuditScope,
  transport: PublicTransport,
) {
  const lease = await claimAuditRun(db, actor, scope, randomUUID());
  const stored = await readAuditProgress(db, actor, scope);
  const captured = new Set(stored.pages.map((page) => page.requestedUrl));
  const next = (stored.manifest as string[]).find((url) => !captured.has(url));
  if (next) {
    const siteOrigin = new URL(next).origin;
    if (lease.storageFormat === "AUDIT_PRIVATE_V1") {
      await runAuditPage(next, siteOrigin, transport, (receipt) =>
        checkpointPrivateAudit(db, actor, scope, lease.fence, receipt),
      );
      return readAuditRun(db, actor, scope);
    }
    await runAuditPage(next, siteOrigin, transport, (receipt) =>
      checkpointAuditPage(db, actor, scope, lease.fence, receipt.evidence, {
        ...receipt.provenance,
      }),
    );
    captured.add(next);
  }
  if (captured.size === (stored.manifest as string[]).length) {
    await finishAuditRun(db, actor, scope, lease.fence);
  } else {
    await yieldAuditRun(db, actor, scope, lease.fence);
  }
  return readAuditRun(db, actor, scope);
}
