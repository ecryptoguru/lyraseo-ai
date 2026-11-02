import type { AuditComparison, AuditEvaluation, RuleResult } from "./types";

const issue = (rule: RuleResult) =>
  rule.outcome === "FAIL" || rule.outcome === "WARNING";
const rank = (rule: RuleResult) =>
  rule.outcome === "FAIL" ? 2 : rule.outcome === "WARNING" ? 1 : 0;

export function compareAudits(
  before: AuditEvaluation,
  after: AuditEvaluation,
): AuditComparison {
  const comparison: AuditComparison = {
    resolved: [],
    new: [],
    persistent: [],
    improved: [],
    worsened: [],
    unevaluated: [],
    scoreDelta: null,
  };
  const compatible = before.methodologyVersion === after.methodologyVersion;
  const previous = new Map(
    before.rules.map((rule) => [`${rule.ruleId}:${rule.scopeKey}`, rule]),
  );
  const current = new Map(
    after.rules.map((rule) => [`${rule.ruleId}:${rule.scopeKey}`, rule]),
  );
  for (const oldRule of before.rules) {
    if (!issue(oldRule)) continue;
    const currentRule = current.get(`${oldRule.ruleId}:${oldRule.scopeKey}`);
    if (
      !compatible ||
      !currentRule ||
      currentRule.outcome === "UNKNOWN" ||
      currentRule.outcome === "NOT_APPLICABLE"
    ) {
      comparison.unevaluated.push(oldRule);
      continue;
    }
    if (currentRule.outcome === "PASS") comparison.resolved.push(oldRule);
    else if (rank(currentRule) < rank(oldRule))
      comparison.improved.push(currentRule);
    else if (rank(currentRule) > rank(oldRule))
      comparison.worsened.push(currentRule);
    else comparison.persistent.push(currentRule);
  }
  for (const currentRule of after.rules) {
    if (!issue(currentRule)) continue;
    const oldRule = previous.get(
      `${currentRule.ruleId}:${currentRule.scopeKey}`,
    );
    if (!compatible) {
      if (!oldRule || !issue(oldRule)) comparison.unevaluated.push(currentRule);
      continue;
    }
    if (!oldRule || oldRule.outcome === "PASS")
      comparison.new.push(currentRule);
  }
  if (
    compatible &&
    before.score !== null &&
    after.score !== null &&
    before.manifest.length === after.manifest.length &&
    before.manifest.every((url, i) => url === after.manifest[i])
  ) {
    comparison.scoreDelta = after.score - before.score;
  }
  return comparison;
}
