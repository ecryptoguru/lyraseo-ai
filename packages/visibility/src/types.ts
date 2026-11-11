export type Outcome =
  "PASS" | "WARNING" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";
export type Priority = "high" | "medium" | "low";
export type Category = "discovery" | "extractability" | "answer" | "entity";

export type Methodology = "readiness-v1" | "readiness-v2";
export type PageType = "marketing" | "article" | "product" | "other";
export type IndexingIntent = "indexable" | "excluded";
export interface PageDeclaration {
  requestedUrl: string;
  indexingIntent?: IndexingIntent;
  pageType?: PageType;
  intendedCanonical?: string;
}
export interface ReadinessDeclarations {
  brandName?: string;
  approvedAliases?: string[];
  officialUrls?: string[];
  aboutUrl?: string;
  contactUrl?: string;
  requiredPolicyUrls?: string[];
  pageDeclarations?: PageDeclaration[];
}
export type MetadataSource = "headers" | "original" | "rendered";
export interface MetadataEvidence {
  directivesComplete: boolean;
  canonicalsComplete: boolean;
  directives: Array<{
    agent: string;
    value: string;
    applicability?: "uncertain";
  }>;
  canonicalUrls: string[];
}
export interface DateEvidence {
  published?: string;
  modified?: string;
}
export interface GoogleRobotsGroup {
  agent: "googlebot" | "*";
  rules: Array<{ directive: "allow" | "disallow"; pattern: string }>;
}
export interface RobotsPolicyObservation {
  requestedUrl: string;
  finalUrl?: string;
  acquiredAt: string;
  status?: number;
  state:
    | "available"
    | "no-file"
    | "unavailable"
    | "indeterminate"
    | "evidence-limited";
  sha256?: string;
  /** Complete effective Google group, merged as the parser sees it. Null means no matching group. */
  googleGroup?: GoogleRobotsGroup | null;
  requested?: { url: string; allowed?: boolean };
  final?: { url: string; allowed?: boolean };
}
export interface PageEvidence {
  metadata?: Partial<Record<MetadataSource, MetadataEvidence>>;
  jsonLdComplete?: boolean;
  mainMediaNames?: string[];
  logoNames?: string[];
  /** Missing channel = unobserved. An empty channel = inspected, no date found. */
  articleDates?: Partial<Record<"visible" | "structured", DateEvidence>>;
  requestedRobotsGoogleAllowed?: boolean;
  indexingIntent?: IndexingIntent;
  requestedUrl: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  acquired: boolean;
  /** Complete evidence distinguishes a missing element from an unreadable document. */
  headComplete: boolean;
  bodyComplete: boolean;
  titleElements: string[];
  /** Complete rendered, visible, nonempty content headings in DOM order (excludes navigation/footer). */
  headingLevels: number[];
  h1Texts: string[];
  headingTexts?: string[];
  mainText?: string;
  canonicalUrls: string[];
  intendedCanonical?: string;
  explicitNoindex?: boolean;
  intentionallyExcluded?: boolean;
  robotsGoogleAllowed?: boolean;
  linkNames: Array<{ name: string; href: string; visible?: boolean }>;
  jsonLd: string[];
  pageType?: "marketing" | "article" | "product" | "other";
  publishedDate?: string;
  modifiedDate?: string;
  byline?: string;
  visibleText?: string;
  /** Aligned with headingLevels, including subordinate populated sections. */
  populatedSections?: boolean[];
  detectedLanguage?: string;
}

export interface AuditEvidence extends ReadinessDeclarations {
  profile?: string;
  contextRevisionId?: string;
  contextRevision?: number;
  siteOrigin: string;
  brandName?: string;
  approvedAliases?: string[];
  pages: PageEvidence[];
  /** Frozen user-confirmed page selection. The homepage must be included. */
  manifest: string[];
  methodologyVersion: Methodology;
}

export interface EvidenceRef {
  source: "page" | "receipt" | "declarations" | "manifest";
  requestedUrl?: string;
  fields: string[];
}
export interface RuleResult {
  /** Added in v2. Undefined on immutable legacy output. */
  ruleVersion?: string;
  evidenceRefs?: EvidenceRef[];
  ruleId: string;
  scopeKey: string;
  category: Category;
  outcome: Outcome;
  priority: Priority;
  reasonCode: string;
  evidence?: string;
}

export interface AuditEvaluation {
  profile?: string;
  declarations?: ReadinessDeclarations;
  contextRevisionId?: string;
  contextRevision?: number;
  categoryCoverage?: Record<Category, number | null>;
  duplicateDestinations?: Array<{ finalUrl: string; requestedUrls: string[] }>;
  score: number | null;
  coverage: number;
  categoryScores: Record<Category, number | null>;
  rules: RuleResult[];
  manifest: string[];
  methodologyVersion: Methodology;
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
