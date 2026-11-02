import { computePresence, computeShareOfVoice } from "./metrics";
export const EXTRACTION_VERSION = "unicode-phrase-v1";
export const VISIBILITY_PROFILES = [
  "azure-sol-api",
  "consumer-chatgpt",
  "consumer-gemini",
] as const;
export type VisibilityProfile = (typeof VISIBILITY_PROFILES)[number];
export type Brand = {
  id: string;
  name: string;
  aliases: string[];
  domains: string[];
};
export type Prompt = { id: string; text: string; label: "neutral" | "branded" };
export type Annotation = { url: string; start: number; end: number };
export type Extraction = {
  mention: boolean | null;
  citation: boolean | null;
  recommendation: boolean | null;
  reason: string | null;
};
export type Answer = {
  promptId: string;
  state: "successful" | "failed" | "unsupported" | "no-answer" | "ambiguous";
  extraction: Record<string, Extraction>;
};
const normalize = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ");
const phrase = (body: string, alias: string) => {
  const escaped = normalize(alias).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
    "u",
  ).test(normalize(body));
};
export function matchesDomain(url: string, domain: string) {
  try {
    const u = new URL(url);
    const d = new URL(`https://${domain}`).hostname.toLowerCase();
    return (
      ["http:", "https:"].includes(u.protocol) &&
      (u.hostname === d || u.hostname.endsWith(`.${d}`))
    );
  } catch {
    return false;
  }
}
export function validatePanel(
  prompts: readonly Prompt[],
  brands: readonly Brand[],
) {
  if (
    !prompts.length ||
    prompts.length > 25 ||
    new Set(prompts.map((p) => p.id)).size !== prompts.length ||
    prompts.some(
      (p) =>
        !p.id ||
        p.id.length > 80 ||
        !p.text.trim() ||
        p.text.length > 4000 ||
        !["neutral", "branded"].includes(p.label),
    )
  )
    throw new Error("INVALID_PROMPT_PANEL");
  if (
    !brands.length ||
    brands.length > 10 ||
    new Set(brands.map((b) => b.id)).size !== brands.length ||
    brands.some(
      (b) =>
        !b.id ||
        !b.name.trim() ||
        !b.aliases.length ||
        b.aliases.length > 20 ||
        b.aliases.some((a) => !a.trim() || a.length > 150) ||
        b.domains.length > 20 ||
        b.domains.some((d) => {
          try {
            const u = new URL(`https://${d}`);
            return (
              u.host !== d ||
              u.pathname !== "/" ||
              !!u.search ||
              !!u.hash ||
              !!u.username
            );
          } catch {
            return true;
          }
        }),
    )
  )
    throw new Error("INVALID_BRAND_PANEL");
}
/** Body excludes provider source lists. Only in-answer URL annotations establish citations. */
export function extractBrands(
  body: string,
  annotations: readonly Annotation[],
  brands: readonly Brand[],
): Record<string, Extraction> {
  return Object.fromEntries(
    brands.map((b) => {
      const hit = b.aliases.filter((a) => phrase(body, a));
      const ambiguous = hit.some((a) =>
        brands.some(
          (other) =>
            other.id !== b.id &&
            other.aliases.some(
              (x) => phrase(body, x) && (phrase(x, a) || phrase(a, x)),
            ),
        ),
      );
      const domainMention = (
        body.match(/https?:\/\/[^\s<>"\])]+/gu) ?? []
      ).some((url) => b.domains.some((d) => matchesDomain(url, d)));
      const citation = annotations.some(
        (a) =>
          Number.isInteger(a.start) &&
          Number.isInteger(a.end) &&
          a.start >= 0 &&
          a.end > a.start &&
          a.end <= body.length &&
          b.domains.some((d) => matchesDomain(a.url, d)),
      );
      return [
        b.id,
        {
          mention: ambiguous ? null : hit.length > 0 || domainMention,
          citation,
          recommendation: hit.length || domainMention ? null : false,
          reason: ambiguous
            ? "Shared alias requires review"
            : hit.length
              ? "Recommendation requires evidence-based adjudication"
              : null,
        },
      ];
    }),
  );
}
export function summarizeAnswers(
  answers: readonly Answer[],
  brands: readonly string[],
) {
  const valid = answers.filter(
      (a) => a.state === "successful" || a.state === "ambiguous",
    ),
    unavailable = answers.length - valid.length;
  return {
    valid: valid.length,
    unavailable,
    states: Object.fromEntries(
      ["successful", "failed", "unsupported", "no-answer", "ambiguous"].map(
        (s) => [s, answers.filter((a) => a.state === s).length],
      ),
    ),
    brands: Object.fromEntries(
      brands.map((b) => [
        b,
        Object.fromEntries(
          (["mention", "citation", "recommendation"] as const).map((m) => [
            m,
            (() => {
              const pooled = computePresence(
                valid.map((a) => a.extraction[b]?.[m] ?? null),
                unavailable,
              );
              const promptRates = [...new Set(valid.map((a) => a.promptId))]
                .map(
                  (p) =>
                    computePresence(
                      valid
                        .filter((a) => a.promptId === p)
                        .map((a) => a.extraction[b]?.[m] ?? null),
                      0,
                    ).rate,
                )
                .filter((rate): rate is number => rate !== null);
              return {
                ...pooled,
                rate: promptRates.length
                  ? promptRates.reduce((sum, rate) => sum + rate, 0) /
                    promptRates.length
                  : null,
                pooledRate: pooled.rate,
                weighting: "equal-prompt",
                eligiblePrompts: promptRates.length,
                observedPrompts: new Set(answers.map((a) => a.promptId)).size,
              };
            })(),
          ]),
        ),
      ]),
    ),
    shareOfVoice: computeShareOfVoice(
      valid.map((a) =>
        Object.fromEntries(
          brands.map((b) => [b, a.extraction[b]?.mention ?? null]),
        ),
      ),
      brands,
    ),
  };
}
export type MeasurementWindow = {
  cohort: string;
  start: string;
  end: string;
  planned: number;
  answers: readonly Answer[];
};
export function compareWindows(
  before: MeasurementWindow,
  after: MeasurementWindow,
  brand: string,
  metric: "mention" | "citation" | "recommendation" = "mention",
) {
  const rows = (w: MeasurementWindow) =>
    w.answers.filter(
      (a) =>
        ["successful", "ambiguous"].includes(a.state) &&
        typeof a.extraction[brand]?.[metric] === "boolean",
    );
  const a = rows(before),
    b = rows(after),
    common = [...new Set(a.map((x) => x.promptId))].filter((p) =>
      b.some((x) => x.promptId === p),
    );
  const coverage = (w: MeasurementWindow) =>
    w.planned > 0
      ? w.answers.filter((a) => ["successful", "ambiguous"].includes(a.state))
          .length / w.planned
      : 0;
  const duration = (w: MeasurementWindow) =>
    Date.parse(w.end) - Date.parse(w.start);
  if (
    before.cohort !== after.cohort ||
    !Number.isFinite(duration(before)) ||
    duration(before) <= 0 ||
    duration(before) !== duration(after) ||
    before.planned < before.answers.length ||
    after.planned < after.answers.length ||
    common.length < 10 ||
    coverage(before) < 0.8 ||
    coverage(after) < 0.8
  )
    return {
      eligible: false as const,
      reason: "Insufficient comparable evidence",
      commonPrompts: common.length,
    };
  const measure = (rows: Answer[]) => {
    const filtered = rows.filter((x) => common.includes(x.promptId));
    const pooled = computePresence(
      filtered.map((x) => x.extraction[brand]![metric]),
      0,
    );
    const rate =
      common.reduce((sum, p) => {
        const subset = filtered.filter((x) => x.promptId === p);
        return (
          sum +
          subset.filter((x) => x.extraction[brand]![metric] === true).length /
            subset.length
        );
      }, 0) / common.length;
    return { rate, pooled };
  };
  const previous = measure(a),
    current = measure(b);
  return {
    eligible: true as const,
    commonPrompts: common.length,
    previous,
    current,
    percentagePointChange: 100 * (current.rate - previous.rate),
    weighting: "equal-prompt",
  };
}
