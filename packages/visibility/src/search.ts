export const SEARCH_KEY_MAX_UNITS = 8192;
export type SearchEvidenceRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  position: number | null;
  ctr: number | null;
};
export type SearchSnapshot = {
  id: string;
  shape: string;
  rows: unknown;
  startDate: string;
  endDate: string;
  status: string;
  property?: string;
};
/** Same-property, equal-duration, non-overlapping page windows only. */
export function comparableSearchWindow<
  T extends Pick<
    SearchSnapshot,
    "id" | "shape" | "startDate" | "endDate" | "property" | "status"
  >,
>(
  current:
    Pick<SearchSnapshot, "startDate" | "endDate" | "property"> | undefined,
  candidates: readonly T[],
): T | undefined {
  if (!current) return undefined;
  const duration = Date.parse(current.endDate) - Date.parse(current.startDate);
  return [...candidates]
    .sort((a, b) => b.endDate.localeCompare(a.endDate))
    .find(
      (snapshot) =>
        snapshot.shape === "page" &&
        snapshot.endDate < current.startDate &&
        Date.parse(snapshot.endDate) - Date.parse(snapshot.startDate) ===
          duration &&
        snapshot.property === current.property &&
        snapshot.status === "complete",
    );
}
export type SearchOpportunity = {
  kind: string;
  query: string;
  page: string;
  evidence: Record<string, unknown>;
  explanation: string;
};
export type SearchAuditEvidence = {
  id: string;
  createdAt: Date | string;
  manifest: unknown;
  evaluation: unknown;
};

/** Correlation only: observed demand does not establish that a finding caused search performance. */
export function buildSearchAuditOpportunities(
  snapshots: readonly SearchSnapshot[],
  audits: readonly SearchAuditEvidence[],
): SearchOpportunity[] {
  const current = [...snapshots]
    .filter((s) => s.shape === "page")
    .sort((a, b) => b.endDate.localeCompare(a.endDate))[0];
  if (!current) return [];
  const ordered = [...audits].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return rows(current)
    .filter((row) => row.keys.length === 1 && row.impressions >= 100)
    .flatMap((row) => {
      const page = row.keys[0]!;
      const audit = ordered.find(
        (a) => Array.isArray(a.manifest) && a.manifest.includes(page),
      );
      const rules = (
        audit?.evaluation as {
          rules?: Array<{ scopeKey: string; ruleId: string; outcome: string }>;
        } | null
      )?.rules;
      const failures =
        rules
          ?.filter((rule) => rule.scopeKey === page && rule.outcome === "FAIL")
          .map((rule) => rule.ruleId) ?? [];
      return audit && failures.length
        ? [
            {
              kind: "demand-and-audit",
              query: "",
              page,
              evidence: {
                snapshotId: current.id,
                startDate: current.startDate,
                endDate: current.endDate,
                status: current.status,
                impressions: row.impressions,
                clicks: row.clicks,
                auditId: audit.id,
                auditedAt: new Date(audit.createdAt).toISOString(),
                ruleIds: failures,
                algorithm: "exact-page-demand-audit-v1",
              },
              explanation:
                "This exact URL has at least 100 observed impressions and failing checks in its latest retained audit manifest. Inspect the captured findings, record a change and rerun the manifest. This correlation does not establish a ranking or traffic cause.",
            },
          ]
        : [];
    })
    .slice(0, 100);
}

function rows(snapshot: SearchSnapshot): SearchEvidenceRow[] {
  if (!Array.isArray(snapshot.rows)) return [];
  const seen = new Set<string>();
  return snapshot.rows
    .filter((value): value is SearchEvidenceRow => {
      if (
        !value ||
        !Array.isArray(value.keys) ||
        value.keys.length !== (snapshot.shape === "query,page" ? 2 : 1) ||
        !value.keys.every(
          (key: unknown) =>
            typeof key === "string" && key.length <= SEARCH_KEY_MAX_UNITS,
        ) ||
        !Number.isFinite(value.clicks) ||
        value.clicks < 0 ||
        !Number.isFinite(value.impressions) ||
        value.impressions < 0 ||
        (value.position !== null &&
          (!Number.isFinite(value.position) || value.position < 0))
      )
        return false;
      const key = JSON.stringify(value.keys);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => ({
      keys: row.keys,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.impressions ? row.clicks / row.impressions : null,
      position: row.impressions ? row.position : null,
    }));
}

/** Observed-data heuristics. Every item retains its source and processing limitations. */
export function buildSearchOpportunities(
  snapshots: readonly SearchSnapshot[],
): SearchOpportunity[] {
  const sorted = [...snapshots].sort((a, b) =>
    b.endDate.localeCompare(a.endDate),
  );
  const out: SearchOpportunity[] = [];
  const detailed = sorted.find((snapshot) => snapshot.shape === "query,page");
  const evidence = (
    snapshot: SearchSnapshot,
    extra: Record<string, unknown>,
  ) => ({
    snapshotId: snapshot.id,
    startDate: snapshot.startDate,
    endDate: snapshot.endDate,
    status: snapshot.status,
    algorithm: "observed-v1",
    limitations:
      "Available provider rows only; omitted searches and row limits prevent exhaustive coverage.",
    ...extra,
  });
  if (detailed) {
    const groups = new Map<string, SearchEvidenceRow[]>();
    for (const row of rows(detailed)) {
      if (row.keys.length !== 2 || !row.keys[0] || !row.keys[1]) continue;
      const group = groups.get(row.keys[0]) ?? [];
      group.push(row);
      groups.set(row.keys[0], group);
    }
    for (const [query, group] of groups) {
      // Select the best observed page BEFORE applying the opportunity band.
      const best = group
        .filter((row) => row.impressions > 0 && row.position !== null)
        .sort(
          (a, b) => a.position! - b.position! || b.impressions - a.impressions,
        )[0];
      if (
        best &&
        best.impressions >= 100 &&
        best.position! >= 5 &&
        best.position! <= 20
      )
        out.push({
          kind: "best-observed-page",
          query,
          page: best.keys[1]!,
          evidence: evidence(detailed, { ...best }),
          explanation:
            "The best observed page for this query ranks in positions 5–20 with at least 100 impressions. Inspect the page for a focused improvement.",
        });
      for (const row of group) {
        if (row.impressions >= 100 && row.ctr !== null && row.ctr < 0.02)
          out.push({
            kind: "low-observed-query-ctr",
            query,
            page: row.keys[1]!,
            evidence: evidence(detailed, {
              ...row,
              property: detailed.property ?? null,
              threshold: { minimumImpressions: 100, ctrBelow: 0.02 },
            }),
            explanation:
              "This observed query and page pair has at least 100 impressions and CTR below 2%. Review its title, intent and search-result context. These page-grouped counts do not represent the query's property-wide totals.",
          });
      }
      if (group.filter((row) => row.impressions > 0).length > 1)
        out.push({
          kind: "query-overlap",
          query,
          page: best?.keys[1] ?? group[0]!.keys[1]!,
          evidence: evidence(detailed, {
            pages: group.map((row) => row.keys[1]),
          }),
          explanation:
            "Multiple observed pages appeared for this query. Review their intent and ownership before deciding whether to consolidate.",
        });
    }
  }
  const current = sorted.find((snapshot) => snapshot.shape === "page");
  if (current) {
    const currentRows = rows(current);
    for (const row of currentRows)
      if (
        row.keys.length === 1 &&
        row.impressions >= 100 &&
        row.ctr !== null &&
        row.ctr < 0.02 &&
        row.position !== null &&
        row.position <= 10
      )
        out.push({
          kind: "low-observed-ctr",
          query: "",
          page: row.keys[0]!,
          evidence: evidence(current, {
            ...row,
            threshold: {
              minimumImpressions: 100,
              ctrBelow: 0.02,
              positionAtMost: 10,
            },
          }),
          explanation:
            "This page has at least 100 impressions, average position within ten and CTR below 2%. Review title, intent and search-result context.",
        });
    const prior = comparableSearchWindow(current, sorted);
    if (prior && current.status === "complete") {
      const previous = new Map(
        rows(prior)
          .filter((row) => row.keys.length === 1)
          .map((row) => [row.keys[0], row]),
      );
      for (const row of currentRows) {
        const before = previous.get(row.keys[0]);
        if (before && before.clicks >= 10 && row.clicks < before.clicks)
          out.push({
            kind: "declining-clicks",
            query: "",
            page: row.keys[0]!,
            evidence: evidence(current, {
              ...row,
              previousSnapshotId: prior.id,
              previousStartDate: prior.startDate,
              previousEndDate: prior.endDate,
              previousClicks: before.clicks,
              clickDelta: row.clicks - before.clicks,
            }),
            explanation:
              "Available clicks declined across equal-length, non-overlapping windows for this page. Inspect demand, seasonality and site changes before attributing a cause.",
          });
      }
    }
  }
  return balanceSearchOpportunities(out);
}

/** Bound the inbox while preserving representation for each opportunity kind. */
export function balanceSearchOpportunities(
  opportunities: readonly SearchOpportunity[],
): SearchOpportunity[] {
  const byKind = new Map<string, SearchOpportunity[]>();
  for (const item of opportunities) {
    const group = byKind.get(item.kind) ?? [];
    group.push(item);
    byKind.set(item.kind, group);
  }
  const result: SearchOpportunity[] = [];
  for (let offset = 0; result.length < 100; offset++) {
    let found = false;
    for (const group of byKind.values()) {
      const item = group[offset];
      if (!item) continue;
      found = true;
      result.push(item);
      if (result.length === 100) break;
    }
    if (!found) break;
  }
  return result;
}
