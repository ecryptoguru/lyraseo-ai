import * as legacy from "./rules-v1";
import { decodeHTML } from "entities";
import { normalizeUrl } from "./url";
import { passiveUrl } from "./declarations";
import type {
  AuditEvidence,
  Category,
  EvidenceRef,
  MetadataSource,
  Outcome,
  PageEvidence,
  Priority,
  RuleResult,
} from "./types";

export const normalized = (s: string) =>
  decodeHTML(s).normalize("NFKC").replace(/\s+/gu, " ").trim();
const folded = (s: string) => normalized(s).toLowerCase();
const excerpt = (value: string) =>
  Array.from(normalized(value).replace(/[\u0000\uD800-\uDFFF]/gu, "�"))
    .slice(0, 512)
    .join("");
const metadataSources: MetadataSource[] = ["headers", "original", "rendered"];
const genericLinks = new Set(["click here", "here", "read more", "learn more"]);
const genericHeadings = new Set([
  "untitled",
  "heading",
  "section",
  "text",
  "lorem ipsum",
]);
const decide = (outcome: Outcome, reasonCode: string, evidence?: string) => ({
  outcome,
  reasonCode,
  evidence: evidence === undefined ? undefined : excerpt(evidence),
});
const unknown = (code: string) => decide("UNKNOWN", code);
const na = (code: string) => decide("NOT_APPLICABLE", code);
const catalogue: Record<string, [Category, Priority, string[], string[]?]> = {
  D01: ["discovery", "high", ["status", "contentType", "acquired", "finalUrl"]],
  D02: [
    "discovery",
    "high",
    metadataSources.flatMap((s) =>
      ["directives", "directivesComplete"].map(
        (f) => "metadata." + s + "." + f,
      ),
    ),
    ["indexingIntent"],
  ],
  D03: [
    "discovery",
    "medium",
    metadataSources.flatMap((s) =>
      ["canonicalUrls", "canonicalsComplete"].map(
        (f) => "metadata." + s + "." + f,
      ),
    ),
    ["intendedCanonical"],
  ],
  D04: [
    "discovery",
    "high",
    ["requestedRobotsGoogleAllowed", "robotsGoogleAllowed", "finalUrl"],
    ["indexingIntent"],
  ],
  E01: [
    "extractability",
    "high",
    ["bodyComplete", "mainText", "mainMediaNames"],
  ],
  E02: ["extractability", "medium", ["headComplete", "titleElements"]],
  E03: ["extractability", "medium", ["bodyComplete", "h1Texts"]],
  E04: [
    "extractability",
    "medium",
    ["bodyComplete", "linkNames", "detectedLanguage"],
  ],
  E05: ["extractability", "medium", ["jsonLdComplete", "jsonLd"]],
  A01: ["answer", "low", ["bodyComplete", "headingLevels"]],
  A02: [
    "answer",
    "low",
    ["bodyComplete", "headingLevels", "populatedSections"],
  ],
  A03: [
    "answer",
    "low",
    ["bodyComplete", "headingLevels", "headingTexts", "detectedLanguage"],
  ],
  A04: ["answer", "medium", ["articleDates", "byline"], ["pageType"]],
  T01: [
    "entity",
    "medium",
    ["bodyComplete", "visibleText", "logoNames"],
    ["brandName", "approvedAliases"],
  ],
  D05: ["discovery", "medium", ["bodyComplete", "linkNames"]],
  T02: [
    "entity",
    "low",
    ["bodyComplete", "detectedLanguage", "linkNames"],
    ["aboutUrl", "contactUrl"],
  ],
  T03: [
    "entity",
    "medium",
    ["jsonLdComplete", "jsonLd"],
    ["brandName", "approvedAliases", "officialUrls"],
  ],
  T04: ["entity", "low", ["bodyComplete", "linkNames"], ["requiredPolicyUrls"]],
};
const originRules = new Set(["D05", "T02", "T03", "T04"]);
const pageRules = Object.keys(catalogue).filter((id) => !originRules.has(id));
function make(
  id: string,
  scopeKey: string,
  pages: PageEvidence[],
  decision: ReturnType<typeof decide>,
): RuleResult {
  const [category, priority, fields, declarations] = catalogue[id]!;
  const evidenceRefs: EvidenceRef[] = pages.map((p) => ({
    source: "page",
    requestedUrl: normalizeUrl(p.requestedUrl),
    fields: [...fields],
  }));
  for (const page of pages)
    evidenceRefs.push({
      source: "receipt",
      requestedUrl: normalizeUrl(page.requestedUrl),
      fields:
        id === "D04"
          ? ["robotsPolicy"]
          : [
              "acquiredAt",
              "sha256",
              ...(id === "D01" ? ["redirects", "status", "finalUrl"] : []),
            ],
    });
  if (declarations)
    evidenceRefs.push({
      source: "declarations",
      fields: [...declarations],
      ...(["D02", "D03", "D04", "A04"].includes(id)
        ? { requestedUrl: scopeKey }
        : {}),
    });
  if (!pageRules.includes(id))
    evidenceRefs.push({ source: "manifest", fields: ["manifest"] });
  return {
    ruleId: id,
    ruleVersion: "2",
    category,
    priority,
    scopeKey,
    ...decision,
    evidenceRefs,
  };
}
const language = (p: PageEvidence) => {
  try {
    return p.detectedLanguage
      ? new Intl.Locale(p.detectedLanguage).language
      : undefined;
  } catch {
    return undefined;
  }
};
const names = (audit: AuditEvidence) =>
  [audit.brandName ?? "", ...(audit.approvedAliases ?? [])]
    .map(folded)
    .filter(Boolean);
const links = (p: PageEvidence) =>
  p.linkNames.flatMap((l) => {
    if (l.visible === false) return [];
    const href = passiveUrl(l.href, p.finalUrl ?? p.requestedUrl);
    return href ? [{ name: normalized(l.name), href }] : [];
  });
// Accessibility measures navigable names, including actions that do not
// identify an HTTP document. These URLs are never used for acquisition.
function navigationHref(value: string, base: string) {
  if (passiveUrl(value, base)) return new URL(value, base).href;
  if (
    !/^(mailto|tel):/i.test(value) ||
    value.length > 2048 ||
    /[\\\u0000-\u0020\u007f\uD800-\uDFFF]/u.test(value) ||
    /%(?![0-9a-f]{2})/i.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    if (url.host || url.hash) return null;
    if (url.protocol === "mailto:") {
      // A composer can omit recipients. If supplied, each recipient needs
      // a local part and a domain; percent escapes belong to the opaque path.
      const recipients = url.pathname ? url.pathname.split(",") : [];
      return recipients.every((raw) => {
        const address = decodeURIComponent(raw);
        const at = address.lastIndexOf("@");
        return (
          at > 0 &&
          at < address.length - 1 &&
          !/[\s@]/u.test(address.slice(at + 1)) &&
          !/[\u0000-\u001f\u007f]/u.test(address)
        );
      })
        ? url.href
        : null;
    }
    if (
      url.protocol === "tel:" &&
      !url.search &&
      /^\+?[0-9A-F*#().-]+(?:;[a-z0-9-]+(?:=[^;]+)?)*$/i.test(url.pathname) &&
      /[0-9]/.test(url.pathname.split(";")[0]!)
    )
      return url.href;
  } catch {
    /* malformed opaque target */
  }
  return null;
}
export const completeDirectives = (p: PageEvidence) =>
  metadataSources.every((s) => p.metadata?.[s]?.directivesComplete);
function indexing(p: PageEvidence) {
  if (p.indexingIntent === "excluded") return na("EXPLICITLY_EXCLUDED");
  const directives = metadataSources
    .flatMap((s) => p.metadata?.[s]?.directives ?? [])
    .filter((d) =>
      ["*", "robots", "googlebot"].includes(d.agent.toLowerCase()),
    );
  const tokens = directives
    .filter((d) => d.applicability !== "uncertain")
    .flatMap((d) =>
      d.value
        .toLowerCase()
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean),
    );
  const uncertain = directives.filter((d) => d.applicability === "uncertain");
  if (p.indexingIntent !== "indexable")
    return unknown("INDEXING_INTENT_UNDECLARED");
  if (tokens.some((t) => t === "noindex" || t === "none"))
    return decide("FAIL", "NOINDEX_ON_INTENDED_PAGE", tokens.join(", "));
  if (!completeDirectives(p)) return unknown("DIRECTIVE_SOURCE_UNAVAILABLE");
  if (uncertain.length) {
    const blocked = uncertain.find((d) =>
      /(?:^|[\s,])(noindex|none)(?:$|[\s,])/i.test(d.value),
    );
    if (blocked && tokens.some((t) => t === "index" || t === "all"))
      return decide(
        "WARNING",
        "DIRECTIVE_CONFLICT",
        tokens.join(", ") + " | " + blocked.value,
      );
    return unknown("DIRECTIVE_APPLICABILITY_UNCERTAIN");
  }
  if (
    tokens.some(
      (t) =>
        !/^(all|index|follow|nofollow|noarchive|nosnippet|notranslate|noimageindex|indexifembedded|nositelinkssearchbox|max-snippet:-?\d+|max-image-preview:(none|standard|large)|max-video-preview:-?\d+)$/.test(
          t,
        ),
    )
  )
    return unknown("UNSUPPORTED_DIRECTIVE");
  return decide(
    "PASS",
    "NO_NOINDEX",
    tokens.join(", ") || "No applicable directives",
  );
}
function canonical(p: PageEvidence) {
  if (!metadataSources.every((s) => p.metadata?.[s]?.canonicalsComplete))
    return unknown("CANONICAL_SOURCE_UNAVAILABLE");
  const raw = metadataSources.flatMap((s) => p.metadata![s]!.canonicalUrls);
  const values = raw.map((v) => passiveUrl(v, p.finalUrl ?? p.requestedUrl));
  if (values.some((v) => v === null))
    return decide("FAIL", "INVALID_CANONICAL", raw.join(", "));
  if (new Set(values).size > 1)
    return decide("FAIL", "CONFLICTING_CANONICALS", raw.join(", "));
  const actual = values[0];
  if (!actual) return decide("WARNING", "CANONICAL_MISSING", "No canonical");
  if (p.intendedCanonical && passiveUrl(p.intendedCanonical) !== actual)
    return decide("FAIL", "DECLARED_CANONICAL_MISMATCH", actual);
  // Original/rendered are snapshots of the same DOM. The same element
  // surviving rendering is one declaration; an independent HTTP Link adds one.
  const meta = p.metadata!;
  const count =
    meta.headers!.canonicalUrls.length +
    Math.max(
      meta.original!.canonicalUrls.length,
      meta.rendered!.canonicalUrls.length,
    );
  if (count > 1) return decide("WARNING", "DUPLICATE_CANONICAL", actual);
  if (p.intendedCanonical)
    return decide("PASS", "DECLARED_CANONICAL_MATCH", actual);
  return actual === passiveUrl(p.finalUrl ?? p.requestedUrl)
    ? decide("PASS", "SELF_CANONICAL", actual)
    : decide("WARNING", "CANONICAL_NEEDS_REVIEW", actual);
}
// Compare the written local calendar day; a timezone offset must not move a publisher's date.
function calendarDay(value?: string) {
  if (!value) return undefined;
  const match =
    /^(\d{4}-\d\d-\d\d)(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(
      value,
    );
  if (!match) return undefined;
  const day = match[1]!;
  const utc = new Date(day + "T00:00:00Z");
  return Number.isFinite(utc.valueOf()) &&
    utc.toISOString().startsWith(day + "T")
    ? day
    : undefined;
}
function article(p: PageEvidence) {
  if (!p.pageType) return unknown("PAGE_TYPE_UNDECLARED");
  if (p.pageType !== "article") return na("NOT_ARTICLE");
  if (!p.acquired || !p.articleDates?.visible || !p.articleDates.structured)
    return unknown("ARTICLE_SOURCES_UNAVAILABLE");
  const dates = [p.articleDates.visible, p.articleDates.structured];
  const pub = dates.map((d) => calendarDay(d.published)),
    mod = dates.map((d) => calendarDay(d.modified));
  const detail = dates
    .map((d) => [d.published, d.modified].filter(Boolean).join(" / "))
    .join(" | ");
  if (pub.some((day) => day && mod.some((m) => m && m < day)))
    return decide("FAIL", "DATE_ORDER_CONFLICT", detail);
  if ([pub, mod].some((days) => days[0] && days[1] && days[0] !== days[1]))
    return decide("FAIL", "DATE_CHANNEL_CONFLICT", detail);
  if (
    dates.some(
      (d) =>
        (d.published !== undefined && !calendarDay(d.published)) ||
        (d.modified !== undefined && !calendarDay(d.modified)),
    )
  )
    return decide("WARNING", "DATE_UNPARSEABLE", detail);
  if (!p.byline || !normalized(p.byline) || pub.every((day) => !day))
    return decide("WARNING", "ARTICLE_ATTRIBUTION_MISSING", detail);
  if (pub.some((day) => !day) || !!mod[0] !== !!mod[1])
    return decide("WARNING", "ARTICLE_SINGLE_DATE_CHANNEL", detail);
  return decide("PASS", "ARTICLE_ATTRIBUTION_PRESENT", detail);
}
function pageDecision(id: string, p: PageEvidence, a: AuditEvidence) {
  if (id === "D01") {
    if (p.status === undefined) return unknown("HTTP_UNAVAILABLE");
    if (p.status >= 400 && p.status <= 599)
      return decide("FAIL", "HTTP_ERROR", String(p.status));
    if (p.contentType && !/^text\/html(?:\s*;|$)/i.test(p.contentType))
      return na("NON_HTML");
    if (!p.acquired || !p.contentType) return unknown("BODY_UNAVAILABLE");
    if (p.status >= 300 && p.status <= 399)
      return decide("WARNING", "REDIRECT_UNRESOLVED", String(p.status));
    return p.status >= 200 && p.status <= 299
      ? decide("PASS", "HTML_ACQUIRED", String(p.status))
      : unknown("HTTP_UNAVAILABLE");
  }
  if (id === "D02") return indexing(p);
  if (id === "A04") return article(p);
  if (id === "D04") {
    if (p.indexingIntent === "excluded") return na("EXPLICITLY_EXCLUDED");
    if (p.robotsGoogleAllowed === undefined)
      return unknown("ROBOTS_UNAVAILABLE");
    if (!p.robotsGoogleAllowed && p.indexingIntent !== "indexable")
      return unknown("INDEXING_INTENT_UNDECLARED");
    return p.robotsGoogleAllowed
      ? decide("PASS", "GOOGLEBOT_ALLOWED", p.finalUrl ?? p.requestedUrl)
      : decide("WARNING", "GOOGLEBOT_DISALLOWED", p.finalUrl ?? p.requestedUrl);
  }
  if (!p.acquired) return unknown("PAGE_UNAVAILABLE");
  switch (id) {
    case "D03":
      return canonical(p);
    case "E01":
      if (!p.bodyComplete || p.mainText === undefined)
        return unknown("MAIN_UNAVAILABLE");
      if (/[\p{L}\p{N}]/u.test(normalized(p.mainText)))
        return decide("PASS", "MAIN_TEXT_PRESENT", p.mainText);
      if (!p.mainMediaNames) return unknown("MAIN_MEDIA_UNAVAILABLE");
      return p.mainMediaNames.some((n) => normalized(n))
        ? decide("WARNING", "MAIN_MEDIA_ONLY", p.mainMediaNames.join(", "))
        : decide("FAIL", "MAIN_EMPTY", "No main text or accessible media name");
    case "E02": {
      if (!p.headComplete) return unknown("HEAD_UNAVAILABLE");
      const titles = p.titleElements.map(normalized);
      if (!titles.length)
        return decide("FAIL", "MISSING_TITLE", "No title elements");
      if (titles.some((t) => !t))
        return decide("FAIL", "EMPTY_TITLE", "Empty title element");
      if (new Set(titles).size > 1)
        return decide("FAIL", "CONFLICTING_TITLES", titles.join(" | "));
      return titles.length > 1
        ? decide("WARNING", "DUPLICATE_TITLE", titles[0])
        : decide("PASS", "TITLE_PRESENT", titles[0]);
    }
    case "E03": {
      if (!p.bodyComplete) return unknown("BODY_UNAVAILABLE");
      const h1 = p.h1Texts.map(normalized).filter(Boolean);
      return h1.length === 1
        ? decide("PASS", "ONE_H1", h1[0])
        : h1.length
          ? decide("WARNING", "MULTIPLE_H1", h1.join(" | "))
          : decide("FAIL", "MISSING_H1", "No visible nonempty H1");
    }
    case "E04": {
      if (!p.bodyComplete) return unknown("BODY_UNAVAILABLE");
      const observed = p.linkNames.flatMap((link) => {
        if (link.visible === false) return [];
        const href = navigationHref(link.href, p.finalUrl ?? p.requestedUrl);
        return href ? [{ href, name: normalized(link.name) }] : [];
      });
      if (!observed.length) return na("NO_LINKS");
      const unnamed = observed.find((l) => !l.name);
      if (unnamed) return decide("FAIL", "UNNAMED_LINK", unnamed.href);
      const generic = observed.find((l) =>
        genericLinks.has(l.name.toLowerCase()),
      );
      if (generic && !language(p)) return unknown("LANGUAGE_UNCONFIRMED");
      return generic && language(p) === "en"
        ? decide("WARNING", "GENERIC_LINK", generic.name)
        : decide("PASS", "LINKS_NAMED", observed[0]!.name);
    }
    case "E05": {
      if (!p.jsonLdComplete) return unknown("JSON_LD_SOURCE_UNAVAILABLE");
      if (!p.jsonLd.length) return na("NO_JSON_LD");
      try {
        for (const block of p.jsonLd) JSON.parse(block);
      } catch {
        return decide("FAIL", "INVALID_JSON_LD", "Malformed JSON-LD");
      }
      return decide(
        "PASS",
        "JSON_LD_PARSES",
        String(p.jsonLd.length) + " valid blocks",
      );
    }
    case "A01":
      if (!p.bodyComplete) return unknown("BODY_UNAVAILABLE");
      if (p.headingLevels.length < 2) return na("FEW_HEADINGS");
      return p.headingLevels.some(
        (v, i) => i > 0 && v > p.headingLevels[i - 1]! + 1,
      )
        ? decide("WARNING", "HEADING_JUMP", p.headingLevels.join(", "))
        : decide("PASS", "HEADING_SEQUENCE", p.headingLevels.join(", "));
    case "A02":
      if (!p.bodyComplete) return unknown("BODY_UNAVAILABLE");
      if (!p.headingLevels.length) return na("NO_HEADINGS");
      if (p.populatedSections?.length !== p.headingLevels.length)
        return unknown("SECTIONS_UNAVAILABLE");
      // A parent section includes descendants until the next same/higher heading.
      const sections = [...p.populatedSections];
      const stack: number[] = [];
      for (let i = 0; i < sections.length; i++) {
        while (
          stack.length &&
          p.headingLevels[stack[stack.length - 1]!]! >= p.headingLevels[i]!
        )
          stack.pop();
        if (sections[i]) for (const parent of stack) sections[parent] = true;
        stack.push(i);
      }
      return sections.every(Boolean)
        ? decide("PASS", "SECTIONS_POPULATED", sections.join(", "))
        : decide("WARNING", "EMPTY_SECTION", sections.join(", "));
    case "A03": {
      if (!p.bodyComplete) return unknown("BODY_UNAVAILABLE");
      if (!p.headingLevels.length) return na("NO_HEADINGS");
      if (!language(p)) return unknown("LANGUAGE_UNCONFIRMED");
      if (language(p) !== "en") return na("NON_ENGLISH");
      if (
        p.headingTexts?.length !== p.headingLevels.length ||
        p.headingTexts.some((t) => !normalized(t))
      )
        return unknown("HEADINGS_UNAVAILABLE");
      const generic = p.headingTexts.find((t) =>
        genericHeadings.has(folded(t).replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "")),
      );
      return generic
        ? decide("WARNING", "GENERIC_HEADING", generic)
        : decide("PASS", "HEADING_NAMED", p.headingTexts[0]);
    }
    case "T01": {
      const identity = names(a);
      if (!identity.length) return unknown("BRAND_UNDECLARED");
      if (!p.bodyComplete || p.visibleText === undefined)
        return unknown("VISIBLE_TEXT_UNAVAILABLE");
      for (const n of identity) {
        const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const boundary = new RegExp(
          "(^|[^\\p{L}\\p{N}\\p{M}_])" +
            escaped +
            "(?=$|[^\\p{L}\\p{N}\\p{M}_])",
          "u",
        );
        if (
          [p.visibleText, ...(p.logoNames ?? [])].some((s) =>
            boundary.test(folded(s)),
          )
        )
          return decide("PASS", "BRAND_VISIBLE", n);
      }
      return p.logoNames
        ? decide("WARNING", "BRAND_NOT_OBSERVED", identity.join(", "))
        : unknown("LOGO_NAMES_UNAVAILABLE");
    }
    default:
      throw new Error("Unknown rule " + id);
  }
}
export function evaluatePageRules(page: PageEvidence, audit: AuditEvidence) {
  if (audit.methodologyVersion === "readiness-v1")
    return legacy.evaluatePageRules(page, audit);
  return pageRules.map((id) =>
    make(
      id,
      normalizeUrl(page.requestedUrl),
      [page],
      pageDecision(id, page, audit),
    ),
  );
}
function organizations(a: AuditEvidence) {
  const identity = names(a);
  if (!identity.length) return unknown("BRAND_UNDECLARED");
  if (a.pages.some((p) => !p.acquired || !p.jsonLdComplete))
    return unknown("JSON_LD_SOURCE_UNAVAILABLE");
  const allowed = new Set([
    passiveUrl(a.siteOrigin),
    ...(a.officialUrls ?? []).map((url) => passiveUrl(url)),
  ]);
  let compared = 0,
    conflict: string | undefined;
  for (const p of a.pages)
    for (const block of p.jsonLd) {
      let root: unknown;
      try {
        root = JSON.parse(block);
      } catch {
        return unknown("INVALID_JSON_LD");
      }
      const stack: unknown[] = [root];
      while (stack.length) {
        const item = stack.pop();
        if (!item || typeof item !== "object") continue;
        if (Array.isArray(item)) {
          for (const element of item) stack.push(element);
          continue;
        }
        const record = item as Record<string, unknown>;
        for (const value of Object.values(record))
          if (value && typeof value === "object") stack.push(value);
        const types = Array.isArray(record["@type"])
          ? record["@type"]
          : [record["@type"]];
        if (
          !types.some(
            (t) =>
              typeof t === "string" &&
              /^(?:https?:\/\/schema\.org\/)?Organization$/.test(t),
          )
        )
          continue;
        for (const field of ["name", "url"]) {
          const value = record[field];
          for (const raw of Array.isArray(value) ? value : [value]) {
            if (typeof raw !== "string" || !normalized(raw)) continue;
            compared++;
            if (
              field === "name"
                ? !identity.includes(folded(raw))
                : !allowed.has(passiveUrl(raw))
            )
              conflict ??= raw;
          }
        }
      }
    }
  if (conflict !== undefined)
    return decide("WARNING", "ORGANIZATION_CONFLICT", conflict);
  return compared
    ? decide(
        "PASS",
        "ORGANIZATION_MATCH",
        String(compared) + " matching fields",
      )
    : na("NO_IDENTITY_FIELDS");
}
export function evaluateOriginRules(a: AuditEvidence) {
  if (a.methodologyVersion === "readiness-v1")
    return legacy.evaluateOriginRules(a);
  const home = normalizeUrl(a.siteOrigin),
    origin = new URL(home).origin;
  const homepage = a.pages.find((p) => normalizeUrl(p.requestedUrl) === home);
  const homePages = homepage ? [homepage] : [];
  const visible = homepage?.acquired && homepage.bodyComplete;
  const homeLinks = visible
    ? links(homepage).filter((l) => new URL(l.href).origin === origin)
    : [];
  const selected = a.manifest.filter((url) => url !== home);
  const sampled = () => {
    if (!selected.length) return na("SINGLE_PAGE");
    if (a.pages.some((p) => !p.acquired || !p.bodyComplete))
      return unknown("INCOMPLETE_MANIFEST");
    const missing = selected.find(
      (url) =>
        !a.pages.some(
          (p) =>
            normalizeUrl(p.requestedUrl) !== url &&
            passiveUrl(p.finalUrl ?? p.requestedUrl) !== url &&
            links(p).some((l) => l.href === url),
        ),
    );
    return missing
      ? decide("WARNING", "SAMPLED_LINK_MISSING", missing)
      : decide("PASS", "SAMPLED_LINKS_PRESENT", selected.join(", "));
  };
  const contact = () => {
    if (!visible) return unknown("HOMEPAGE_UNAVAILABLE");
    const urls = [a.aboutUrl, a.contactUrl]
      .filter((url): url is string => !!url)
      .map((url) => passiveUrl(url));
    const lang = language(homepage);
    const found = homeLinks.find(
      (l) =>
        urls.includes(l.href) ||
        (lang === "en" &&
          /(^|[^\p{L}\p{N}\p{M}_])(about|contact)(?=$|[^\p{L}\p{N}\p{M}_])/iu.test(
            l.name,
          )),
    );
    if (found) return decide("PASS", "CONTACT_LINK_OBSERVED", found.href);
    if (!urls.length && !lang) return unknown("LANGUAGE_UNCONFIRMED");
    if (!urls.length && lang !== "en") return na("NON_ENGLISH");
    return decide(
      "WARNING",
      "CONTACT_LINK_NOT_OBSERVED",
      urls.join(", ") || "No matching visible homepage link",
    );
  };
  const policies = () => {
    if (!a.requiredPolicyUrls?.length)
      return na("NO_DECLARED_POLICY_REQUIREMENT");
    if (!visible) return unknown("HOMEPAGE_UNAVAILABLE");
    const missing = a.requiredPolicyUrls.find(
      (url) => !homeLinks.some((l) => l.href === passiveUrl(url)),
    );
    return missing
      ? decide("WARNING", "POLICY_LINK_MISSING", missing)
      : decide("PASS", "POLICY_LINKS_PRESENT", a.requiredPolicyUrls.join(", "));
  };
  return [
    make("D05", origin, a.pages, sampled()),
    make("T02", origin, homePages, contact()),
    make("T03", origin, a.pages, organizations(a)),
    make("T04", origin, homePages, policies()),
  ];
}
