import type { AuditComparison, AuditEvaluation, RuleResult } from "./types";
import { normalized } from "./rules";
import { passiveUrl } from "./declarations";

const issue = (r: RuleResult) =>
  r.outcome === "FAIL" || r.outcome === "WARNING";
const unknown = (r: RuleResult) =>
  r.outcome === "UNKNOWN" || r.outcome === "NOT_APPLICABLE";
const key = (r: RuleResult) => JSON.stringify([r.ruleId, r.scopeKey]);
const sorted = (list: string[]) => [...new Set(list)].sort();
const urls = (list?: string[]) =>
  sorted((list ?? []).map((url) => passiveUrl(url) ?? url));
function basis(a: AuditEvaluation, r: RuleResult) {
  const d = a.declarations ?? {},
    page = d.pageDeclarations?.find((p) => p.requestedUrl === r.scopeKey);
  const identity = sorted(
    [d.brandName ?? "", ...(d.approvedAliases ?? [])]
      .map((s) => normalized(s).toLowerCase())
      .filter(Boolean),
  );
  switch (r.ruleId) {
    case "D02":
    case "D04":
      return page?.indexingIntent;
    case "D03":
      return page?.intendedCanonical && passiveUrl(page.intendedCanonical);
    case "A04":
      return page?.pageType;
    case "T01":
      return identity;
    case "T02":
      return urls([d.aboutUrl, d.contactUrl].filter((s): s is string => !!s));
    case "T03":
      return [sorted(a.manifest), identity, urls(d.officialUrls)];
    case "D05":
      return sorted(a.manifest);
    case "T04":
      return urls(d.requiredPolicyUrls);
    default:
      return null;
  }
}
export function compareAudits(
  before: AuditEvaluation,
  after: AuditEvaluation,
): AuditComparison {
  const result: AuditComparison = {
    resolved: [],
    new: [],
    persistent: [],
    improved: [],
    worsened: [],
    unevaluated: [],
    scoreDelta: null,
  };
  const profileOk =
    before.profile === after.profile &&
    (before.methodologyVersion === "readiness-v1" || !!before.profile);
  const compatible =
    before.methodologyVersion === after.methodologyVersion && profileOk;
  const previous = new Map(before.rules.map((r) => [key(r), r])),
    current = new Map(after.rules.map((r) => [key(r), r]));
  let headline =
    compatible &&
    JSON.stringify(sorted(before.manifest)) ===
      JSON.stringify(sorted(after.manifest));
  for (const k of new Set([...previous.keys(), ...current.keys()])) {
    const old = previous.get(k),
      now = current.get(k);
    if (
      !compatible ||
      !old ||
      !now ||
      old.ruleVersion !== now.ruleVersion ||
      (!old.ruleVersion && before.methodologyVersion !== "readiness-v1") ||
      JSON.stringify(basis(before, old)) !== JSON.stringify(basis(after, now))
    ) {
      result.unevaluated.push(now ?? old!);
      headline = false;
      continue;
    }
    if (unknown(old) || unknown(now)) result.unevaluated.push(now);
    else if (issue(old) && now.outcome === "PASS") result.resolved.push(old);
    else if (old.outcome === "PASS" && issue(now)) result.new.push(now);
    else if (issue(old) && issue(now)) {
      if (old.outcome === now.outcome) result.persistent.push(now);
      else if (now.outcome === "FAIL") result.worsened.push(now);
      else result.improved.push(now);
    }
  }
  if (headline && before.score !== null && after.score !== null)
    result.scoreDelta = after.score - before.score;
  return result;
}
