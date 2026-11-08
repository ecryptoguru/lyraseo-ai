import { withEvidenceRead } from "./context";
import { obj } from "./saved-evidence";
import { fixedDays, retention } from "./retention";
import { createHash } from "node:crypto";
import {
  EXTRACTION_VERSION,
  VISIBILITY_PROFILES,
  observationCapabilities,
  validatePanel,
  extractBrands,
  summarizeAnswers,
  type Brand,
  type Prompt,
  type VisibilityProfile,
  type Annotation,
  type Answer,
} from "@lyraseo/visibility";
import type { PrismaClient, Prisma } from "../generated/client";
import {
  withActor,
  authorizeSiteIn,
  verifyActorIn,
  type Actor,
} from "./context";
import { budgetSnapshotIn } from "./accounting";
import type { SiteScope } from "./sites";
import {
  recordPrivateObservation,
  observationAvailabilityIn,
} from "./observation-artifacts";
import type { ObservationRecording } from "./observation-source";
const json = (x: unknown) => x as Prisma.InputJsonValue;
export const visibilityAvailability = {
  available: false,
  reason:
    "Provider evidence contracts are not qualified: Azure deployment tariffs and grounding bounds; DataForSEO Standard raw-answer rights, English/India settings and trial access must be verified. No paid executor is enabled.",
  profiles: VISIBILITY_PROFILES,
  profileCapabilities: observationCapabilities(),
};
export async function createVisibilityPanel(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  prompts: Prompt[],
  brands: Brand[],
) {
  s = { workspaceId: s.workspaceId, siteId: s.siteId };
  validatePanel(prompts, brands);
  return withActor(db, actor, s.workspaceId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Site" WHERE id=${s.siteId} AND "workspaceId"=${s.workspaceId} FOR UPDATE`;
    await authorizeSiteIn(tx, actor, s.workspaceId, s.siteId, "edit");
    const last = await tx.visibilityPanel.findFirst({
      where: s,
      orderBy: { version: "desc" },
    });
    return tx.visibilityPanel.create({
      data: {
        ...s,
        version: (last?.version ?? 0) + 1,
        prompts: json(prompts),
        brands: json(brands),
        createdBy: actor.userId,
      },
    });
  });
}
export async function reviewVisibilityPanel(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  panelId: string,
) {
  s = { workspaceId: s.workspaceId, siteId: s.siteId };
  return withActor(db, actor, s.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, s.workspaceId, s.siteId, "edit");
    const row = await tx.visibilityPanel.findFirst({
      where: { ...s, id: panelId },
    });
    if (!row) throw new Error("NOT_FOUND");
    if (row.reviewedAt) return row;
    await tx.visibilityPanel.updateMany({
      where: { ...s, id: panelId, reviewedAt: null },
      data: { reviewedBy: actor.userId, reviewedAt: new Date() },
    });
    return tx.visibilityPanel.findFirstOrThrow({
      where: { ...s, id: panelId },
    });
  });
}
export async function requestVisibilityRun(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  panelId: string,
  profile: VisibilityProfile,
) {
  s = { workspaceId: s.workspaceId, siteId: s.siteId };
  return withActor(db, actor, s.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, s.workspaceId, s.siteId, "run");
    if (!VISIBILITY_PROFILES.includes(profile))
      throw new Error("INVALID_PROFILE");
    if (
      !(await tx.visibilityPanel.findFirst({
        where: { ...s, id: panelId, reviewedAt: { not: null } },
      }))
    )
      throw new Error("REVIEWED_PANEL_REQUIRED");
    return visibilityAvailability;
  });
}
/** Scope and allowance only: no quote, reservation, dispatch, or provider call. */
export async function previewVisibilityRun(
  db: PrismaClient,
  actor: Actor,
  scope: SiteScope,
  panelId: string,
  profile: VisibilityProfile,
  now = new Date(),
) {
  const s = { workspaceId: scope.workspaceId, siteId: scope.siteId };
  if (!Number.isFinite(now.getTime()) || !VISIBILITY_PROFILES.includes(profile))
    throw new Error("INVALID_PROFILE");
  return withActor(db, actor, s.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, s.workspaceId, s.siteId, "run");
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${s.workspaceId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "Site" WHERE "workspaceId"=${s.workspaceId} AND id=${s.siteId} FOR SHARE`;
    await authorizeSiteIn(tx, actor, s.workspaceId, s.siteId, "run");
    const panel = await tx.visibilityPanel.findFirst({
      where: { ...s, id: panelId, reviewedAt: { not: null } },
    });
    if (!panel) throw new Error("REVIEWED_PANEL_REQUIRED");
    const prompts = panel.prompts as unknown as Prompt[];
    validatePanel(prompts, panel.brands as unknown as Brand[]);
    const budgets = await budgetSnapshotIn(tx, actor, now);
    await verifyActorIn(tx, actor, s.workspaceId);
    const site = await authorizeSiteIn(
      tx,
      actor,
      s.workspaceId,
      s.siteId,
      "run",
    );
    const buckets =
      profile === "azure-sol-api"
        ? { provider: "AZURE", observations: "API_OBSERVATION" }
        : {
            provider: "DATAFORSEO",
            observations:
              profile === "consumer-chatgpt"
                ? "CHATGPT_OBSERVATION"
                : "GEMINI_OBSERVATION",
          };
    const item = (bucket: string) => {
      const row = budgets.find((value) => value.bucket === bucket);
      if (!row) throw new Error("ALLOWANCE_UNAVAILABLE");
      const available = row.limit.minus(row.spent).minus(row.reserved);
      return {
        bucket,
        limit: row.limit.toString(),
        spent: row.spent.toString(),
        reserved: row.reserved.toString(),
        remaining: available.isNegative() ? "0" : available.toString(),
        overLimit: available.isNegative(),
      };
    };
    const verifiedAt = site.verifiedAt?.getTime();
    return {
      available: false as const,
      panel: {
        id: panel.id,
        version: panel.version,
        promptCount: prompts.length,
      },
      requested: { profile, language: "en" as const, market: "IN" as const },
      verification:
        verifiedAt !== undefined &&
        now.getTime() - verifiedAt <= 86400000 &&
        verifiedAt <= now.getTime() + 30000
          ? ("current" as const)
          : ("required" as const),
      incompatiblePromptIds:
        profile === "azure-sol-api"
          ? []
          : prompts.filter((p) => p.text.length > 2000).map((p) => p.id),
      quote: null,
      maximumCost: null,
      cacheStatus: "not-checked" as const,
      allowance: {
        asOf: now.toISOString(),
        period: budgets[0]!.period,
        combined: item("COMBINED"),
        provider: item(buckets.provider),
        observations: item(buckets.observations),
      },
      reasons: observationCapabilities().find(
        (value) => value.profile === profile,
      )!.reasons,
    };
  });
}
/** Trusted worker contract only; never mounted as a customer answer-upload endpoint.
 * A future paid worker must complete quoted/reserved/receipted/settled ledger admission before invoking this boundary. */
export type ProviderEvidence = {
  profile: VisibilityProfile;
  provider: string;
  model: string;
  modelVersion: string;
  retrievalMode: string;
  requestedLocale: { language: "en"; market: "IN" };
  confirmedLocale: { language: string | null; market: string | null };
  synthetic: boolean;
  rawAnswerRights: boolean;
  observedAt: string;
  rawRightsUntil?: string;
  slots: {
    promptId: string;
    state: Answer["state"];
    body?: string;
    annotations: Annotation[];
    providerTaskId: string;
    completedAt: string;
    failureReason?: string;
  }[];
};
export function provenanceSummary(value: unknown) {
  const p = obj(value);
  const text = (v: unknown, max = 128) =>
    typeof v === "string" && v.length <= max ? v : undefined;
  const locale = (v: unknown) => ({
    language: text(obj(v).language, 32) ?? null,
    market: text(obj(v).market, 32) ?? null,
  });
  return {
    profile: text(p.profile),
    provider: text(p.provider),
    model: text(p.model),
    modelVersion: text(p.modelVersion),
    retrievalMode: text(p.retrievalMode),
    observedAt: text(p.observedAt, 40),
    synthetic: typeof p.synthetic === "boolean" ? p.synthetic : undefined,
    rawAnswerRights: p.rawAnswerRights === true,
    rawRightsUntil: text(p.rawRightsUntil, 40),
    requestedLocale: locale(p.requestedLocale),
    confirmedLocale: locale(p.confirmedLocale),
    extractionVersion: text(p.extractionVersion),
    clockContract: text(p.clockContract),
    representation: text(p.representation),
    producerClass: text(p.producerClass),
  };
}
export function observedSlots(value: unknown, brands: Brand[]) {
  if (!Array.isArray(value)) return [];
  const flag = (v: unknown) => (typeof v === "boolean" ? v : null);
  return value.map((v) => {
    const s = obj(v),
      extraction = obj(s.extraction);
    return {
      promptId: typeof s.promptId === "string" ? s.promptId : "",
      state: s.state as Answer["state"],
      providerTaskId:
        typeof s.providerTaskId === "string" && s.providerTaskId.length <= 256
          ? s.providerTaskId
          : undefined,
      completedAt:
        typeof s.completedAt === "string" && s.completedAt.length <= 40
          ? s.completedAt
          : undefined,
      failureReason:
        typeof s.failureReason === "string" && s.failureReason.length <= 128
          ? s.failureReason
          : undefined,
      extraction: Object.fromEntries(
        brands
          .filter((b) => extraction[b.id] !== undefined)
          .map((b) => {
            const e = obj(extraction[b.id]);
            return [
              b.id,
              {
                mention: flag(e.mention),
                citation: flag(e.citation),
                recommendation: flag(e.recommendation),
                reason:
                  typeof e.reason === "string" && e.reason.length <= 128
                    ? e.reason
                    : null,
              },
            ];
          }),
      ),
    };
  });
}
export async function recordVisibilityEvidence(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  panelId: string,
  evidence: ProviderEvidence,
  recording?: ObservationRecording,
) {
  if (recording)
    return recordPrivateObservation(db, actor, s, panelId, evidence, recording);
  s = { workspaceId: s.workspaceId, siteId: s.siteId };
  return withActor(db, actor, s.workspaceId, async (tx) => {
    // Match the legacy SQL fence order before admission and every retry.
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${s.workspaceId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "Site" WHERE "workspaceId"=${s.workspaceId} AND id=${s.siteId} FOR UPDATE`;
    await authorizeSiteIn(tx, actor, s.workspaceId, s.siteId, "run");
    const panel = await tx.visibilityPanel.findFirst({
      where: { ...s, id: panelId, reviewedAt: { not: null } },
    });
    if (!panel) throw new Error("REVIEWED_PANEL_REQUIRED");
    const prompts = panel.prompts as unknown as Prompt[],
      brands = panel.brands as unknown as Brand[];
    if (
      !VISIBILITY_PROFILES.includes(evidence.profile) ||
      !evidence.provider ||
      !evidence.model ||
      !evidence.modelVersion ||
      !evidence.retrievalMode ||
      typeof evidence.synthetic !== "boolean" ||
      evidence.rawAnswerRights !== true ||
      Date.parse(evidence.observedAt) > Date.now() ||
      !Number.isFinite(Date.parse(evidence.observedAt)) ||
      (evidence.rawRightsUntil !== undefined &&
        !Number.isFinite(Date.parse(evidence.rawRightsUntil))) ||
      evidence.requestedLocale.language !== "en" ||
      evidence.requestedLocale.market !== "IN" ||
      evidence.slots.length !== prompts.length ||
      new Set(evidence.slots.map((x) => x.promptId)).size !== prompts.length
    )
      throw new Error("INVALID_PROVIDER_EVIDENCE");
    const expectedProvider =
      evidence.profile === "azure-sol-api" ? "azure" : "dataforseo";
    if (evidence.provider !== expectedProvider)
      throw new Error("PROFILE_PROVIDER_MISMATCH");
    const consumerLocaleSupported =
      evidence.profile === "azure-sol-api" ||
      (evidence.confirmedLocale.language === "en" &&
        evidence.confirmedLocale.market === "IN");
    const slots = evidence.slots.map((slot) => {
      if (
        !consumerLocaleSupported &&
        ["successful", "ambiguous"].includes(slot.state)
      )
        throw new Error("UNSUPPORTED_PROVIDER_LOCALE");
      if (
        !prompts.some((p) => p.id === slot.promptId) ||
        !slot.providerTaskId ||
        !Number.isFinite(Date.parse(slot.completedAt)) ||
        ![
          "successful",
          "failed",
          "unsupported",
          "no-answer",
          "ambiguous",
        ].includes(slot.state) ||
        ((slot.state === "successful" || slot.state === "ambiguous") &&
          (!slot.body?.trim() || slot.body.length > 100000)) ||
        (!["successful", "ambiguous"].includes(slot.state) &&
          !slot.failureReason)
      )
        throw new Error("INVALID_PROVIDER_EVIDENCE");
      return {
        promptId: slot.promptId,
        state: slot.state,
        providerTaskId: slot.providerTaskId,
        completedAt: slot.completedAt,
        failureReason: slot.failureReason ?? null,
        extraction: ["successful", "ambiguous"].includes(slot.state)
          ? extractBrands(slot.body!, slot.annotations, brands)
          : {},
      };
    });
    const raw = evidence.slots;
    const cohort = createHash("sha256")
      .update(
        JSON.stringify({
          panelId,
          profile: evidence.profile,
          provider: evidence.provider,
          model: evidence.model,
          version: evidence.modelVersion,
          retrieval: evidence.retrievalMode,
          requested: evidence.requestedLocale,
          confirmed: evidence.confirmedLocale,
          synthetic: evidence.synthetic,
          extraction: EXTRACTION_VERSION,
        }),
      )
      .digest("hex");
    return tx.visibilityRun.create({
      select: { id: true, storageFormat: true },
      data: {
        ...s,
        panelId,
        profile: evidence.profile,
        cohort,
        provenance: json({
          ...provenanceSummary(evidence),
          extractionVersion: EXTRACTION_VERSION,
        }),
        slots: json(slots),
        rawAnswers: json(raw),
        createdAt: new Date(evidence.observedAt),
        rawExpiresAt: new Date(
          Math.min(
            +fixedDays(new Date(evidence.observedAt), retention.answerDays),
            evidence.rawRightsUntil === undefined
              ? Infinity
              : Date.parse(evidence.rawRightsUntil),
          ),
        ),
      },
    });
  });
}
export async function readVisibility(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  runId?: string,
  now = new Date(),
  revalidateActor?: () => Promise<Actor>,
) {
  s = { workspaceId: s.workspaceId, siteId: s.siteId };
  actor = { ...actor };
  if (runId && revalidateActor) {
    const current = await revalidateActor();
    if (
      !current ||
      current.userId !== actor.userId ||
      current.sessionId !== actor.sessionId ||
      current.securityVersion !== actor.securityVersion
    )
      throw new Error("FORBIDDEN");
    actor = { ...current };
  }
  const read = async (tx: import("./context").Tx) => {
    type Detail = {
      state: string;
      rawAnswers?: unknown;
      representation?: string;
      originalProviderWire?: boolean;
      otherFieldResidual?: string;
    };
    const detailIn = async () => {
      const [row] = await tx.$queryRaw<
        { detail: Detail }[]
      >`SELECT lyraseo_legacy_visibility.read_detail(${s.siteId},${runId!},${actor.securityVersion}::integer,${actor.sessionId}) AS detail`;
      if (!row?.detail) throw new Error("NOT_FOUND");
      if (row.detail.state === "result-expired")
        throw new Error("SOURCE_EXPIRED");
      return row.detail;
    };
    if (runId) await detailIn();
    const panels = await tx.visibilityPanel.findMany({
      where: s,
      orderBy: { version: "desc" },
      take: 30,
    });
    const runs = await tx.visibilityRun.findMany({
      where: {
        ...s,
        ...(runId ? { id: runId } : {}),
        resultExpiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
      take: runId ? 1 : 20,
      select: {
        id: true,
        panelId: true,
        profile: true,
        createdAt: true,
        rawExpiresAt: true,
        storageFormat: true,
      },
    });
    if (runId && !runs.length)
      throw new Error(
        (await tx.visibilityRun.count({ where: { ...s, id: runId } }))
          ? "SOURCE_EXPIRED"
          : "NOT_FOUND",
      );
    const results = [];
    for (const run of runs) {
      const panel = await tx.visibilityPanel.findFirst({
        where: { ...s, id: run.panelId },
      });
      const brands = (panel?.brands ?? []) as unknown as Brand[];
      const [projection] = await tx.$queryRaw<
        {
          value: {
            slots: unknown;
            provenance: unknown;
            measurementSafe: boolean;
            cohort: string | null;
          };
        }[]
      >`SELECT lyraseo_legacy_visibility.read_projection(${s.siteId},${run.id},${actor.securityVersion}::integer,${actor.sessionId}) AS value`;
      if (!projection?.value) throw new Error("NOT_FOUND");
      const slots = observedSlots(projection.value.slots, brands);
      const provenance = provenanceSummary(projection.value.provenance);
      results.push({
        ...run,
        cohort: projection.value.cohort,
        slots,
        provenance,
        summary:
          brands.length && projection.value.measurementSafe
            ? summarizeAnswers(
                slots,
                brands.map((b) => b.id),
              )
            : null,
        ...(runId ? { rawAnswers: null as unknown, rawState: "" } : {}),
        ...(runId && run.storageFormat === "OBSERVATION_PRIVATE_V1"
          ? {
              rawAvailability: await observationAvailabilityIn(
                tx,
                actor,
                s,
                run.id,
                slots.map((slot) => slot.promptId),
              ),
            }
          : {}),
        rawExpired: run.rawExpiresAt <= now,
      });
    }
    if (runId && results[0]) {
      const detail = await detailIn();
      Object.assign(results[0], {
        rawAnswers: detail.rawAnswers ?? null,
        rawState: detail.state,
        rawExpired:
          detail.state === "raw-expired" || detail.state === "raw-erased",
        representation: detail.representation,
        originalProviderWire: detail.originalProviderWire,
        otherFieldResidual: detail.otherFieldResidual,
      });
    }
    return { panels, runs: results, availability: visibilityAvailability };
  };
  if (runId)
    return withActor(db, actor, s.workspaceId, async (tx) => {
      await authorizeSiteIn(tx, actor, s.workspaceId, s.siteId, "read");
      return read(tx);
    });
  return withEvidenceRead(db, actor, s, "read", undefined, read);
}
