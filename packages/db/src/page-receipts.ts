import type { Tx } from "./context";
import { compactReceipt } from "./saved-evidence";
import { readable } from "./retention";
import type { AuditScope } from "./audits";

/** Keep the raw document and parsed page content on the database side. */
export async function pageReceipts(tx: Tx, scope: AuditScope, now: Date) {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      requestedUrl: string;
      acquired: boolean | null;
      status: number | null;
      headComplete: boolean | null;
      bodyComplete: boolean | null;
      rawExpiresAt: Date | null;
      hasSource: boolean;
      receipt: unknown;
    }>
  >`
  SELECT p.id,p."requestedUrl",p.evidence->'acquired' = 'true'::jsonb AS acquired,
         CASE WHEN jsonb_typeof(p.evidence->'status')='number' THEN (p.evidence->>'status')::double precision END AS status,
         p.evidence->'headComplete'='true'::jsonb AS "headComplete",p.evidence->'bodyComplete'='true'::jsonb AS "bodyComplete",
         t."rawExpiresAt", jsonb_typeof(p.provenance->'rawHtml')='string' AS "hasSource",
         jsonb_build_object('acquiredAt',p.provenance->'acquiredAt','sha256',p.provenance->'sha256','channel',p.provenance->'channel',
          'error',p.provenance->'error','finalUrl',p.provenance->'finalUrl','status',p.provenance->'status',
          'redirects',(SELECT jsonb_agg(address ORDER BY ord) FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(p.provenance->'redirects')='array' THEN jsonb_path_query_array(p.provenance->'redirects','$[0 to 7]') ELSE '[]'::jsonb END) WITH ORDINALITY a(address,ord)
            WHERE jsonb_typeof(address)='string' AND octet_length(address::text)<=8194),
          'robotsPolicy',CASE WHEN jsonb_typeof(policy)='object' THEN jsonb_build_object(
            'requestedUrl',policy->'requestedUrl','finalUrl',policy->'finalUrl','acquiredAt',policy->'acquiredAt','status',policy->'status','sha256',policy->'sha256','state',policy->'state',
            'requested',CASE WHEN policy->'requested' IS NOT NULL THEN jsonb_build_object('url',policy#>'{requested,url}','allowed',policy#>'{requested,allowed}') END,
            'final',CASE WHEN policy->'final' IS NOT NULL THEN jsonb_build_object('url',policy#>'{final,url}','allowed',policy#>'{final,allowed}') END,
            'groupAgent',policy#>'{googleGroup,agent}','ruleCount',CASE WHEN jsonb_typeof(policy#>'{googleGroup,rules}')='array' THEN jsonb_array_length(policy#>'{googleGroup,rules}') END)
          END) AS receipt
    FROM "AuditPage" p
    CROSS JOIN LATERAL (SELECT p.provenance->'robotsPolicy' AS policy) receipt_policy
    JOIN "AuditRun" r ON r.id=p."auditId" AND r."workspaceId"=p."workspaceId"
    LEFT JOIN "AuditPageRetention" t ON t."pageId"=p.id AND t."workspaceId"=p."workspaceId" AND t."auditId"=p."auditId"
   WHERE r."workspaceId"=${scope.workspaceId} AND r."siteId"=${scope.siteId} AND r.id=${scope.auditId}
     AND r."resultExpiresAt">${now} ORDER BY p."requestedUrl" LIMIT 25`;
  return rows.map((p) => ({
    id: p.id,
    requestedUrl: p.requestedUrl,
    evidence: {
      acquired: p.acquired === true,
      status: p.status ?? undefined,
      headComplete: p.headComplete ?? undefined,
      bodyComplete: p.bodyComplete ?? undefined,
    },
    provenance: compactReceipt(p.receipt),
    rawExpiresAt: p.rawExpiresAt,
    sourceAvailability: !p.rawExpiresAt
      ? "unknown-clock"
      : !readable(now, p.rawExpiresAt)
        ? "expired"
        : p.hasSource
          ? "current"
          : "unavailable",
  }));
}
