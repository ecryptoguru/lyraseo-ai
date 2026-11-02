export type Outcome =
  "PASS" | "WARNING" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";
export type Priority = "high" | "medium" | "low";
export type Category = "discovery" | "extractability" | "answer" | "entity";

export interface PageEvidence {
  requestedUrl: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  acquired: boolean;
  /** Complete evidence distinguishes a missing element from an unreadable document. */
  headComplete: boolean;
  bodyComplete: boolean;
  titleElements: string[];
  headingLevels: number[];
  h1Texts: string[];
  headingTexts?: string[];
  mainText?: string;
  canonicalUrls: string[];
  intendedCanonical?: string;
  explicitNoindex?: boolean;
  intentionallyExcluded?: boolean;
  robotsGoogleAllowed?: boolean;
  linkNames: Array<{ name: string; href: string }>;
  jsonLd: string[];
  pageType?: "marketing" | "article" | "product" | "other";
  publishedDate?: string;
  modifiedDate?: string;
  byline?: string;
  visibleText?: string;
  populatedSections?: boolean[];
  detectedLanguage?: string;
}

export interface AuditEvidence {
  siteOrigin: string;
  brandName?: string;
  approvedAliases?: string[];
  pages: PageEvidence[];
  /** Frozen user-confirmed page selection. The homepage must be included. */
  manifest: string[];
  methodologyVersion: "readiness-v1";
}

export interface RuleResult {
  ruleId: string;
  scopeKey: string;
  category: Category;
  outcome: Outcome;
  priority: Priority;
  reasonCode: string;
  evidence?: string;
}

export interface AuditEvaluation {
  score: number | null;
  coverage: number;
  categoryScores: Record<Category, number | null>;
  rules: RuleResult[];
  manifest: string[];
  methodologyVersion: "readiness-v1";
  eligible: boolean;
}

export interface AuditComparison {
  resolved: RuleResult[];
  new: RuleResult[];
  persistent: RuleResult[];
  improved: RuleResult[];
  worsened: RuleResult[];
  unevaluated: RuleResult[];
  scoreDelta: number | null;
}
