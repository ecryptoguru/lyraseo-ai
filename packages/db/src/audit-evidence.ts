import { createHash } from "node:crypto";
import {
  evaluateAudit,
  normalizeUrl,
  type PageEvidence,
  type Methodology,
} from "@lyraseo/visibility";
import { validRawRobotsReceipt } from "@lyraseo/visibility/robots-source";
import type { AuditDeclarations } from "./audits";
const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, stable(item)]),
        )
      : value;
export const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
function validFinalUrl(value: unknown, requested: string) {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  try {
    return new URL(normalizeUrl(value)).origin === new URL(requested).origin;
  } catch {
    return false;
  }
}
export type AuditFacts = {
  manifest: unknown;
  methodologyVersion: string;
  profile: string;
};
export function validateRawPage(
  run: AuditFacts,
  evidence: PageEvidence,
  provenance: Record<string, unknown>,
) {
  if (
    !(run.manifest as string[]).includes(evidence.requestedUrl) ||
    provenance.requestedUrl !== evidence.requestedUrl ||
    provenance.channel !== "raw-http" ||
    typeof provenance.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(provenance.acquiredAt)) ||
    Date.parse(provenance.acquiredAt) > Date.now() ||
    !validFinalUrl(evidence.finalUrl, evidence.requestedUrl) ||
    !validFinalUrl(provenance.finalUrl, evidence.requestedUrl) ||
    (evidence.finalUrl !== undefined &&
      provenance.finalUrl !== undefined &&
      evidence.finalUrl !== provenance.finalUrl)
  )
    throw new Error("INVALID_PAGE_EVIDENCE");
  if (
    Buffer.byteLength(JSON.stringify(evidence), "utf8") > 262144 ||
    Buffer.byteLength(JSON.stringify(provenance), "utf8") > 32 * 1024 * 1024 ||
    (typeof provenance.rawHtml === "string" &&
      Buffer.byteLength(provenance.rawHtml, "utf8") > 5 * 1024 * 1024)
  )
    throw new Error("EVIDENCE_TOO_LARGE");
  // LOCAL_RAW_V1 has no renderer. Even trusted internal writers cannot
  // promote raw anchors, headings or metadata to rendered observations.
  if (
    run.methodologyVersion === "readiness-v2" &&
    ["LOCAL_RAW_V1", "CONTROLLED_RAW_TEST_V1"].includes(run.profile) &&
    (!validRawRobotsReceipt(evidence, provenance.robotsPolicy) ||
      (evidence.acquired &&
        (typeof provenance.rawHtml !== "string" ||
          !provenance.rawHtml.length)) ||
      evidence.headComplete ||
      evidence.bodyComplete ||
      evidence.metadata?.rendered !== undefined ||
      evidence.jsonLdComplete ||
      evidence.mainMediaNames !== undefined ||
      evidence.logoNames !== undefined ||
      evidence.visibleText !== undefined ||
      evidence.mainText !== undefined ||
      evidence.populatedSections !== undefined ||
      evidence.articleDates !== undefined ||
      evidence.headingLevels.length ||
      evidence.h1Texts.length ||
      evidence.headingTexts !== undefined ||
      evidence.pageType !== undefined ||
      evidence.indexingIntent !== undefined ||
      evidence.intendedCanonical !== undefined ||
      evidence.intentionallyExcluded !== undefined)
  )
    throw new Error("INVALID_PAGE_EVIDENCE");
  const raw = provenance.rawHtml;
  if (
    typeof raw === "string" &&
    (raw.includes("\u0000") ||
      (provenance.sha256 !== undefined &&
        provenance.sha256 !==
          createHash("sha256").update(raw, "utf8").digest("hex")))
  )
    throw new Error("INVALID_PAGE_EVIDENCE");
  if (
    run.profile === "CONTROLLED_RAW_TEST_V1" &&
    evidence.acquired &&
    (typeof provenance.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(provenance.sha256))
  )
    throw new Error("INVALID_PAGE_EVIDENCE");
}
export function frozenEvaluation(
  run: AuditFacts & { declarations: unknown },
  origin: string,
  pages: PageEvidence[],
) {
  if (pages.length !== (run.manifest as string[]).length)
    throw new Error("AUDIT_INCOMPLETE");
  return evaluateAudit({
    ...(run.declarations as AuditDeclarations),
    siteOrigin: origin,
    manifest: run.manifest as string[],
    pages,
    methodologyVersion: run.methodologyVersion as Methodology,
    profile: run.profile,
  });
}
