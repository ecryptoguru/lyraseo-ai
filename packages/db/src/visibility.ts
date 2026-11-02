import { createHash } from "node:crypto";
import {
  EXTRACTION_VERSION,
  VISIBILITY_PROFILES,
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
import { withActor, authorizeSiteIn, type Actor } from "./context";
import type { SiteScope } from "./sites";
const json = (x: unknown) => x as Prisma.InputJsonValue;
export const visibilityAvailability = {
  available: false,
  reason:
    "Provider evidence contracts are not qualified: Azure deployment tariffs and grounding bounds; DataForSEO Standard raw-answer rights, English/India settings and trial access must be verified. No paid executor is enabled.",
  profiles: VISIBILITY_PROFILES,
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
export async function recordVisibilityEvidence(
  db: PrismaClient,
  actor: Actor,
  s: SiteScope,
  panelId: string,
  evidence: ProviderEvidence,
) {
  s = { workspaceId: s.workspaceId, siteId: s.siteId };
  return withActor(db, actor, s.workspaceId, async (tx) => {
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
      Date.parse(evidence.observedAt) > Date.now() + 30000 ||
      !Number.isFinite(Date.parse(evidence.observedAt)) ||
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
    const { slots: raw, ...provenance } = evidence;
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
      data: {
        ...s,
        panelId,
        profile: evidence.profile,
        cohort,
        provenance: json({
          ...provenance,
          extractionVersion: EXTRACTION_VERSION,
        }),
        slots: json(slots),
        rawAnswers: json(raw),
        createdAt: new Date(evidence.observedAt),
        rawExpiresAt: new Date(Date.parse(evidence.observedAt) + 90 * 86400000),
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
) {
  s = { workspaceId: s.workspaceId, siteId: s.siteId };
  return withActor(db, actor, s.workspaceId, async (tx) => {
    await authorizeSiteIn(tx, actor, s.workspaceId, s.siteId, "read");
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 13);
    const panels = await tx.visibilityPanel.findMany({
      where: s,
      orderBy: { version: "desc" },
      take: 30,
    });
    const runs = await tx.visibilityRun.findMany({
      where: {
        ...s,
        ...(runId ? { id: runId } : {}),
        createdAt: { gte: cutoff },
      },
      orderBy: { createdAt: "desc" },
      take: runId ? 1 : 20,
      select: {
        id: true,
        panelId: true,
        profile: true,
        cohort: true,
        provenance: true,
        slots: true,
        createdAt: true,
        rawExpiresAt: true,
      },
    });
    const results = [];
    for (const run of runs) {
      const panel = await tx.visibilityPanel.findFirst({
        where: { ...s, id: run.panelId },
      });
      const brands = (panel?.brands ?? []) as unknown as Brand[];
      const raw =
        runId && run.rawExpiresAt > now
          ? await tx.visibilityRun.findFirst({
              where: { ...s, id: run.id },
              select: { rawAnswers: true },
            })
          : null;
      results.push({
        ...run,
        summary: brands.length
          ? summarizeAnswers(
              run.slots as unknown as Answer[],
              brands.map((b) => b.id),
            )
          : null,
        ...(runId ? { rawAnswers: raw?.rawAnswers ?? null } : {}),
        rawExpired: run.rawExpiresAt <= now,
      });
    }
    return { panels, runs: results, availability: visibilityAvailability };
  });
}
