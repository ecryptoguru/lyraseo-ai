import { createHash } from "node:crypto";
import {
  compactEvaluation,
  compactReceipt,
  declared,
  obj,
  projectSnapshot,
  SAVED_FORMAT,
} from "./saved-evidence";
import { fingerprint } from "./audit-evidence";
import { observedSlots, provenanceSummary } from "./visibility";
import type { Brand } from "@lyraseo/visibility";
export const FULL_BACKUP_ADAPTER = "CURRENT_39_FULL_V1";
export type BackupRow = { data: Record<string, unknown>; jsonNulls: string[] };
export type BackupTables = Record<string, BackupRow[]>;
export type SavedBackupArtifact = {
  reportId: string;
  workspaceId: string;
  siteId: string;
  format: "pdf" | "csv";
  bytes: string;
  sha256: string;
  length: number;
};
type Replay = {
  phase: string;
  intentSequence?: number;
  sequence?: number;
  receiptClock?: {
    acceptedAt: string;
    deadline: string;
    recordExpiresAt: string;
  };
  intent: {
    action: string;
    workspaceId: string;
    siteId: string;
    incarnation: string;
  };
};
type Scope = { workspaceId: string; siteId: string; deletedAt?: string };
const publicNames =
  "ProductUser ProviderIdentity Workspace Membership Site SiteGrant StaffGrant StepUpGrant BudgetPeriod Operation OutboxEvent UsageReceipt AuthThrottle ProductSession OperationQuote AuditRun AuditPage IssueAction SiteVerificationChallenge SiteContextRevision GoogleOAuthState GoogleConnection SearchSnapshot ContentDraft ContentRevision EvidenceReport VisibilityPanel VisibilityRun ApiToken ApiThrottle PageIdentity PageJournal AnalyticsOAuthState AnalyticsConnection AnalyticsImport SearchImport RuntimePolicy RuntimePolicyChange WorkDispatch InternalRequest AuditPageRetention ContentRevisionPin ArtifactBlob ArtifactRef AuditEvaluationScratch VisibilityRecording VisibilityObservationSlot ArtifactExpiryPlan ArtifactExpiryItem ArtifactExpiryEvent _prisma_migrations AgencyBatchItem AgencyBatchQuote IssueAssignment IssueAssignmentEvent KeywordEnrichmentResult KeywordSelection WorkspaceAccessEvent WorkspaceBrandingRevision WorkspaceInvitation WorkspaceInvitationSite".split(
    " ",
  );
// Current-schema (39-migration) adapter. Every relation present in the
// assembled catalog is listed explicitly; unknown relations fail closed in
// supported() (full-backup.mjs) and in projectBackupTables below. No table
// is accepted by default.
export const fullBackupKnownTables = new Set([
  ...publicNames.map((name) => "public." + name),
  "lyraseo_kernel.test_environment",
  "lyraseo_audit.attempt",
  "lyraseo_audit.artifact_verifier",
  "lyraseo_audit.unavailable_observation",
  "lyraseo_origin.store_registration",
  "lyraseo_origin.source_store_key",
  "lyraseo_origin.store_namespace",
  "lyraseo_origin.blob_store_binding",
  "lyraseo_expiry.environment",
  "lyraseo_expiry.absence_verifier",
  "lyraseo_history.environment",
  "lyraseo_history.plan",
  "lyraseo_history.receipt",
  "lyraseo_deletion.scope_case",
  "lyraseo_deletion.task",
  "lyraseo_deletion.event",
  // lyraseo_billing: sandbox financial facts retained; bearer tokens,
  // step-ups, leases and staff policy intents omitted (see below).
  "lyraseo_billing.account",
  "lyraseo_billing.action_request",
  "lyraseo_billing.admission_binding",
  "lyraseo_billing.base_slot",
  "lyraseo_billing.binding",
  "lyraseo_billing.canonical_rejection",
  "lyraseo_billing.closed_job_request",
  "lyraseo_billing.discovery",
  "lyraseo_billing.economic_observation",
  "lyraseo_billing.event",
  "lyraseo_billing.event_route",
  "lyraseo_billing.inbox",
  "lyraseo_billing.intent",
  "lyraseo_billing.job_allocation",
  "lyraseo_billing.job_request",
  "lyraseo_billing.job_test_session",
  "lyraseo_billing.merchant",
  "lyraseo_billing.money_fact",
  "lyraseo_billing.policy_intent",
  "lyraseo_billing.price_mapping",
  "lyraseo_billing.recovery_case",
  "lyraseo_billing.request_resolution",
  "lyraseo_billing.retirement",
  "lyraseo_billing.staff_capability",
  "lyraseo_billing.staff_epoch",
  "lyraseo_billing.staff_rate",
  "lyraseo_billing.staff_receipt",
  "lyraseo_billing.step_up",
  "lyraseo_billing.subscription",
  "lyraseo_billing.transition",
  // lyraseo_handoff: outbound secrets revoked, dispatches suppressed.
  "lyraseo_handoff.destination",
  "lyraseo_handoff.dispatch",
  "lyraseo_handoff.dispatch_attempt",
  "lyraseo_handoff.dispatch_policy",
  "lyraseo_handoff.dispatch_policy_history",
  "lyraseo_handoff.egress_hour",
  "lyraseo_handoff.fixture_environment",
  "lyraseo_handoff.intent",
  "lyraseo_handoff.receipt",
  // lyraseo_ledger: financial attempt/settlement facts retained;
  // fixture environment omitted.
  "lyraseo_ledger.adjustment",
  "lyraseo_ledger.attempt",
  "lyraseo_ledger.attempt_event",
  "lyraseo_ledger.budget_pause",
  "lyraseo_ledger.environment",
  "lyraseo_ledger.managed_operation",
  "lyraseo_ledger.qualification",
  "lyraseo_ledger.reconciliation",
  "lyraseo_ledger.settlement",
  // Test-only legacy transition stores: catalogued, never restored with data.
  "lyraseo_legacy_inline.environment",
  "lyraseo_legacy_inline.event",
  "lyraseo_legacy_inline.permit",
  "lyraseo_legacy_inline.plan",
  "lyraseo_legacy_visibility.authorization",
  "lyraseo_legacy_visibility.enrollment",
  "lyraseo_legacy_visibility.event",
  "lyraseo_legacy_visibility.fixture_clock",
  "lyraseo_legacy_visibility.item",
  "lyraseo_legacy_visibility.plan",
  "lyraseo_legacy_visibility.retry",
  "lyraseo_legacy_visibility.scope",
  "lyraseo_observation_binding.fixture_attempt",
  // Saved-evidence withdrawal receipts.
  "lyraseo_report.decision",
  "lyraseo_report.environment",
]);
export const fullBackupOmittedTables = new Set([
  "public.ProductSession",
  "public.StepUpGrant",
  "public.AuthThrottle",
  "public.ApiToken",
  "public.ApiThrottle",
  "public.GoogleOAuthState",
  "public.AnalyticsOAuthState",
  "public.GoogleConnection",
  "public.AnalyticsConnection",
  "public.SiteVerificationChallenge",
  "public.InternalRequest",
  "public.AuditEvaluationScratch",
  "lyraseo_kernel.test_environment",
  "lyraseo_audit.attempt",
  "lyraseo_audit.artifact_verifier",
  "lyraseo_audit.unavailable_observation",
  "lyraseo_expiry.absence_verifier",
  "lyraseo_origin.store_registration",
  "lyraseo_origin.source_store_key",
  "lyraseo_origin.store_namespace",
  "lyraseo_origin.blob_store_binding",
  // Bearer/step-up/session replay material and one-use staff intents.
  // Parent rows for retained financial facts are never in this set.
  "lyraseo_billing.action_request",
  "lyraseo_billing.job_request",
  "lyraseo_billing.step_up",
  "lyraseo_billing.job_test_session",
  "lyraseo_billing.closed_job_request",
  "lyraseo_billing.request_resolution",
  "lyraseo_billing.policy_intent",
  "lyraseo_billing.inbox",
  "lyraseo_billing.discovery",
  "lyraseo_billing.staff_rate",
  // Fixture-only binding and dispatch replay keys.
  "lyraseo_handoff.fixture_environment",
  "lyraseo_handoff.dispatch_attempt",
  "lyraseo_ledger.environment",
  "lyraseo_observation_binding.fixture_attempt",
  // Test-only legacy transition stores (LOCAL_TEST_ONLY): no dataset rows.
  "lyraseo_legacy_inline.environment",
  "lyraseo_legacy_inline.plan",
  "lyraseo_legacy_inline.event",
  "lyraseo_legacy_inline.permit",
  "lyraseo_legacy_visibility.scope",
  "lyraseo_legacy_visibility.enrollment",
  "lyraseo_legacy_visibility.plan",
  "lyraseo_legacy_visibility.item",
  "lyraseo_legacy_visibility.fixture_clock",
  "lyraseo_legacy_visibility.retry",
  "lyraseo_legacy_visibility.authorization",
  "lyraseo_legacy_visibility.event",
  "lyraseo_report.environment",
  // Time-bound invitation bearers (hashes of usable invite tokens).
  "public.WorkspaceInvitation",
  "public.WorkspaceInvitationSite",
]);
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const text = (value: unknown) => (typeof value === "string" ? value : "");
const atTime = (value: unknown) =>
  typeof value === "string"
    ? Date.parse(/[Z+-][0-9:]*$/.test(value) ? value : value + "Z")
    : NaN;
export function projectBackupTables(
  input: BackupTables,
  options: { at: string; phase: "BACKUP" | "RESTORE"; events?: Replay[] },
) {
  const at = atTime(options.at);
  if (!Number.isFinite(at)) throw Error("INVALID_BACKUP_CLOCK");
  for (const name of Object.keys(input))
    if (!fullBackupKnownTables.has(name))
      throw Error("MISSING_BACKUP_ADAPTER:" + name);
  const original = JSON.parse(JSON.stringify(input)) as BackupTables;
  const tables = JSON.parse(JSON.stringify(input)) as BackupTables;
  const source = (name: string) =>
    original[name]?.map((packet) => packet.data) ?? [];
  const environments = source("lyraseo_history.environment"),
    sites = source("public.Site"),
    drafts = source("public.ContentDraft"),
    audits = source("public.AuditRun");
  const events = options.events ?? [];
  const scoped: Scope[] = [];
  for (const row of sites)
    if (row.deletedAt !== null && row.deletedAt !== undefined)
      scoped.push({ workspaceId: text(row.workspaceId), siteId: text(row.id) });
  for (const event of events) {
    if (
      !["DELETE_SITE", "REVOKE_INTEGRATIONS", "REVOKE_SITE_TOKENS"].includes(
        event.intent.action,
      )
    )
      throw Error("MISSING_JOURNAL_REPLAY_ADAPTER");
    if (event.intent.action !== "DELETE_SITE") continue;
    if (
      !environments.some(
        (entry) =>
          entry.workspace_id === event.intent.workspaceId &&
          entry.site_id === event.intent.siteId &&
          entry.incarnation === event.intent.incarnation,
      )
    )
      continue;
    if (
      event.phase === "APPLIED" &&
      (!event.receiptClock ||
        !Number.isFinite(Date.parse(event.receiptClock.acceptedAt)))
    )
      throw Error("MISSING_DELETE_RECEIPT_CLOCK");
    scoped.push({
      workspaceId: event.intent.workspaceId,
      siteId: event.intent.siteId,
      deletedAt: event.receiptClock?.acceptedAt,
    });
  }
  const erased = (w: unknown, s: unknown) =>
    scoped.some((scope) => scope.workspaceId === w && scope.siteId === s);
  const expiredAudits = new Set(
    audits
      .filter(
        (row) =>
          Number.isFinite(atTime(row.resultExpiresAt)) &&
          atTime(row.resultExpiresAt) <= at,
      )
      .map((row) => row.id),
  );
  const expiredVisibility = new Set(
    source("public.VisibilityRun")
      .filter(
        (row) =>
          Number.isFinite(atTime(row.resultExpiresAt)) &&
          atTime(row.resultExpiresAt) <= at,
      )
      .map((row) => row.id),
  );
  const expiredOrDeletedAudit = new Set(
    audits
      .filter(
        (row) =>
          expiredAudits.has(row.id) || erased(row.workspaceId, row.siteId),
      )
      .map((row) => row.id),
  );
  const expiredOrDeletedVisibility = new Set(
    source("public.VisibilityRun")
      .filter(
        (row) =>
          expiredVisibility.has(row.id) || erased(row.workspaceId, row.siteId),
      )
      .map((row) => row.id),
  );
  const removedDrafts = new Set(
    drafts
      .filter((row) => erased(row.workspaceId, row.siteId))
      .map((row) => row.id),
  );
  const removedExpiryPlans = new Set(
    source("public.ArtifactExpiryPlan")
      .filter((row) => erased(row.workspaceId, row.siteId))
      .map((row) => row.id),
  );
  const removedHistoryPlans = new Set(
    source("lyraseo_history.plan")
      .filter((row) => erased(row.workspace_id, row.site_id))
      .map((row) => row.id),
  );
  // Handoff intents and agency quotes are removed with their scope; their
  // children (receipt, dispatch, batch items) carry only the parent id, so
  // they must be resolved against the same removal set or FK validation
  // rejects the replay.
  const removedHandoffIntents = new Set(
    source("lyraseo_handoff.intent")
      .filter((row) => erased(row.workspace_id, row.site_id))
      .map((row) => row.id),
  );
  const expiredAgencyQuotes = new Set(
    source("public.AgencyBatchQuote")
      .filter(
        (row) =>
          Number.isFinite(atTime(row.expiresAt)) && atTime(row.expiresAt) <= at,
      )
      .map((row) => row.id),
  );
  const expiredKeywordSelections = new Set(
    source("public.KeywordSelection")
      .filter(
        (row) =>
          erased(row.workspaceId, row.siteId) ||
          (Number.isFinite(atTime(row.resultExpiresAt)) &&
            atTime(row.resultExpiresAt) <= at),
      )
      .map((row) => row.id),
  );
  const pins = source("public.ContentRevisionPin");
  const panels = new Map(
    source("public.VisibilityPanel").map((row) => [row.id, row]),
  );
  const artifacts: SavedBackupArtifact[] = [],
    redactions: {
      table: string;
      sourceHash: string;
      projectedHash: string;
      reason: string;
    }[] = [];
  const blockers = events.some(
    (event) =>
      event.phase === "INTENT" &&
      !events.some(
        (next) =>
          next.phase === "APPLIED" && next.intentSequence === event.sequence,
      ),
  )
    ? ["PENDING_DELETION_INTENT"]
    : [];
  for (const [table, packets] of Object.entries(tables)) {
    if (fullBackupOmittedTables.has(table)) {
      tables[table] = [];
      continue;
    }
    const kept: BackupRow[] = [];
    for (const packet of packets) {
      const row = packet.data,
        before = fingerprint(row);
      let omit = false;
      const jsonNull = (key: string, sqlNull = false) => {
        row[key] = null;
        packet.jsonNulls = packet.jsonNulls.filter((field) => field !== key);
        if (!sqlNull) packet.jsonNulls.push(key);
      };
      if (table === "public.Site") {
        if (erased(row.workspaceId, row.id)) {
          row.origin =
            "https://deleted-" +
            fingerprint([row.workspaceId, row.id]).slice(0, 24) +
            ".invalid";
          row.deletedAt =
            row.deletedAt ??
            scoped.find(
              (scope) =>
                scope.workspaceId === row.workspaceId &&
                scope.siteId === row.id &&
                scope.deletedAt,
            )?.deletedAt ??
            options.at;
          row.verifiedAt = null;
        }
      } else if (table === "public.Workspace") {
        if (row.deletedAt !== null && row.deletedAt !== undefined)
          row.name = "Deleted workspace";
      } else if (table === "public.ProductUser") {
        row.suspended = true;
        if (options.phase === "RESTORE")
          row.securityVersion = Number(row.securityVersion) + 1;
      } else if (table === "public.StaffGrant") row.enabled = false;
      else if (table === "public.Operation") {
        jsonNull("requestInput", true);
        row.leaseOwner = null;
        row.leaseUntil = null;
      } else if (table === "public.OperationQuote") jsonNull("requestInput");
      else if (table === "public.WorkDispatch") {
        omit =
          row.targetKind === "AUDIT_RAW" &&
          expiredOrDeletedAudit.has(row.auditId);
        row.disposition = "SUPPRESSED";
        row.revokedAt = options.at;
        row.nextAttemptAt = null;
        row.claimToken = null;
        row.leaseUntil = null;
        if (options.phase === "RESTORE")
          row.generation = Number(row.generation) + 1;
      } else if (table === "public.RuntimePolicy") {
        if (row.enabled === true) {
          row.enabled = false;
          row.revision = Number(row.revision) + 1;
          row.changedAt = options.at;
          (tables["public.RuntimePolicyChange"] ??= []).push({
            data: {
              key: row.key,
              revision: row.revision,
              enabled: false,
              operatorId: "LOCAL_BACKUP_RESTORE_V1",
              changedAt: options.at,
            },
            jsonNulls: [],
          });
        }
      } else if (table === "public.AuditRun") {
        omit = expiredOrDeletedAudit.has(row.id);
        row.evaluation = compactEvaluation(row.evaluation);
        row.declarations = declared(row.declarations);
        if (row.evaluation === null)
          packet.jsonNulls = packet.jsonNulls.filter(
            (field) => field !== "evaluation",
          );
        row.leaseOwner = null;
        row.leaseUntil = null;
      } else if (table === "public.AuditPage") {
        omit = expiredOrDeletedAudit.has(row.auditId);
        const evidence = obj(row.evidence);
        row.evidence = {
          acquired: evidence.acquired === true,
          status:
            typeof evidence.status === "number" ? evidence.status : undefined,
          headComplete: evidence.headComplete === true,
          bodyComplete: evidence.bodyComplete === true,
        };
        row.provenance = compactReceipt(row.provenance);
      } else if (
        table === "public.AuditPageRetention" ||
        table === "public.IssueAction" ||
        table === "public.IssueAssignment" ||
        table === "public.IssueAssignmentEvent"
      )
        omit =
          expiredOrDeletedAudit.has(row.auditId) ||
          erased(row.workspaceId, row.siteId);
      else if (table === "public.ContentDraft") {
        omit = removedDrafts.has(row.id);
        row.snapshot = projectSnapshot(row.snapshot);
      } else if (table === "public.ContentRevision") {
        omit = removedDrafts.has(row.draftId);
        const draft = drafts.find(
          (entry) =>
            entry.id === row.draftId && entry.workspaceId === row.workspaceId,
        );
        if (!draft) throw Error("BACKUP_REVISION_PARENT_MISSING");
        const pinned = pins.some(
          (entry) =>
            entry.workspaceId === row.workspaceId &&
            entry.draftId === row.draftId &&
            entry.revision === row.revision,
        );
        if (
          row.revision !== draft.revision &&
          !pinned &&
          Number.isFinite(atTime(row.historyExpiresAt)) &&
          atTime(row.historyExpiresAt) <= at
        )
          jsonNull("content");
      } else if (table === "public.ContentRevisionPin")
        omit = removedDrafts.has(row.draftId);
      else if (table === "public.EvidenceReport") {
        omit = erased(row.workspaceId, row.siteId);
        if (!omit) {
          const projected = projectSnapshot(row.snapshot);
          if (
            row.evidenceFormat !== SAVED_FORMAT ||
            fingerprint(projected) !== fingerprint(row.snapshot)
          )
            throw Error("BACKUP_REPORT_CLASSIFICATION_BLOCKED");
          if (options.phase === "BACKUP") {
            const pdf = text(row.pdf);
            if (!/^\\x[0-9a-f]*$/i.test(pdf))
              throw Error("BACKUP_REPORT_BYTES_INVALID");
            const content = Buffer.from(pdf.slice(2), "hex"),
              csv = Buffer.from(text(row.csv), "utf8");
            if (
              content.length > 10 * 1024 * 1024 ||
              csv.length > 10 * 1024 * 1024 ||
              !content.subarray(0, 5).equals(Buffer.from("%PDF-"))
            )
              throw Error("BACKUP_REPORT_BYTES_INVALID");
            for (const [format, bytes] of [
              ["pdf", content],
              ["csv", csv],
            ] as const)
              artifacts.push({
                reportId: text(row.id),
                workspaceId: text(row.workspaceId),
                siteId: text(row.siteId),
                format,
                bytes: bytes.toString("base64"),
                sha256: digest(bytes),
                length: bytes.length,
              });
            row.pdf = "\\x";
            row.csv = "";
          }
          row.snapshot = projected;
        }
      } else if (table === "public.VisibilityRun") {
        omit = expiredOrDeletedVisibility.has(row.id);
        jsonNull("rawAnswers", true);
        row.provenance = provenanceSummary(row.provenance);
        row.slots = observedSlots(
          row.slots,
          (obj(panels.get(row.panelId)).brands ?? []) as Brand[],
        );
      } else if (table === "public.VisibilityRecording") {
        omit =
          expiredOrDeletedVisibility.has(row.runId) ||
          erased(row.workspaceId, row.siteId);
        row.proof = "00000000-0000-0000-0000-000000000000";
        row.proofExpiresAt = "1970-01-01T00:00:00.000000Z";
        row.sourceBinding = "RESTORE_DISABLED";
        row.manifest = {};
        if (row.state === "STAGED") row.state = "CANCELLED";
      } else if (table === "public.VisibilityObservationSlot") {
        omit =
          expiredOrDeletedVisibility.has(row.runId) ||
          erased(row.workspaceId, row.siteId);
        if (row.disposition === "READY" || row.disposition === "STAGED")
          row.disposition = "RETIRED";
      } else if (
        table === "public.ArtifactBlob" ||
        table === "public.ArtifactRef"
      ) {
        omit =
          erased(row.workspaceId, row.siteId) ||
          expiredOrDeletedAudit.has(row.auditId) ||
          expiredOrDeletedVisibility.has(row.runId);
        if (table === "public.ArtifactBlob") {
          row.state = "DELETED";
          jsonNull("pendingReceipt", true);
        } else row.anchors = [];
      } else if (
        table === "public.SearchSnapshot" ||
        table === "public.SearchImport" ||
        table === "public.AnalyticsImport" ||
        table === "public.KeywordEnrichmentResult" ||
        table === "public.KeywordSelection"
      ) {
        omit =
          erased(row.workspaceId, row.siteId) ||
          (table === "public.KeywordSelection" &&
            expiredKeywordSelections.has(row.id)) ||
          (table === "public.KeywordEnrichmentResult" &&
            expiredKeywordSelections.has(row.selectionId)) ||
          (Number.isFinite(atTime(row.resultExpiresAt)) &&
            atTime(row.resultExpiresAt) <= at);
        if (table === "public.KeywordSelection") jsonNull("request");
        if (row.status === "running") {
          row.status = "failed";
          row.failure = "RESTORE_REQUIRES_EXPLICIT_REFRESH";
        }
        if (table === "public.AnalyticsImport") row.diagnostics = {};
      } else if (table === "public.AgencyBatchQuote") {
        omit = expiredAgencyQuotes.has(row.id);
        // Executable preview input and one-use confirmation bearer.
        jsonNull("requestInput");
        row.confirmationKey = null;
        row.confirmedAt = null;
      } else if (table === "public.AgencyBatchItem") {
        omit =
          expiredAgencyQuotes.has(row.batchQuoteId) ||
          erased(row.workspaceId, row.siteId);
      } else if (table === "lyraseo_history.environment") row.enabled = false;
      else if (table === "lyraseo_history.plan") {
        omit = erased(row.workspace_id, row.site_id);
        row.paused = true;
      } else if (table === "lyraseo_history.receipt")
        omit = removedHistoryPlans.has(row.plan_id);
      else if (table === "public.ArtifactExpiryPlan") {
        omit = removedExpiryPlans.has(row.id);
        row.paused = true;
      } else if (table === "public.ArtifactExpiryItem") {
        omit = erased(row.workspaceId, row.siteId);
        row.token = null;
        row.workerTokenHash = null;
        row.leaseUntil = null;
        if (row.status === "CLAIMED") row.status = "PENDING";
      } else if (table === "public.ArtifactExpiryEvent")
        omit = removedExpiryPlans.has(row.planId);
      else if (table === "public._prisma_migrations") row.logs = null;
      // Outbound handoff: secrets are revoked (CHECK requires null ciphers
      // for REVOKED), in-flight intents are cancelled, dispatches suppressed.
      else if (table === "lyraseo_handoff.destination") {
        omit = erased(row.workspace_id, row.site_id);
        row.status = "REVOKED";
        row.secret_cipher = null;
        row.previous_cipher = null;
        row.previous_key_id = null;
        row.previous_until = null;
        row.key_id = null;
      } else if (table === "lyraseo_handoff.intent") {
        omit = erased(row.workspace_id, row.site_id);
        if (
          row.state === "PREPARED" ||
          row.state === "SENDING" ||
          row.state === "RETRY"
        )
          row.state = "CANCELLED";
        row.lease_until = null;
        row.next_due_at = options.at;
      } else if (table === "lyraseo_handoff.receipt") {
        omit = removedHandoffIntents.has(row.intent_id);
      } else if (table === "lyraseo_handoff.dispatch") {
        omit = removedHandoffIntents.has(row.intent_id);
        row.state = "SUPPRESSED";
        row.claim_token = null;
        row.lease_until = null;
        row.next_due = null;
      } else if (table === "lyraseo_handoff.dispatch_policy") {
        if (row.enabled === true) {
          row.enabled = false;
          row.revision = Number(row.revision) + 1;
          row.changed_at = options.at;
          (tables["lyraseo_handoff.dispatch_policy_history"] ??= []).push({
            data: {
              revision: row.revision,
              enabled: false,
              operator_id: "LOCAL_BACKUP_RESTORE_V1",
              changed_at: options.at,
            },
            jsonNulls: [],
          });
        }
      } else if (table === "lyraseo_handoff.egress_hour") {
        omit = erased(row.workspace_id, row.site_id);
      }
      // Sandbox billing: financial facts are retained; entitlements,
      // merchants and staff authority are disabled.
      else if (table === "lyraseo_billing.merchant") row.enabled = false;
      else if (table === "lyraseo_billing.subscription") {
        row.sandbox_entitled = false;
        row.production_entitled = false;
      } else if (table === "lyraseo_billing.staff_capability") {
        if (row.enabled === true) {
          row.enabled = false;
          row.revision = Number(row.revision) + 1;
        }
      } else if (table === "lyraseo_billing.staff_epoch") {
        if (options.phase === "RESTORE")
          row.revision = Number(row.revision) + 1;
      } else if (table === "lyraseo_billing.recovery_case") {
        if (row.state === "VERIFYING" || row.state === "HOLD")
          row.state = "DENIED";
      }
      // Managed ledger: paused, leases cleared; attempt/settlement facts kept.
      else if (table === "lyraseo_ledger.managed_operation") row.paused = true;
      else if (table === "lyraseo_ledger.reconciliation") {
        row.lease_until = null;
        row.next_attempt_at = null;
      } else if (table === "lyraseo_ledger.qualification") {
        row.live_enabled = false;
        if (row.revoked_at === null || row.revoked_at === undefined)
          row.revoked_at = options.at;
      }
      // Saved-evidence withdrawal receipts: scope- and expiry-withdrawn.
      else if (table === "lyraseo_report.decision") {
        omit =
          erased(row.workspace_id, row.site_id) ||
          (Number.isFinite(atTime(row.receipt_expires_at)) &&
            atTime(row.receipt_expires_at) <= at);
      } else if ("workspaceId" in row && "siteId" in row)
        omit = erased(row.workspaceId, row.siteId);
      else if ("workspace_id" in row && "site_id" in row)
        omit = erased(row.workspace_id, row.site_id);
      // Logical row withdrawal must not lose SQL-NULL vs JSON-null domains.
      if (omit) {
        redactions.push({
          table,
          sourceHash: before,
          projectedHash: fingerprint(null),
          reason: "SCOPE_OR_RESULT_WITHDRAWN",
        });
        continue;
      }
      const after = fingerprint(row);
      if (before !== after)
        redactions.push({
          table,
          sourceHash: before,
          projectedHash: after,
          reason: "CLASSIFIED_PROJECTION",
        });
      kept.push(packet);
    }
    tables[table] = kept;
  }
  return { tables, artifacts, redactions, blockers };
}
